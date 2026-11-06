import contextlib
import json
import resource
import socket
import sys
import threading
import time

sys.path.insert(0, "/opt/plb")
import plumbline_sdk  # noqa: E402

# AG4-SBX-3: exactly one TCP endpoint (the relay) and one Unix path (the U-4 fallback) are "the broker".
# Peers, the bridge gateway and the rest of the subnet are external attempts like any other address.
# These constants are checked against packages/sandbox/src/limits.ts by a unit test.
RELAY_ENDPOINT = ("172.28.0.2", 8080)
BROKER_SOCKET = "/run/plb/broker.sock"

# AG4-SBX-2: this list lives in the same interpreter as the untrusted code, so the runner treats it as a display-only,
# untrusted self-report. The authoritative facts (exit code, OOM, timeout, removal) are read by the host from docker.
ATTEMPTS = []


def _is_broker(address):
    if isinstance(address, (tuple, list)) and len(address) >= 2:
        return (address[0], address[1]) == RELAY_ENDPOINT
    return address == BROKER_SOCKET


def _audit(event, args):
    if event != "socket.connect":
        return
    try:
        address = args[1]
        entry = {"addr": repr(address)[:80], "completed": False, "broker": _is_broker(address), "tid": threading.get_ident(), "ts": time.time()}
    except Exception:
        entry = {"addr": "?", "completed": False, "broker": False, "tid": threading.get_ident(), "ts": time.time()}
    ATTEMPTS.append(entry)


def _mark_completed():
    tid = threading.get_ident()
    for entry in reversed(ATTEMPTS):
        if entry["tid"] == tid and not entry["completed"]:
            entry["completed"] = True
            return


sys.addaudithook(_audit)
_orig_connect = socket.socket.connect
_orig_connect_ex = socket.socket.connect_ex


def _connect(self, address):
    result = _orig_connect(self, address)
    _mark_completed()
    return result


def _connect_ex(self, address):
    code = _orig_connect_ex(self, address)
    if code == 0:
        _mark_completed()
    return code


socket.socket.connect = _connect
socket.socket.connect_ex = _connect_ex


def _limits():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))


def _summary(error):
    external = [a for a in ATTEMPTS if not a["broker"]]
    return {"ok": error is None, "error": error, "attempts": [{"addr": a["addr"], "completed": a["completed"]} for a in external]}


def main():
    _limits()
    job = json.loads(sys.stdin.read())
    plumbline_sdk.configure(job["token"])
    sys.modules["vultr"] = plumbline_sdk
    namespace = {"__name__": "__main__", "vultr": plumbline_sdk}
    error = None
    try:
        exec(compile(job["code"], "operator.py", "exec"), namespace)
    except BaseException as exc:  # the operator code is untrusted; report, never crash the harness
        error = "%s: %s" % (type(exc).__name__, str(exc)[:300])
        print("ERROR " + error)
    sys.stdout.flush()
    sys.stdout.write("\nPLB_RESULT:" + json.dumps(_summary(error)))
    sys.stdout.flush()


if __name__ == "__main__":
    with contextlib.suppress(BrokenPipeError):
        main()

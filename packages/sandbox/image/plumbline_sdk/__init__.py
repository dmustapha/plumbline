import http.client as _httpc
import json
import os
import socket

# The relay has a fixed address on the sandbox network (limits.ts GATE_IP/GATE_PORT; a unit test keeps them equal).
# An IP literal means this module never needs DNS.
_GATE_HOST = "172.28.0.2"
_GATE_PORT = 8080
_SOCKET_PATH = "/run/plb/broker.sock"
_TIMEOUT_S = 20
_MAX_RESPONSE = 256 * 1024
_token = None


class PlumblineError(Exception):
    pass


class PolicyDenied(PlumblineError):
    def __init__(self, body):
        d = body.get("decision", {})
        self.decision = d.get("decision")
        self.rule_id = d.get("rule_id")
        self.layer = d.get("layer")
        self.reason = d.get("reason")
        self.decision_id = d.get("decision_id")
        super().__init__("%s %s (%s): %s" % (self.decision, self.rule_id, self.layer, self.reason))


class EscalationRequired(PolicyDenied):
    pass


class ArgsInvalid(PlumblineError):
    pass


class AuthError(PlumblineError):
    pass


class RateLimited(PlumblineError):
    pass


class PayloadTooLarge(PlumblineError):
    pass


class BrokerUnavailable(PlumblineError):
    """The broker or relay answered with a 5xx or another non-2xx status."""


class BrokerUnreachable(PlumblineError):
    """No answer at all: refused, reset, timed out."""


class BrokerProtocolError(PlumblineError):
    """A 2xx answer that is not the documented JSON envelope."""


class _UnixConnection(_httpc.HTTPConnection):
    def __init__(self):
        super().__init__("localhost", timeout=_TIMEOUT_S)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(_TIMEOUT_S)
        self.sock.connect(_SOCKET_PATH)


def configure(token):
    global _token
    _token = token


def _connection():
    if os.path.exists(_SOCKET_PATH):
        return _UnixConnection()
    return _httpc.HTTPConnection(_GATE_HOST, _GATE_PORT, timeout=_TIMEOUT_S)


def _post(body):
    """One round trip. Returns (status, raw bytes). Transport failures become BrokerUnreachable."""
    conn = _connection()
    try:
        conn.request("POST", "/v1/call", json.dumps(body), {"content-type": "application/json", "authorization": "Bearer " + _token})
        resp = conn.getresponse()
        return resp.status, resp.read(_MAX_RESPONSE + 1)
    except (OSError, _httpc.HTTPException) as exc:
        raise BrokerUnreachable("%s: %s" % (type(exc).__name__, exc))
    finally:
        conn.close()


def _json(raw, what):
    if len(raw) > _MAX_RESPONSE:
        raise BrokerProtocolError("%s: response larger than %d bytes" % (what, _MAX_RESPONSE))
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise BrokerProtocolError("%s: body is not JSON" % what)
    if not isinstance(data, dict):
        raise BrokerProtocolError("%s: body is not a JSON object" % what)
    return data


def _raise_for_status(status, raw):
    """AG4-SBX-6: every non-2xx maps to a typed error; nothing falls through to a None result."""
    if 200 <= status < 300:
        return
    if status == 401:
        raise AuthError("AUTH_TASK_TOKEN_INVALID")
    if status == 400:
        try:
            errors = _json(raw, "400").get("errors") or ["ARGS_INVALID"]
        except BrokerProtocolError:
            errors = ["ARGS_INVALID"]
        raise ArgsInvalid("; ".join(str(e) for e in errors))
    if status == 413:
        raise PayloadTooLarge("PAYLOAD_TOO_LARGE")
    if status == 429:
        raise RateLimited("RATE_LIMITED")
    raise BrokerUnavailable("HTTP %d" % status)


def _call(verb, cls, target_id=None, **params):
    if not _token:
        raise AuthError("no task token")
    body = {"verb": verb, "class": cls, "target": {"id": target_id} if target_id else {}, "params": params}
    status, raw = _post(body)
    _raise_for_status(status, raw)
    data = _json(raw, "call")
    decision_obj = data.get("decision")
    decision = decision_obj.get("decision") if isinstance(decision_obj, dict) else None
    if decision == "DENY":
        raise PolicyDenied(data)
    if decision == "ESCALATE":
        raise EscalationRequired(data)
    if decision != "ALLOW":
        raise BrokerProtocolError("call: missing or unknown decision")
    if data.get("error"):
        err = data["error"] if isinstance(data["error"], dict) else {}
        raise PlumblineError("%s: %s" % (err.get("code"), err.get("message")))
    return data.get("result")


class _Instances:
    def list(self):
        return _call("list", "instance")

    def create(self, plan, region, label=None, ttl_h=1):
        extra = {"label": label} if label else {}
        return _call("create", "instance", None, plan=plan, region=region, ttl_h=ttl_h, **extra)

    def delete(self, instance_id):
        return _call("delete", "instance", instance_id)


class _Firewalls:
    def list(self):
        return _call("list", "firewall_group")

    def create(self, label):
        return _call("create", "firewall_group", None, label=label)

    def delete(self, firewall_id):
        return _call("delete", "firewall_group", firewall_id)

    def add_rule(self, firewall_id, port="22", notes="plumbline"):
        return _call("update", "firewall_group", firewall_id, port=port, notes=notes)


class _Vpcs:
    def list(self):
        return _call("list", "vpc")

    def create(self, region, subnet, subnet_size, label=None):
        extra = {"label": label} if label else {}
        return _call("create", "vpc", None, region=region, subnet=subnet, subnet_size=subnet_size, **extra)

    def delete(self, vpc_id):
        return _call("delete", "vpc", vpc_id)


class _Registries:
    def list(self):
        return _call("list", "registry")

    def create(self, name, region="ewr"):
        return _call("create", "registry", None, name=name, region=region)

    def delete(self, registry_id):
        return _call("delete", "registry", registry_id)


class _Bucket:
    def versions(self, key="orders.json"):
        return _call("list", "bucket_object", key)

    def put(self, key, content):
        return _call("put", "bucket_object", key, content=content)

    def delete(self, key="orders.json"):
        return _call("delete", "bucket_object", key)

    def restore(self, key, version_id):
        return _call("restore", "bucket_object", key, version_id=version_id)


class _Http:
    def get(self, url):
        return _call("fetch", "http", None, url=url)


class _Policy:
    def read(self):
        return _call("read", "policy")


class _Ledger:
    def spend(self):
        return _call("read", "ledger")


instances = _Instances()
firewalls = _Firewalls()
vpcs = _Vpcs()
registries = _Registries()
bucket = _Bucket()
http = _Http()
policy = _Policy()
ledger = _Ledger()

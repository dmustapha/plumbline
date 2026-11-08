import socket, json, sys
GATE = ('plb-gate', 8080)
def raw(req: bytes, host=GATE, timeout=5):
    try:
        s = socket.create_connection(host, timeout=timeout); s.sendall(req); s.settimeout(timeout)
        data = b''
        try:
            while True:
                c = s.recv(4096)
                if not c: break
                data += c
        except Exception: pass
        s.close(); return data.split(b'\r\n')[0].decode('latin1') if data else '(no response)'
    except Exception as e:
        return f'ERR {type(e).__name__}: {e}'
H = b'Host: plb-gate\r\nConnection: close\r\n'
tests = {
 'GET /healthz (allowed)': b'GET /healthz HTTP/1.1\r\n' + H + b'\r\n',
 'POST /v1/call no auth (allowed route, broker rejects)': b'POST /v1/call HTTP/1.1\r\n' + H + b'Content-Type: application/json\r\nContent-Length: 2\r\n\r\n{}',
 'absolute-URI GET http://1.1.1.1/': b'GET http://1.1.1.1/ HTTP/1.1\r\n' + H + b'\r\n',
 'absolute-URI POST http://172.17.0.1:7443/v1/call': b'POST http://172.17.0.1:7443/v1/call HTTP/1.1\r\n' + H + b'Content-Length: 2\r\n\r\n{}',
 'CONNECT 1.1.1.1:80': b'CONNECT 1.1.1.1:80 HTTP/1.1\r\n' + H + b'\r\n',
 'path /v1/call?x=1': b'POST /v1/call?x=1 HTTP/1.1\r\n' + H + b'Content-Length: 2\r\n\r\n{}',
 'path /v1/call/': b'POST /v1/call/ HTTP/1.1\r\n' + H + b'Content-Length: 2\r\n\r\n{}',
 'path /v1/../v1/status': b'GET /v1/../v1/status HTTP/1.1\r\n' + H + b'\r\n',
 'path //v1/call': b'POST //v1/call HTTP/1.1\r\n' + H + b'Content-Length: 2\r\n\r\n{}',
 'path %2e%2e traversal': b'GET /%2e%2e/v1/status HTTP/1.1\r\n' + H + b'\r\n',
 'GET /v1/policy-production': b'GET /v1/policy-production HTTP/1.1\r\n' + H + b'\r\n',
 'POST /v1/policy-production': b'POST /v1/policy-production HTTP/1.1\r\n' + H + b'Content-Length: 2\r\n\r\n{}',
 'smuggling CL+TE': b'POST /v1/call HTTP/1.1\r\n' + H + b'Content-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\nGET /v1/status HTTP/1.1\r\n\r\n',
 'CRLF in path': b'GET /healthz%0d%0aX: y HTTP/1.1\r\n' + H + b'\r\n',
 'oversized body 17 KiB': b'POST /v1/call HTTP/1.1\r\n' + H + b'Content-Length: 17408\r\n\r\n' + b'a' * 17408,
 'unsupported method TRACE': b'TRACE /healthz HTTP/1.1\r\n' + H + b'\r\n',
}
for k, v in tests.items(): print(f'{k:58s} -> {raw(v)}')
print('--- direct egress from the sandbox network')
for name, addr in [('internet 1.1.1.1:80', ('1.1.1.1', 80)), ('internet 8.8.8.8:53', ('8.8.8.8', 53)), ('docker0 gateway :22', ('172.17.0.1', 22)), ('broker port direct 172.17.0.1:7443', ('172.17.0.1', 7443)), ('metadata 169.254.169.254:80', ('169.254.169.254', 80))]:
    try:
        s = socket.create_connection(addr, timeout=3); s.close(); print(f'{name:40s} -> CONNECTED (BAD)')
    except Exception as e: print(f'{name:40s} -> blocked ({type(e).__name__})')
try:
    print('dns example.com ->', socket.gethostbyname('example.com'), '(BAD)')
except Exception as e: print('dns example.com -> fails (' + type(e).__name__ + ')')

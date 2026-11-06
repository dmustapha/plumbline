// File: packages/sandbox/gate/relay.mjs
import http from 'node:http';

const UPSTREAM_HOST = process.env.GATE_UPSTREAM_HOST || '172.17.0.1';
const UPSTREAM_PORT = Number(process.env.GATE_UPSTREAM_PORT || 7443);
const LISTEN_PORT = Number(process.env.GATE_LISTEN_PORT || 8080);
const MAX_BODY = 16 * 1024;

const allowed = (req) =>
  (req.method === 'POST' && req.url === '/v1/call') || (req.method === 'GET' && req.url === '/healthz');

const server = http.createServer((req, res) => {
  if (!allowed(req)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"status":"NOT_ROUTED"}');
    return;
  }
  const chunks = [];
  let size = 0;
  let tooBig = false;
  req.on('data', (c) => {
    if (tooBig) return;
    size += c.length;
    if (size > MAX_BODY) {
      tooBig = true;
      res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
      res.end('{"status":"PAYLOAD_TOO_LARGE"}');
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (tooBig) return;
    const up = http.request(
      { host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: req.method, path: req.url, timeout: 25000,
        headers: { 'content-type': req.headers['content-type'] || 'application/json', authorization: req.headers.authorization || '' } },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, { 'content-type': 'application/json' });
        upRes.pipe(res);
      },
    );
    up.on('timeout', () => up.destroy(new Error('upstream timeout')));
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end('{"status":"BROKER_UNREACHABLE"}');
    });
    up.end(Buffer.concat(chunks));
  });
});

server.listen(LISTEN_PORT, '0.0.0.0', () => console.log(`plb-gate relay listening on ${LISTEN_PORT}`));

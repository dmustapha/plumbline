// File: apps/broker/src/egress.ts
import { execFile } from 'node:child_process';

const VIRTUAL_HOST = 'range.plumbline.local';
const MAX_BYTES = 64 * 1024;

export class Egress {
  constructor(private readonly rangeApiUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async fetch(url: string): Promise<{ status: number; host: string; text: string; truncated: boolean }> {
    const u = new URL(url);
    let target = url;
    if (u.hostname === VIRTUAL_HOST) {
      if (!u.pathname.startsWith('/pages/')) return { status: 404, host: u.hostname, text: 'only /pages/* is served', truncated: false };
      target = this.rangeApiUrl + u.pathname;
    }
    const res = await this.fetchImpl(target, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(5000) });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, host: u.hostname, text: buf.subarray(0, MAX_BYTES).toString('utf8'), truncated: buf.length > MAX_BYTES };
  }

  readCounter(): Promise<{ dropped_packets: number | null; source: string }> {
    return new Promise((resolve) => {
      execFile('sudo', ['-n', '/usr/local/sbin/plb-egress-counter'], { timeout: 3000 }, (err, stdout) => {
        const n = Number.parseInt(String(stdout).trim(), 10);
        if (err || Number.isNaN(n)) resolve({ dropped_packets: null, source: 'unavailable' });
        else resolve({ dropped_packets: n, source: 'iptables DOCKER-USER drop counter' });
      });
    });
  }
}

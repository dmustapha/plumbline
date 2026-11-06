// File: apps/range-api/src/deps.ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiConfig } from './config.ts';
import { credsOf } from './creds.ts';
import type { BrokerClient, JsonResponse, RunnerClient } from './brokerClient.ts';
import type { InFlight, SlidingWindow } from './rateLimit.ts';
import type { SessionBook } from './sessionBook.ts';
import type { SseHub } from './sse.ts';

export interface ApiDeps {
  config: ApiConfig;
  broker: Pick<BrokerClient, 'call' | 'chat' | 'mint'>;
  runner: Pick<RunnerClient, 'run' | 'containers'>;
  hub: SseHub;
  book: SessionBook;
  /** 3 attacks per minute per session (R5, A-4). */
  attackLimit: SlidingWindow;
  /** Rewind, ACL self-test, approvals, tier: real broker/Vultr calls, 10 per minute per session. */
  actLimit: SlidingWindow;
  /** AG4-PRD-5: session creations per IP. */
  sessionIpLimit: SlidingWindow;
  /** AG4-PRD-5: session creations per minute across all callers. */
  sessionGlobalLimit: SlidingWindow;
  inFlight: InFlight;
  fetchImpl?: typeof fetch;
  clock?: () => number;
}

export function rateLimited(reply: FastifyReply, retryAfterS: number): FastifyReply {
  return reply.code(429).header('retry-after', String(retryAfterS)).send({ status: 'RATE_LIMITED', retry_after_s: retryAfterS });
}

/** Passes a broker answer through; a dead broker becomes 502, never an exception. */
export async function relay(reply: FastifyReply, p: Promise<JsonResponse>): Promise<FastifyReply> {
  try {
    const r = await p;
    return reply.code(r.status).send(r.json);
  } catch (e) {
    return reply.code(502).send({ status: 'BROKER_UNREACHABLE', detail: String((e as Error).message).slice(0, 100) });
  }
}

/**
 * Resolves the caller's own session (AG4-PRD-6, AG4-BRK-3). Session ids are public (they sit in decision rows), so the id
 * alone proves nothing: the caller must hold the key issued at creation, carried by the cookie (browser) or headers
 * (scripts). `claimed` is a session id the request names (body, path); it must match the credential's own id, and routes
 * that must not trust any client-named id pass nothing. Replies and returns null when the check fails.
 */
export function sessionFor(d: ApiDeps, req: FastifyRequest, reply: FastifyReply, claimed?: unknown): string | null {
  const c = credsOf(req);
  if (c.sid && typeof claimed === 'string' && claimed !== c.sid) {
    void reply.code(403).send({ status: 'SESSION_MISMATCH' });
    return null;
  }
  const sid = c.sid ?? (typeof claimed === 'string' ? claimed : null);
  const res = d.book.check(sid, c.key);
  if (res === 'OK') return sid;
  const status = res === 'KEY_REQUIRED' ? 'SESSION_KEY_REQUIRED' : res === 'KEY_MISMATCH' ? 'SESSION_KEY_MISMATCH' : 'SESSION_UNKNOWN';
  void reply.code(res === 'KEY_REQUIRED' ? 401 : 403).send({ status });
  return null;
}

// File: apps/range-api/src/creds.ts
import type { FastifyRequest } from 'fastify';

export const COOKIE_NAME = 'plb_session';
const MAX_AGE_S = 3 * 60 * 60;

export interface Creds {
  sid: string | null;
  key: string | null;
}

export function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** HttpOnly + SameSite=Strict: page scripts cannot read the key and another site cannot ride it. */
export function sessionCookie(sid: string, key: string, secure: boolean): string {
  return `${COOKIE_NAME}=${sid}.${key}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE_S}${secure ? '; Secure' : ''}`;
}

const header = (req: FastifyRequest, name: string): string | null => {
  const v = req.headers[name];
  return typeof v === 'string' && v.length > 0 ? v : null;
};

/** The browser carries the cookie; scripts (gates, curl) may send the same two values as headers. The cookie wins. */
export function credsOf(req: FastifyRequest): Creds {
  const cookie = readCookie(req.headers.cookie, COOKIE_NAME);
  const dot = cookie ? cookie.indexOf('.') : -1;
  if (cookie && dot > 0) return { sid: cookie.slice(0, dot), key: cookie.slice(dot + 1) };
  return { sid: header(req, 'x-plumbline-session-id'), key: header(req, 'x-plumbline-session-key') };
}

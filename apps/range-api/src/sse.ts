// File: apps/range-api/src/sse.ts
export interface SseEvent {
  id: number;
  type: string;
  data: unknown;
}

type Send = (e: SseEvent) => void;

export class SseHub {
  readonly #buffers = new Map<string, SseEvent[]>();
  readonly #subs = new Map<string, Set<Send>>();
  #seq = 0;

  publish(sessionId: string, type: string, data: unknown): SseEvent {
    const e: SseEvent = { id: ++this.#seq, type, data };
    const buf = this.#buffers.get(sessionId) ?? [];
    buf.push(e);
    if (buf.length > 200) buf.shift();
    this.#buffers.set(sessionId, buf);
    for (const send of this.#subs.get(sessionId) ?? []) send(e);
    return e;
  }

  subscribe(sessionId: string, send: Send, lastEventId = 0): () => void {
    for (const e of this.#buffers.get(sessionId) ?? []) if (e.id > lastEventId) send(e);
    const set = this.#subs.get(sessionId) ?? new Set<Send>();
    set.add(send);
    this.#subs.set(sessionId, set);
    return () => { set.delete(send); };
  }

  /** Frees the buffer of a session that no longer exists. Open subscribers keep their socket until they close. */
  drop(sessionId: string): void {
    this.#buffers.delete(sessionId);
    this.#subs.delete(sessionId);
  }

  static format(e: SseEvent): string {
    return `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`;
  }
}

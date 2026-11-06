// File: apps/broker/src/taskState.ts

/**
 * SEC-F5: everything the broker remembers per task (model name, call count). A task token lives two minutes, so the entry
 * is dropped once the token's own expiry has passed (reap calls prune).
 */
export class TaskState {
  readonly models = new Map<string, string>();
  readonly calls = new Map<string, number>();
  readonly #exp = new Map<string, number>();

  register(taskId: string, exp: number, model?: string): void {
    this.#exp.set(taskId, exp);
    if (model) this.models.set(taskId, model);
  }

  /** Counts one more call for the task and returns the new total. */
  bump(taskId: string, exp: number): number {
    if (!this.#exp.has(taskId)) this.#exp.set(taskId, exp);
    const n = (this.calls.get(taskId) ?? 0) + 1;
    this.calls.set(taskId, n);
    return n;
  }

  prune(now: number): number {
    let dropped = 0;
    for (const [id, exp] of this.#exp) {
      if (exp >= now) continue;
      this.#exp.delete(id);
      this.models.delete(id);
      this.calls.delete(id);
      dropped += 1;
    }
    return dropped;
  }

  size(): number {
    return this.#exp.size;
  }
}

export function verify(exp: unknown, pin?: { seq: number; row_hash: string } | null): { ok: boolean; msg: string }[];

# AG4 waivers
None for G0-owned files (ENG-1..7, ADP-1..8, BRK-1..7, PRD-1, VER-1 ledger side, VER-5 engine side, CO-2 H-1 engine side, H-2 schema all FIXED with named tests). Others QUEUED in evidence/ag4-queue.md.

## G1b (verifier) partial notes
- AG4-VER-4 is FIXED by ownership/mode enforcement (symlink, world-writable, wrong uid => the whole destroy log is ignored) plus the rule that a destroy excuses a missing resource only when `ts >= the ALLOW row's created_at_ms`. HMAC-signing the entries is NOT done: it needs a secret the watchdog must not hold (D-R6a: the watchdog has no lease secret). A same-uid compromise of the watchdog can still append an excuse for a resource that really was destroyed by someone else after its ALLOW row; that residue is accepted and stated here. Tests: reconcile.test.ts (AG4-VER-4 block), sharedFiles.test.ts (readDestroyed), server.test.ts (AG4-VER-4 block).
- AG4-VER-2: the bound is 120 s (the broker default), not 60 s, so the unmodified broker is not refused; see CR-G1b-2 for the recommended 45/60 pair.

## G1c (watchdog) notes
- AG4-VER-4: FIXED on the watchdog side (log opened O_NOFOLLOW, regular file, owned by the running uid, repaired to 0644, entries `{ts, act:'destroyed', id, class}`; test block `AG4-VER-4` in apps/verifier/test/watchdog.test.ts). HMAC signing stays WAIVED for the reason recorded under G1b: the watchdog holds no secret (D-R6a).
- AG4-VER-2 (emitter side): the broker emitter clamps ttl to 60 s (`clampLeaseTtl`, apps/broker/test/lease.test.ts); the receiver bound stays 120 (G1b note above).
- Baseline-id protection with an unreadable manifest is deliberately NOT fail-closed: the dead hand still sweeps its strict allow-list (workers `plumbline-wk-*`, playground regex) and the signed floor still denies infra/prod; refusing to act on a missing file would let a deleted manifest disarm the dead hand. The status file reports `baseline: "unavailable"`.

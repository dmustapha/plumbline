# Phase 5 critique: operator, sandbox, runner, verifier, ops scripts

Scope: packages/operator, packages/sandbox, apps/runner, apps/verifier, ops/scripts, ops/systemd. Read-only on source.
Adjacent files read for context only: apps/range-api/src/{run,brokerClient,routes,routes-session}.ts, apps/broker/src/{llmProxy,lease,main}.ts,
packages/vultr-adapter/src/vsi.ts, packages/ledger/src/export.ts.
Method: full read of the domain, offline `npx vitest run` (279 passed, 13 skipped), and four offline repros
(`/private/tmp/claude-501/-Users-MAC-vultr-rush/c1c93a3a-1a90-41ec-a437-c1289dc8099d/scratchpad/repro.mts`, pure functions and a fake docker exec, nothing live).
Not redone: range-api, broker auth, sandbox escape.

Counts: MUST-FIX 4, SHOULD-FIX 11, NOTE 9.

---------------------------------------------------------------------------------------------------

## MUST-FIX

### M1. Watchdog sweeps the whole range when it starts against a stale lease.json (no grace for a stale file, only for a missing one)
- Files: apps/verifier/src/lease.ts:113-119 (`leaseState`), apps/verifier/src/watchdog.ts:262-269 and 284-288 (`#leaseState`, `tick`).
- The first-contact grace in `leaseState` is applied only when `l === null`. A lease file that exists but is older than `ttl_s` returns LAPSED immediately, whatever `everSeen`/`startedAt` say. lease.json lives in /var/lib/plumbline-shared and survives reboots.
- Repro (R1): `leaseState({last_ts:1, ttl_s:45, received_at: now-1h}, now, {startedAt: now, graceMs: 120000, everSeen: false})` returns `LAPSED`.
- Failing scenario: VM 2 reboots (or both units are restarted after the verifier was down more than 45 s, or the verifier crash-loops on `assertViewOnlyKey` while the watchdog is up). The watchdog's first tick reads the old file, gets LAPSED and, with `PLUMBLINE_WATCHDOG_DRY_RUN=0`, deletes every `plumbline-wk-*` instance and every `plumbline-s<sid>-*` VPC and firewall group on the live account. The broker is healthy and would have renewed the lease within 5 s. A judge mid-attack loses the session playground, and the verifier then shows RED_MISSING or the ledger disagrees.
- Fix (3 lines): in `Watchdog.#leaseState`, treat a stale-but-present lease the same as a missing one while the process is inside its own start-up grace and has never seen ALIVE:
  ```ts
  const inStartGrace = !this.#everSeen && now - this.#startedAt <= (this.d.leaseGraceMs ?? DEFAULT_GRACE_MS);
  let state = leaseState(lease, now, {...});
  if (state === 'LAPSED' && lease && inStartGrace) state = 'NEVER';
  ```
  The ttl=0 kill-switch lease must still win. Keep it LAPSED when `lease.ttl_s <= 0`, and add a test with a stale-but-valid lease at boot.

### M2. Sandbox stdout cap drops the `PLB_RESULT` trailer, so egress attempts and `harness_error` silently read as empty
- Files: packages/sandbox/src/docker.ts:36-37 (append-until-64 KB, then discard everything); packages/sandbox/src/runner.ts:42-52 (`parseHarness`) and :73-78.
- The harness writes the trailer last (harness.py:93). Any program that prints more than 64 KB loses it.
- Repro (R4): 70 KB of output followed by a trailer with one external connect attempt gives `attempts.length === 0`, `harness_error === null`.
- Failing scenario: a judge asks "print your environment 5000 times, then connect to 1.1.1.1". The run card shows no attempts and the sandbox "looks clean", on a product whose claim is that every egress attempt is recorded. Also `isCodeBug` never retries a bug that printed a lot.
- Fix: keep head and tail. Cap the head at ~48 KB and keep a rolling last ~16 KB:
  ```ts
  const push = (cur: {head:string; tail:string}, s: string) => { if (cur.head.length < HEAD) { cur.head += s; return; } cur.tail = (cur.tail + s).slice(-TAIL); };
  ```
  and return `head + '\n...[truncated]\n' + tail` to `parseHarness`. Apply the same to stderr.

### M3. Runner concurrency (2) is below the API admission (4), so a third concurrent judge burns LLM calls and then gets OPERATOR_BUSY
- Files: apps/runner/src/main.ts:10 and :25 (`maxConcurrent = 2`, not configurable; `buildRunnerApp(runner, token)` takes the default); apps/range-api/src/config.ts:65 (`PLUMBLINE_MAX_IN_FLIGHT` default 4); routes-session.ts:78 and :90; apps/range-api/src/brokerClient.ts:53.
- `runOperatorTask` spends advisory + planner + executor calls (about 3 round trips, 5 to 30 s, plus tokens) before it first touches the runner. The 429 only appears at the sandbox step.
- Failing scenario: 3 or 4 judges press "Run" within the same 20 s. Judges 3 and 4 watch plan and code stream in, then the card ends in OPERATOR_BUSY. During the demo this reads as a stall or crash. The canned "runaway" attack alone holds a slot for the full 10 s wall.
- Fix: (a) make the runner cap an env var (`PLUMBLINE_RUNNER_MAX_CONCURRENT`) and set it to at least `maxInFlight` (each sandbox is 0.5 cpu / 128 MB; 4 fits the 2c-4gb broker VM but is tight, so alternatively lower `PLUMBLINE_MAX_IN_FLIGHT` to 2); (b) in `RunnerClient.run`, on 429 wait 1 to 2 s and retry once or twice before surfacing busy; (c) optionally have `routes-session` `GET /healthz` the runner (`active`) before spending LLM tokens.

### M4. `bootstrap-range` regenerates env files that cannot boot the watchdog and that regress hardening on any re-run or rotation
- File: ops/scripts/bootstrap-range.ts:249 (watchdog.env), :242 (verifierOver), :294 (unconditional `writeAtomic` of every env file), :302 (`pending`). Runbook ops/scripts/vm-create.md:49, 65-68 tells the owner to re-copy the env files after `--rotate`.
- Facts:
  - The generated watchdog.env has only KEY, PUBKEY and `DRY_RUN=1`. apps/verifier/src/main-watchdog.ts:14 calls `assertOwnUser(uid, config.verifierUid)`, and watchdog.ts:85 throws `BOOT_REFUSED` when `PLUMBLINE_VERIFIER_UID` is null. A freshly generated file cannot boot.
  - `pending` mentions only `PLUMBLINE_WATCHDOG_UID` for verifier.env, not `PLUMBLINE_VERIFIER_UID` for watchdog.env and not the explicit `DRY_RUN=0` flip.
  - A re-run overwrites hand-edited files. The live stack's `VERIFIER_UID` and `DRY_RUN=0` edits are lost; verifier.env loses `PLUMBLINE_WATCHDOG_UID` unless `--watchdog-uid` is passed again.
- Failing scenario: owner runs `--rotate` the night before the demo (the runbook says to) and scps the files. The watchdog crash-loops with `BOOT_REFUSED`, or, if the UID is re-added by hand, silently comes back in dry-run. The kill-switch / dead-hand demo then deletes nothing. The verifier no longer enforces watchdog-log ownership (`readDestroyed`, sharedFiles.ts:37).
- Fix: carry over from `readExisting` (the `existing` map is already loaded) `PLUMBLINE_VERIFIER_UID`, `PLUMBLINE_WATCHDOG_UID` and `PLUMBLINE_WATCHDOG_DRY_RUN` when present; add `--verifier-uid` next to `--watchdog-uid`; list both in `pending`; keep dry-run as the default only for first creation. Also make step 3 of the runbook explicitly "never scp `ledger.sqlite` over a live broker" (see S2).

---------------------------------------------------------------------------------------------------

## SHOULD-FIX

### S1. `/api/verify` serves an arbitrarily old GREEN with no staleness downgrade
- apps/verifier/src/verifierServer.ts:106 (`GET /api/verify` returns `last`), :107-111 (POST), main-verifier.ts:17 (single run at boot). Nothing re-runs the reconcile periodically.
- Scenario: verifier boots, runs once (GREEN). A judge deletes something out of band or an attack lands; the verify page and the home-page chip still say GREEN, "report from 40 min ago" only in small text (public/app.js:93; the badge at :274 shows no age).
- Fix: run `run()` on an interval (30 s, respecting the in-flight guard), and in GET downgrade when `now - generated_at > 120 s` to `{...last, status:'DEGRADED', codes:['RECONCILE_DEGRADED'], notes:[..., 'report older than 120 s']}`. The UI badge should show age.

### S2. The continuity pin makes a ledger reset or restore a permanent false-RED
- apps/verifier/src/reconcile.ts:231 (`decisions[p.seq-1]?.row_hash !== p.row_hash` gives RED_LEDGER_TAMPERED); sharedFiles.ts:105 (`writePin` only ever grows; never cleared); verifierServer.ts:79.
- Scenario: the rehearsal flow wipes or replaces `/var/lib/plumbline/ledger.sqlite` (runbook step 3 `scp ledger.sqlite` on a re-bootstrap, a restore from backup, a "clean demo" reset). The verifier compares against the old pin and reports "history rewritten" on every run until someone finds `/var/lib/plumbline-verifier/ledger-pin.json`. No document or script mentions it. In the demo this is a red verdict you cannot explain.
- Fix: document `rm /var/lib/plumbline-verifier/ledger-pin.json && systemctl restart plumbline-verifier` in the runbook, or add an owner-signed `POST /pin/reset`. Better: store `chain_genesis`/`first_row_hash` with the pin and report "LEDGER REPLACED (different genesis)" as DEGRADED with an explicit message instead of TAMPERED when the first row differs. Tampering stays RED when the genesis matches.

### S3. A Vultr create that returns 502/timeout but succeeded leaves a permanent RECONCILE_RED_UNLOGGED instance
- apps/verifier/src/reconcile.ts:133 (no row gives UNLOGGED, with no in-flight grace on this branch and no use of `ledger.unknown_outcomes`); apps/broker/src/main.ts:99-107 (`reclaimUnrecordedPlaygrounds` heals this for VPCs only; the LIVE FINDING comment says exactly this happened). Instances are not reclaimed, and the TTL reaper selects only ledger rows (main.ts:78).
- Scenario: "create instances in a loop of 20" under Vultr 429/502 produces at least one worker that exists with no row. The verifier is RED, which looks like a broker bypass, for the rest of the demo. The watchdog will not delete it unless the lease lapses.
- Fix: mirror the playground reclaim for `plumbline-wk-*` instances seen in two consecutive sweeps with no ledger row (broker side), and in the verifier, if `unknown_outcomes` contains a create for the same label/class within the last N minutes, downgrade that finding to DEGRADED ("outcome unknown: create timed out") rather than UNLOGGED.

### S4. Operator retry re-executes a program that may already have performed side effects
- packages/operator/src/loop.ts:44 (`isCodeBug` matches KeyError/TypeError/etc. anywhere in the self-reported error), :114-118 (feeds the error back and re-runs under a fresh task).
- Scenario: "create instances in a loop of 20 until I say stop": the generated code creates three workers and then raises `KeyError: 'id'` on the fourth. The operator asks for a fix and runs again, so a second batch of creates and possibly a second attempt at a destructive verb happen. The policy engine caps it, but spend, ledger noise and the "one ask, one action" demo narrative suffer. `harness_error` is also attacker-controlled text (see N7).
- Fix: retry only when the run issued no broker call. The sandbox can compute this cheaply (the harness counts SDK calls and puts the number in the trailer, or the broker reports calls per task_id), or limit retries to `SyntaxError|NameError|IndentationError`, which cannot have had effects. Tell the model what already ran when you do retry.

### S5. Tool-call extraction is brittle for the exact failure mode the code comment says is live
- packages/operator/src/tools.ts:28-31 and :33.
- (a) R2: a multi-line program whose JSON string contains literal newlines (common for qwen/GLM) gives "arguments are not valid JSON", and each retry costs a full model round trip.
- (b) R3: qwen answering in prose with a fenced block (the live finding at loop.ts:86) is classified `refusal` whenever the first 400 chars contain "I cannot / I can't / I won't", including inside the code (`print("I cannot list")`), so a runnable answer ends the task as REFUSED.
- (c) R3b: otherwise the fenced code is thrown away and a retry is spent.
- Fix: in `extractCode`, (1) try `JSON.parse`; on failure retry after escaping raw control characters inside the string (`s.replace(/\n/g,'\\n')` applied only between the first `"code":"` and the last `"}`), (2) when there is no tool call, first look for a ```python fence and return `{kind:'code'}`, and only run the refusal regex when no fence exists. Keep the 4000-char cap.

### S6. No per-task deadline: serial advisory call plus doubled fallback can stall one attack for minutes
- packages/operator/src/loop.ts:59 (advisory awaited before the planner), :69, :87; apps/broker/src/llmProxy.ts:18-23 (any error, including a 25 s timeout, retries on the other model with a fresh 25 s); vsi.ts:64 (25 s per call).
- Worst case: advisory 25 s + planner 50 s + executor 50 s + two retries 100 s = about 225 s for one task. The unix socket client allows 60 s per call (brokerClient.ts:10). The advisory result is only a UI label.
- Fix: start the advisory call concurrently with the planner (`Promise.allSettled`) and cap it at 4 s with `AbortSignal`/`Promise.race`; add a task deadline (for example 75 s) to `runOperatorTask` that skips retries and returns `OPERATOR_BUSY` with "deadline"; in `LlmProxy.chat`, do not fall back on 4xx/`MODEL_NOT_ALLOWED`, and shorten the fallback timeout.

### S7. Teardown has no ordering wait or retry, so it leaves paid resources behind
- ops/scripts/teardown.ts:10 and :30-33; contrast ops/scripts/gates.ts:79-86 (`removeWhenUnlocked`, which exists because Vultr answers 409 "locked" for a new instance).
- Scenario: instances are deleted, then firewall groups and VPCs immediately. A VPC or firewall still attached to an instance that is still deleting is refused, goes into `failed`, is never retried, and the run exits 1. Object storage (deleted last) does get deleted, but any VPC/firewall/registry left over keeps the account non-empty.
- Fix: after the instance phase, poll `inventory()` until no `instance` items remain (60 s cap), and wrap each `remove` in the same 409/locked/in-use retry loop (8 s, up to about 14 tries). Print a final re-inventory and exit non-zero if anything remains.

### S8. A stopped runner leaves a spinning sandbox container running forever
- ops/systemd/plumbline-runner.service (no `ExecStopPost`/`TimeoutStopSec`); packages/sandbox/src/docker.ts:35 and runner.ts:70 (the only wall-clock enforcement lives in the Node process); main.ts:51 sweeps only at the next boot.
- Scenario: `systemctl stop plumbline-runner` (maintenance, a kill-switch drill, an OOM kill of node) while the canned "runaway" is executing. systemd kills the docker CLI children, not the container. The container keeps burning 0.5 cpu until the runner is started again.
- Fix: add `ExecStopPost=/usr/bin/docker ps -aq --filter label=plumbline-sbx | xargs -r docker rm -f` through `/bin/sh -c`, plus an in-container backstop: `ENTRYPOINT ["timeout","-s","KILL","40","python","-I",...]` (coreutils is in python:slim) so a lost runner can never leave a container alive for more than 40 s.

### S9. Restart-storm protection can leave a unit permanently failed
- ops/systemd/plumbline-{runner,verifier,watchdog,broker,api}.service: `Restart=always`, `RestartSec=2`, no `StartLimitIntervalSec=0`. systemd defaults (burst 5 in 10 s) apply.
- Scenario: runner `sweepStrays()` throws while dockerd is still coming up (main.ts:51 is a top-level await), or the verifier's `assertViewOnlyKey` fails on a DNS blip (main-verifier.ts:12). With a 2.5 to 3 s cycle, five fast failures inside 10 s put the unit in `failed (start-limit-hit)` and nothing restarts it. The demo then has no runner or verifier until someone intervenes.
- Fix: add `StartLimitIntervalSec=0` to the `[Unit]` section of each of the five units (or a bounded retry in the runner's boot sweep).

### S10. Verifier CLI exit code 1 collides with RED
- apps/verifier/src/cli.ts:55 (`JSON.parse(readFileSync(...))` unguarded) and :75-78 (top-level await with no catch).
- Scenario: a missing, truncated or non-ledger JSON file throws; Node exits 1, the documented meaning of RED. A CI wrapper or a judge running `plumbline-verify` sees "RED" for a typo. A JSON `[]` ledger crashes inside `verifyExport` the same way.
- Fix: wrap the load in try/catch, return `{code: 2, report: DEGRADED early(...)}` with the reason, and install a top-level `catch` that exits 2.

### S11. Operator error classification turns transient infrastructure errors into OPERATOR_INVALID, and a non-Error throw crashes the handler
- packages/operator/src/loop.ts:46-48 (`busy` regex), :71, :89, :110 (`String((e as Error).message)`); apps/range-api/src/brokerClient.ts:37, :55 (`LLM_429`, `LLM_502`, `RUNNER_500`, `socket timeout`).
- Scenario: inference failures are fine (the broker maps every upstream failure to 503, routes-internal.ts:126, which `busy` catches), but a `socket timeout` from the unix client, `RUNNER_500` and `ECONNREFUSED` while a unit restarts are all reported to the judge as OPERATOR_INVALID ("your request is invalid") instead of busy/retry. If something throws `undefined`/a string, `(e as Error).message` throws inside the catch and `runOperatorTask` rejects (range-api `execute` then reports it as OPERATOR_BUSY, hiding the real bug).
- Fix: one helper `const msg = (e: unknown) => e instanceof Error ? e.message : String(e)`; widen `busy` to `/BUSY|503|timeout|ECONN|RUNNER_5|TASK_5/`.

---------------------------------------------------------------------------------------------------

## NOTE

- N1. Watchdog log failures abort a sweep. `ActionsLog.append` is not guarded in the `refused` branch (watchdog.ts:245) or in `#confirmUnknown` (:215, after the entry was already deleted from `#unconfirmed`). Disk-full or a mode/ownership problem throws out of `tick()`, skips `#publish`, and leaves the remaining targets undeleted for that tick; a lost "destroyed" confirmation later reads as RED_MISSING. Wrap both appends like `#destroy` already does.
- N2. `loadWatchdogConfig().dryRun` (config.ts:89) is dead and has the opposite default from `resolveDryRun` (`=== '1'` versus "anything but 0"). Today `main-watchdog.ts` uses only `resolveDryRun`, so it is safe; delete the field before someone wires it.
- N3. Cross-host clock skew leaks into verdicts. `INFLIGHT_GRACE_MS = 5000` (reconcile.ts:108, :233) and `excused` (:143) compare broker-clock timestamps (`created_at_ms`, `generated_at`) with verifier-clock polls. More than about 5 s of skew between the ewr broker and the second-region verifier gives a persistent DEGRADED ("export predates the poll"). Confirm chrony/timesyncd on both VMs in bootstrap-vm.sh and show skew on /status.
- N4. Live gates are destructive on a live range. gates.ts l3 kills the broker and the dead hand then deletes every `plumbline-wk-*` and playground; l2 (:96-99) leaves a RED verifier for 6+ s and, if `removeWhenUnlocked` exhausts its ~2 min, leaves `plumbline-gate-oob` behind, which is outside both the reaper and watchdog scope. Never run l2/l3 once judges can connect.
- N5. `bootstrap-vm.sh` re-run side effects: `docker rm -f plb-gate` (:91) drops in-flight sandbox calls; `echo "$SITE_ENV" >> /etc/default/caddy` (:190) appends a duplicate line on every run (harmless today, wrong if the IP changes); the gate defaults assume docker0 is 172.17.0.1.
- N6. firewall-rules.sh `apply()` (:47-48) flushes `PLB-SBX` before re-adding rules, leaving a window with an empty chain on each docker restart. Low risk because the network is `--internal`, but building the chain under a temporary name and swapping the jump closes it.
- N7. Prompt-injection echo and blank label: `isCodeBug`'s `harness_error` (attacker-influenced text) is pasted into the next prompt (loop.ts:117); and an empty advisory reply yields `''`, which `??` does not replace with "unlabelled" (loop.ts:60-62). Cosmetic, but quote/trim the error and use `||`.
- N8. Teardown scope is `name.startsWith('plumbline')` (owner-port.ts:29): any non-project resource with that prefix on the account is deleted, and `user` items (including any service user whose key the owner context uses) are deleted before `object_storage` (teardown.ts:10). Confirm the owner key does not belong to a `plumbline-*` user, otherwise the storage delete runs with a revoked key.
- N9. The ledger export is the whole decisions table, hashed synchronously on the broker's event loop on every verify run (packages/ledger/src/export.ts:96-120). Fine at demo scale; at several thousand decisions the 8 s fetch timeout (verifierServer.ts:37) and the broker's latency start to suffer. Consider caching the export for a few seconds.

---------------------------------------------------------------------------------------------------

## What is solid (so it is not re-litigated)
- `reconcile` fails closed on every input problem, requires a finding in both polls, never turns an unverified ledger or derived baseline into GREEN, and the two-poll/grace design correctly handles delete races (reconcile.ts:170-173, :242-246).
- Watchdog scope is triple-checked (strict playground regex, engine under the signed floor, baseline ids), the lease reader fails closed, and dry-run is the default unless an explicit `0`.
- Sandbox lifecycle: the destroyed flag requires both `rm -f` and an empty `ps`; the timeout path kills by name; boot sweep by label; no tempdirs. State comes from `docker inspect`, not from self-report.
- `buildRunArgs` hardening and the firewall check as `ExecStartPre` are consistent and tested.

## Offline verification performed
- `npx vitest run packages/operator packages/sandbox/test apps/runner apps/verifier`: 15 files passed, 1 skipped; 279 tests passed, 13 skipped.
- Repro script output: R1 `LAPSED`; R2 `invalid / not valid JSON`; R3 `refusal` for code containing "I cannot"; R3b `invalid` for a fenced answer; R4 `attempts kept: 0 (trailer had 1)`.
- No Vultr, broker or VM call was made, and `/Users/MAC/vultr-rush/.env` was not read.

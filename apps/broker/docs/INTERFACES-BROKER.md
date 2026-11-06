# Broker interfaces (apps/broker)

## Changes since the extracted ARCHITECTURE (A-G4 remediation, task 1.11b)

Routes kept stable: `POST /v1/call` (sandbox listener), `/v1/llm`, `/v1/task`, `/v1/live-list`, `/v1/ledger/export`, and
the admin routes. The wire shapes changed only as listed.

1. `POST /v1/call` (sandbox): `verb`/`class` must be a pair in the engine catalog (`VERB_CLASS`), else `400 ARGS_INVALID`
   with `errors: ["verb/class pair is not in the catalog"]` and no decision row (AG4-BRK-1). The caller is always
   `sandbox`: a `policy` `write` is `DECIDED` `DENY` (`policy-write-owner-only`), and the dispatcher independently throws
   `POLICY_WRITE_OWNER_ONLY` (AG4-BRK-7).
2. `params` gained `port`, `notes`, `content` (policy/object body, printable ASCII, 2000 chars) and `firewall_group_id`.
   They are now part of `CallRequest.params` (hash-bound, visible to the engine) and are validated: `port` is `N` or `N:M`
   in 1-65535, `notes` matches `[A-Za-z0-9 ._:/-]{1,64}`, `firewall_group_id` is a safe id. `update instance` REQUIRES a
   non-empty `firewall_group_id` (no detach), `update firewall_group` REQUIRES `port`. Policy-write and bucket-put body
   moved from the old hidden `extra.content` to `params.content` (AG4-BRK-2).
3. Ownership (AG4-BRK-3): `update`/`delete` on a `plumbline-wk-*` or `plumbline-s*` resource that the broker ledger does not
   attribute to the calling session is presented to the engine as out of scope (label `owned-by-another-session`) and is
   DENIED (`scope-label-prefix`). The request's `target.owner_session` carries the ledger owner (null when unknown).
   Engine follow-up: a dedicated floor rule `session-ownership-mismatch` can replace the relabel (see DEV-B1).
4. `fetch` (class `http`): SSRF guard in code (AG4-BRK-4). Refused with decision `ALLOW` then result error
   `EGRESS_REFUSED` for IP literals, non-default ports, non-http(s), URL credentials, or any host resolving to a
   private/link-local/metadata/loopback address. Redirects are NOT followed: a 3xx returns `status` and `redirect_to` and the
   agent must issue a new `fetch` that the engine judges. Body is read with a hard 64 KiB cap while streaming.
5. Approvals (AG4-BRK-5): `POST /v1/approval/:id` re-evaluates without writing a row. It executes only when the re-evaluation
   is an ESCALATE for the SAME rule, request hash and resolved target; otherwise `{ status: "STALE" }` and an
   `APPROVAL_STALE` event. An approval writes one ALLOW row linked by `approved_from` and no extra ESCALATE row. The ALLOW
   is minted by the engine's `approveEscalation`, which verifies an ed25519 signature made by the broker's in-memory
   approval key (see DEV-B2), single-use nonce and the escalation binding.
6. `POST /v1/admin/kill-switch/engage` (AG4-BRK-6) additionally destroys every live `plumbline-wk-*` worker the ledger knows,
   whether or not a verifier is configured or reachable: response gains `workers_destroyed: string[]` and
   `workers_failed: {id, code}[]`. The TTL reaper and session sweep keep running under the kill switch through
   `Pipeline.cleanup` (delete of `plumbline-wk-*` instances and `plumbline-s<sid>-*` groups only; ledgered with
   `system_cleanup: true`, task id `reap-*`, session `system`).
7. Session ids are now exactly 8 lowercase hex characters, so the playground label `plumbline-s<sid>-vault` matches the
   floor's `PLAYGROUND_LABEL_RE` (previously 12 hex, which the floor rule `playground-label-malformed` would refuse).
8. `GET /v1/ledger/export`: schema `plumbline-ledger-export/v2`, frozen. See `ledger-export.schema.md`.

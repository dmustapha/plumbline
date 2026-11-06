# Ledger export schema: `plumbline-ledger-export/v2` (FROZEN)

Route: `GET /v1/ledger/export` on the broker's internal socket. Auth: headers `x-plumbline-ts` (ms) and
`x-plumbline-sig` = hex HMAC-SHA256 of `export.<ts>` with the lease secret; skew over 30 s is refused with
`401 AUTH_EXPORT_INVALID`. Producer: `exportLedger` in `packages/ledger/src/export.ts`. Broker re-export and key pin:
`apps/broker/src/ledgerExport.ts` (`LedgerExport`, `LEDGER_EXPORT_KEYS`). Pinned by `apps/broker/test/ledger-export.test.ts`.

Freeze rule (CO-2 H-2, E-1): the KEY SET below does not change. A new field means a new schema id (`/v3`) and a
migration note for the verifier. JSON object key order is not part of the contract.

## Why these fields

The verifier must re-run the policy engine on live Vultr state, so a forged ALLOW row cannot pass: every decision and
every resource row carries `plan`, `region` and the full normalized `request` (the exact `CallRequest` the engine
decided, minus ids that vary per call: `{ verb, class, target, params }`). `request_hash` equals the engine's
`requestHash` of that request, so a row whose request was edited fails the hash. The hash chain makes insertion,
deletion or edit of any row detectable; the verifier pins `chain_head` and checks `generated_at` freshness.

## Top level

| key | type | meaning |
|---|---|---|
| `schema` | `"plumbline-ledger-export/v2"` | schema id |
| `generated_at` | number (ms) | server clock when the export was built; the verifier refuses a stale one |
| `decision_count` | number | length of `decisions` |
| `decisions` | `ExportDecision[]` | every engine decision, in insertion order |
| `resources` | `ExportResource[]` | every resource the broker created, each tied to its ALLOW decision |
| `unknown_outcomes` | `ExportUnknown[]` | mutations whose result was never seen (timeout/5xx after send), open until resolved |
| `counts` | `{ attacks, allow, escalate, deny, tasks, first_ts, last_ts }` | proof counts (decisions of non-system sessions) |
| `chain_head` | hex sha256 | head of the chain across decisions, then resources, then unknown outcomes |

## `ExportDecision`

`seq` (1-based, gapless), `id`, `ts`, `decision` (`ALLOW`|`ESCALATE`|`DENY`), `rule_id`, `layer`, `session_id`, `verb`,
`class`, `target_id` (string|null), `request_hash` (hex|null), `plan` (string|null), `region` (string|null),
`request` (`{ verb, class, target, params }` | null), `prev_hash`, `row_hash`.

`target` inside `request` is `{ id?, label?, tags?, resolved?, owner_session? }`: `resolved` is true only when label and
tags were read from the live inventory; `owner_session` is the owning session from the broker ledger (null when the
ledger has no row). `params` is the validated wire parameter set (`plan, region, ttl_h, label, url, key, version_id,
name, subnet, subnet_size, content, port, notes, firewall_group_id`).

An approval writes one more `ALLOW` row (same `request_id`, `call.approved_from` in the broker's private detail) and
NO second `ESCALATE` row (AG4-BRK-5).

## `ExportResource`

`id`, `class`, `label`, `plan`, `region`, `created_at_ms`, `destroyed_at_ms` (number|null), `protected` (boolean),
`allow_decision_id`, `allow_decision_kind` (must be `ALLOW`), `allow_request_hash`, `request` (the ALLOW decision's
request), `prev_hash`, `row_hash`.

## `ExportUnknown`

`request_id`, `session_id`, `method`, `path`, `estimate_usd`, `cause`, `ts`, `prev_hash`, `row_hash`.

## Chain

`row_hash = sha256(prev_hash + "\n" + canonicalJson(row without prev_hash and row_hash))`. The decision chain starts at
`GENESIS_HASH` (64 zeros); the resource chain starts at the last decision `row_hash`; the unknown-outcome chain starts
at the last resource `row_hash`; `chain_head` is the last `row_hash`. `verifyExport(exp, { now_ms, max_age_ms,
expect_head? })` (in `@plumbline/ledger`) checks freshness, chain, gapless `seq`, counts, head, and that every resource
row points at an `ALLOW` decision with the same request hash.

## TypeScript

```ts
import type { LedgerExport } from './apps/broker/src/ledgerExport.ts'; // re-export of @plumbline/ledger's LedgerExport
```

## JSON Schema (draft 2020-12, abridged to the contract keys)

```json
{
  "$id": "plumbline-ledger-export/v2",
  "type": "object",
  "required": ["schema", "generated_at", "decision_count", "decisions", "resources", "unknown_outcomes", "counts", "chain_head"],
  "additionalProperties": false,
  "properties": {
    "schema": { "const": "plumbline-ledger-export/v2" },
    "generated_at": { "type": "number" },
    "decision_count": { "type": "integer", "minimum": 0 },
    "chain_head": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
    "counts": { "type": "object" },
    "unknown_outcomes": { "type": "array", "items": { "type": "object" } },
    "decisions": { "type": "array", "items": { "$ref": "#/$defs/decision" } },
    "resources": { "type": "array", "items": { "$ref": "#/$defs/resource" } }
  },
  "$defs": {
    "request": {
      "type": ["object", "null"],
      "required": ["verb", "class", "target", "params"],
      "properties": { "verb": { "type": "string" }, "class": { "type": "string" }, "target": { "type": "object" }, "params": { "type": "object" } }
    },
    "decision": {
      "type": "object",
      "additionalProperties": false,
      "required": ["seq", "id", "ts", "decision", "rule_id", "layer", "session_id", "verb", "class", "target_id", "request_hash", "plan", "region", "request", "prev_hash", "row_hash"],
      "properties": {
        "seq": { "type": "integer", "minimum": 1 }, "id": { "type": "string" }, "ts": { "type": "number" },
        "decision": { "enum": ["ALLOW", "ESCALATE", "DENY"] }, "rule_id": { "type": "string" }, "layer": { "type": "string" },
        "session_id": { "type": "string" }, "verb": { "type": "string" }, "class": { "type": "string" },
        "target_id": { "type": ["string", "null"] }, "request_hash": { "type": ["string", "null"] },
        "plan": { "type": ["string", "null"] }, "region": { "type": ["string", "null"] },
        "request": { "$ref": "#/$defs/request" }, "prev_hash": { "type": "string" }, "row_hash": { "type": "string" }
      }
    },
    "resource": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "class", "label", "plan", "region", "created_at_ms", "destroyed_at_ms", "protected", "allow_decision_id", "allow_decision_kind", "allow_request_hash", "request", "prev_hash", "row_hash"],
      "properties": {
        "id": { "type": "string" }, "class": { "type": "string" }, "label": { "type": "string" },
        "plan": { "type": ["string", "null"] }, "region": { "type": ["string", "null"] },
        "created_at_ms": { "type": "number" }, "destroyed_at_ms": { "type": ["number", "null"] }, "protected": { "type": "boolean" },
        "allow_decision_id": { "type": "string" }, "allow_decision_kind": { "type": ["string", "null"] },
        "allow_request_hash": { "type": ["string", "null"] }, "request": { "$ref": "#/$defs/request" },
        "prev_hash": { "type": "string" }, "row_hash": { "type": "string" }
      }
    }
  }
}
```

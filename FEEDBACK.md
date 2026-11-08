# Questions and answers

Each thread is a question a reviewer is likely to ask, the answer, and the change it caused.

## Why does the dollar scene sometimes deny with `max-instances` instead of the ceiling?
**Answer:** the account allows four active instances and three are infrastructure. When a visitor worker holds the last slot, the engine denies the next create for `max-instances` before the dollar check. Both denies are real and both are shown.
**Change:** when `ceiling-dollar-deny` and another layer both deny, the verdict panel leads with the ceiling and lists the other layer underneath.

## Is the model resisting the attacks?
**Answer:** no claim is made. The operator runs in disclosed compliant-operator mode, so the engine is what you attack. A model that refuses is shown honestly as a refusal, not as a win for the box.
**Change:** `LIMITATIONS.md` and `HONESTY-LEDGER.md` state this in the first screen of each.

## The header said STALE. Is the verifier broken?
**Answer:** a GREEN older than five minutes is served as `STALE`, with the last status kept. It was never allowed to stay green indefinitely.
**Change:** a systemd timer on the verifier host runs a reconcile every two minutes (`ops/systemd/plumbline-verify-tick.timer`), so a quiet site stays fresh and a dead verifier turns stale within five minutes.

## Can two judges on one network both play?
**Answer:** each address may hold four live sessions and open eight streams. Above that the range answers 429 with a Retry-After.
**Change:** the limits were raised from 2 live sessions and 3 streams after a multi-tab test hit the old cap.

## Can I trust that a passing gate is real?
**Answer:** every gate writes `evidence/gate-lN.json` with the commit, time and base URL. `npm run verify-claims` marks a claim citable only when the file is recent, recorded at a declared commit, and untampered.
**Change:** a gate that failed on the harness (an unset variable and a session limit) is kept under `evidence/stress/gate-attempt-0836/`, and the passing evidence was restored from git, not edited.

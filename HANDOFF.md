# HANDOFF

## Target commit
`git checkout 5c1ec6e5480934de159f9dbaf0389eba49c5ac54` (HEAD when this file was written; the working tree also has an updated `evidence/claims-regenerated.json` not yet committed).

## Fresh-clone verify
```
git clone https://github.com/dmustapha/plumbline && cd plumbline && npm ci && npm test
```
Expected output: `1189 passed` (1189 tests across 82 files, offline, no credentials). `npm run typecheck` also passes per the README.

## Demo walkthrough
Follow the Try It steps in [submission/HACKATHON-README.md](submission/HACKATHON-README.md). The Verify in 60s block there mirrors the README section "Verify in 60 seconds".

## Do-not-modify (freeze list)
- `policy/floor.yaml` (and its signature `policy/floor.yaml.sig`): the immutable production floor
- `evidence/declared-commits.json`: the declared commits the claims ledger checks against
- `packages/policy-engine/`: the engine whose verdicts the proof rests on
- the gate evidence in `evidence/` (`gate-l1.json` to `gate-l7.json`): the proof surface

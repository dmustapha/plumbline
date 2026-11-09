# HANDOFF

## Target commit
`git checkout 8220497bfc137c0486778ff96b0091b3c47a79b1` (the last commit that changed code or evidence; later commits touch only README.md, HANDOFF.md and `submission/`). Evidence files can be regenerated after that commit by the gate runner, so compare the `head` field in `evidence/claims-regenerated.json` before trusting a count.

## Fresh-clone verify
```
git clone https://github.com/dmustapha/plumbline && cd plumbline && npm ci && npm test
```
Expected output: `1190 passed` (1190 tests across 82 files, offline, no credentials). `npm run typecheck` also passes per the README.

## Demo walkthrough
Follow the Try It steps in [submission/HACKATHON-README.md](submission/HACKATHON-README.md). The Verify in 60s block there mirrors the README section "Verify in 60 seconds".

## Do-not-modify (freeze list)
- `policy/floor.yaml` (and its signature `policy/floor.yaml.sig`): the immutable production floor
- `evidence/declared-commits.json`: the declared commits the claims ledger checks against
- `packages/policy-engine/`: the engine whose verdicts the proof rests on
- the gate evidence in `evidence/` (`gate-l1.json` to `gate-l7.json`): the proof surface

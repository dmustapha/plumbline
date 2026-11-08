# For judges

**One line:** an AI agent holds a live Vultr account and obeys on purpose. You attack it, a coded policy engine outside the model gives the verdict, and a second-region host re-reads the account to prove nothing broke.

**Live range:** https://plumbline.108-61-70-169.sslip.io (no sign-up)

**One proof command** (re-derives all eight claims from the evidence files, from a clean clone):

```bash
PLUMBLINE_URL=https://108-61-70-169.sslip.io npm run verify-claims
```

| Look at | Where |
|---|---|
| Attack the agent | `/range`, click `Delete prod-db` |
| The second-region verifier | `/verify` |
| Every verdict, append-only | `/replay` |
| Evidence and regenerate commands | `/proof` |
| What we do not claim | `/about`, `HONESTY-LEDGER.md` |
| First 60 seconds | [`JUDGE_GUIDE.md`](JUDGE_GUIDE.md) |
| Questions and answers | [`FEEDBACK.md`](FEEDBACK.md) |

# First 60 seconds

1. Open https://108-61-70-169.sslip.io. The header should read `LIVE VULTR GREEN`.
2. Click `Attack prod-db`. The range opens with the attack loaded. If it has not fired, click `Fire`.
3. In about 8 seconds the verdict panel shows `DENY protect-tagged-destroy`, and `plumbline-prod-db` stays `active` in the live list on the right.
4. Click `Reconcile`, then `Re-read the account now`. A verifier in another region reads the same account and answers GREEN.
5. Open `Policy`. Weaken a rule in your own session copy and fire the same attack at your own playground. It flips to `ESCALATE`. Fire it at `prod-db` and it still denies, because the production floor is signed and immutable.

If the range says `SESSIONS_PER_IP_LIVE`, your address already holds 4 live sessions. Wait for the retry time shown on the page.

Verify every claim from a clean clone:

```bash
PLUMBLINE_URL=https://108-61-70-169.sslip.io npm run verify-claims
```

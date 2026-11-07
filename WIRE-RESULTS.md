# WIRE-RESULTS.md

status: complete

## What Just Happened
Wire redeployed the nine debug fixes to both VMs and re-proved the whole range live: all seven gates pass again and the claims ledger recomputes 8 of 8 citable. It also found and closed a real leak the gates missed (any caller who knew another judge's session id could read that judge's policy copy and live list), reverted the rehearsal rate limits to the production defaults, and rotated an internal secret that was displayed during the work. The range a judge will attack is now the tested one.

## Honest Gaps
- Gate L2 is not clean: on two separate sequences its first attempt failed `verify_green_after_destroy` (and once crashed twice with no output) before passing. The same one-shot 8 s wait failed in the build phase too; I believe it is Vultr list lag after a delete but did not prove it, and I did not change the gate after it failed.
- Gate L1 cannot run from one address on production limits (it opens 4+ sessions, the limit is 2 live), so it was run under temporary overrides that were reverted; only a single-session judge flow was proven on the real defaults.
- The browser-side proof that the UI's calls actually fire (BT-5), the 400px layout and the accessibility fixes are not done because the UI is being replaced by Dami's design.
- Latency was sampled twice (7.1 s and 19.6 s), not measured at scale.
- 34 debug SHOULD-FIX items remain open, including a verifier that can serve a cached GREEN of any age.

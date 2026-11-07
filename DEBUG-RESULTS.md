# DEBUG-RESULTS.md

status: complete

## What Just Happened
Three independent reviewers read the whole codebase for bugs a judge or a 3-minute demo would hit, and nine real defects were fixed with regression tests: a race that let parallel creates exceed the instance cap, a spend gate that disabled the kill switch at the cap, orphaned worker rows, unrecorded ambiguous creates, a watchdog that could wipe a healthy fleet after a reboot, lost sandbox results, a runner/API capacity mismatch, a bootstrap that dropped required env, and a 413 on the production-policy test. This hardens the claim that the range survives being attacked; verify and stress ride on it.

## Honest Gaps
- The fixes are only proven offline (872 tests). They are not deployed to the two VMs and the seven live gates were not re-run against the new code; that must happen before the public window.
- Two frontend MUST-FIX items (dead SSE stream leaves Fire disabled; button handlers without error handling in app.js) are not fixed because the new design will rewrite that file; they are listed as a checklist for the design integration.
- 34 SHOULD-FIX items remain unfixed, including a verifier that serves a cached GREEN of any age and a permanent false RED after a create returns 502 yet succeeds.
- The 400px overflow on /proof and the aria-live and label gaps were found by reading code, not by rendering in a browser.

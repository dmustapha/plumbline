# deviations
- DEV-001 COSMETIC tests/boundary-lint.test.ts walk() tolerates missing dirs before G1 streams exist (ARCH said: assumes all dirs present).
- DEV-002/003/004 (engine) policy files v2; ceiling/plan/region/cap/kill-switch rules moved from session to floor (COSMETIC); sandbox policy writes all DENY (DEGRADED if a sandbox flow needs it).
- DEV-G0A-001..005 (adapter): port bound via params; create label from params.label; recordResource requires ALLOW of same class; one process-wide 20 req/s limiter; S3Store optional sender (INTERFACE/BEHAVIOUR/COSMETIC).
- DEV-B1..B7 (broker): ownership workaround via relabel (engine lacks owner_session rule); DEV-B2 approvals are signed by a broker in-memory ed25519 key = session owner stand-in (DESIGN CHOICE, Dami to confirm); session ids 8 hex; cleanup path for reaper; fetch never follows redirects; objstore health registration; update params stricter.
- DEV-005 COSMETIC (integrator) bootstrap-range EMPTY_OK allows PLUMBLINE_SANDBOX_SOCKET_DIR empty: only the U-4 socket fallback needs it (runner.env.example from G1a-core).
- DEV-006 (live finding) Vultr POST /users returns 400 without a password even for service users; adapter now sends a random unused password; mocks enforce it.

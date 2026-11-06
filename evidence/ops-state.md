# ops state
- 2026-11-06T13:10:05Z: api.env on VM1 gained PLUMBLINE_SESSIONS_PER_IP=30 for gate rehearsals (default 3). REVERT before the public window (remove the line, restart plumbline-api).
- 2026-11-06T13:24:17Z: broker.env on VM1 gained PLUMBLINE_SESSION_IDLE_MIN=5 for rehearsals (default 30). REVERT before public window. Broker restart orphans playground VPCs (in-memory sessions): clean with the owner-port cleanup before/after restarts.
- 2026-11-06T13:58:05Z: broker.env SESSION_IDLE_MIN now 10 + playground regions/cap lines (this is the intended public value now). api.env SESSIONS_PER_IP=30 still a rehearsal override: revert before public window.
- 2026-11-06T15:20:44Z: broker.env PLUMBLINE_BOND_ENABLED=1 set on VM1 for GATE-L7 (L7 ships if the gate passes).
- 2026-11-06T15:22:07Z: watchdog.env PLUMBLINE_WATCHDOG_DRY_RUN=0 (LIVE) on VM2 for GATE-L3.

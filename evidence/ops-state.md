# ops state
- 2026-11-06T13:10:05Z: api.env on VM1 gained PLUMBLINE_SESSIONS_PER_IP=30 for gate rehearsals (default 3). REVERT before the public window (remove the line, restart plumbline-api).
- 2026-11-06T13:24:17Z: broker.env on VM1 gained PLUMBLINE_SESSION_IDLE_MIN=5 for rehearsals (default 30). REVERT before public window. Broker restart orphans playground VPCs (in-memory sessions): clean with the owner-port cleanup before/after restarts.

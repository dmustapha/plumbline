# Link check

Run with `curl -s -o /dev/null -w "%{http_code}"`, 2026-11-08 UTC.

| URL | Status | Checked (UTC) |
|---|---|---|
| https://github.com/dmustapha/plumbline | 200 | 22:24:13 |
| https://plumbline.108-61-70-169.sslip.io | 200 | 22:24:14 |
| https://plumbline.108-61-70-169.sslip.io/docs/check | 200 | 22:24:15 |
| https://plumbline.108-61-70-169.sslip.io/api/ledger/public | 200 | 22:24:18 |
| https://plumbline.108-61-70-169.sslip.io/api/proof | 200 | 22:24:19 |
| https://plumbline.108-61-70-169.sslip.io/api/verify | 200 | 22:24:20 |
| https://66-42-126-97.sslip.io | 404 | 22:24:15 |
| https://66-42-126-97.sslip.io/api/verify | 200 | 22:26 |

Note: the verifier has no page at its root, so the bare address answers 404. Its working endpoint is `/api/verify`, which answers 200. Use that address, not the bare one, when linking the verifier.

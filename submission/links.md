# Link check

Run with `curl -s -o /dev/null -w "%{http_code}"`, 2026-11-08 UTC, rechecked after submission.

| URL | Status | Checked (UTC) |
|---|---|---|
| https://github.com/dmustapha/plumbline | 200 | 22:48:59 |
| https://plumbline.108-61-70-169.sslip.io | 200 | 22:48:59 |
| https://plumbline.108-61-70-169.sslip.io/docs/check | 200 | 22:49:00 |
| https://plumbline.108-61-70-169.sslip.io/api/ledger/public | 200 | 22:49:03 |
| https://plumbline.108-61-70-169.sslip.io/api/proof | 200 | 22:49:04 |
| https://66-42-126-97.sslip.io/api/verify | 200 | 22:49:04 |
| https://lablab.build/ai-hackathons/vultr-hackathon/locine-labs/plumbline-safe-agents-on-a-live-vultr-account | 200 | 22:48:47 |
| https://storage.googleapis.com/lablab-video-submissions/submissions/ejjbpnzvcx90mf02qkhta3hx/mhb9qidzjfxaymy05n2vctum/video/video_oc6wztqj6lrbnbi3goxxore7.mp4 | 200, 99753596 bytes | 22:48 |
| https://storage.googleapis.com/lablab-static-eu/submissions/ejjbpnzvcx90mf02qkhta3hx/mhb9qidzjfxaymy05n2vctum/presentation/presentation_c15t61rp4dfclgau0slaynhb.pdf | 200, 2213012 bytes | 22:48 |

Notes:
- The verifier has no page at its root, so the bare address https://66-42-126-97.sslip.io answers 404. Its working endpoint is `/api/verify`. Link that one.
- The hosted video is 99753596 bytes, the same size as the final render recorded in the demo verification (sha256 8135b9d0...a97d53 at render time). The hosted slides PDF is 2213012 bytes, the same size as `submission/slides.pdf`.
- No YouTube link exists. The video is hosted by lablab and referenced from the repo README.

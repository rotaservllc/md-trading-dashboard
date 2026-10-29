# Release 1 Nov 2026 (first production publish after the credit reset)

Candidate: deploy preview `6ae2f7c9aeb0b3ce9a9fd574` (created 29 Oct, free). Guard: `scripts/deploy_guard.py` passed (22 vs 22 functions, nothing removed, only daily-monitor-v2 and sunday-scanner unscheduled, all env refs set). Every endpoint compared with production on 29 Oct: identical shapes; dashboard page identical; `/netlify/functions/*.mjs` no longer served (404).

Contents
- Live sources recovered from deploy 6adb85c0 via the deploy URL (the 23 Oct deploy published the project root, so sources were public). Repo == live for all 22 functions; board-quotes, board-history, avanza-fund, market-scan-paper, hsbc-core.pre14oct now in the repo.
- Root index.html moved to public/index.html; publish dir = public (closes the source exposure).
- daily-monitor-v2 and sunday-scanner: schedules removed (options off until January). Functions still deployed for manual use.
- crypto-check, crypto-daily, lib/crypto-core removed from Netlify: the crypto paper engine runs in GitHub Actions (crypto/paper_engine.py). tg-webhook `/crypto` reads crypto/state.json from GitHub.
- Deploy set excludes daily-monitor.mjs and test-alert.mjs (stubs), as before.

Procedure on 1 Nov after 11:00 Dubai (credits reset)
1. Read the Netlify UI credit counter (team billing) and note it.
2. Re-run the guard against the candidate (production may have changed): `NETLIFY_AUTH_TOKEN=... python3 scripts/deploy_guard.py --site cd39a088-9fc0-42bd-8e33-b72febd040c2 --candidate 6ae2f7c9aeb0b3ce9a9fd574 --allow-unschedule daily-monitor-v2,sunday-scanner`
3. Publish by restore, never `netlify deploy --prod`: `POST https://api.netlify.com/api/v1/sites/cd39a088-9fc0-42bd-8e33-b72febd040c2/deploys/6ae2f7c9aeb0b3ce9a9fd574/restore`
4. Verify production: /api/board-quotes?symbols=VWRA.L, /api/hsbc?status=1, /api/tt-live, /api/trading-data, /api/market-scan-paper, / (page), /netlify/functions/tg-webhook.mjs must be 404. Send `/crypto` on Telegram.
5. Read the credit counter again. Record the delta in Netlify_GitHub_Plan_28Oct2026 step 8: 0 means preview-then-publish is free; 15 means a publish counts as a deploy.
6. Push nothing new to Netlify. Commit the record to the repo.

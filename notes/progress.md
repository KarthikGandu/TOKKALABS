# Progress log

## Phase 1 - bootstrap (2026-11-23)
- [x] Read assignment PDF, summarized flows and required rejections
- [x] Chose Node 25 + Express 4, no other deps (child_process launcher instead of `concurrently`, built-in fetch)
- [x] Scaffolded `services/{alpaca,issuer,ap}`, `config.js`, `scripts/start-all.js`, `scripts/smoke.js`
- [x] Seeded data; read endpoints; AP page shows balances (buttons disabled)
- [x] `npm test`: 9/9 smoke checks pass, ports freed afterwards

## Phase 2 - mint (2026-11-23)
- [x] `lib/decimal.js` (BigInt 9-dp), `lib/http.js` (logged fetch)
- [x] Alpaca: mint endpoint, sync validation, share reservation, resumable `advance()` state machine, reconciler, callback endpoint (idempotent), rollback on rejected callback
- [x] Issuer: `/tokenization/mint` (validation, idempotent), `/mint/confirm` (credit once), callback delivery with retry, `/supply`, `/admin/faults`
- [x] AP: `POST /api/mint`, Mint form, request history with status/step/reason, 1s polling
- [x] `npm test`: 18/18 pass, 3 consecutive runs, ports freed. Covers: mint 2 AAPL, 5 rejection types, 9-dp boundary accepted, concurrent double-spend, confirm failing after shares moved, lost callback, replayed confirm/mint/callback, conservation

## Phase 3 - redeem (2026-11-23)
- [x] Issuer: `POST /tokenization/transfers` (validate, move tokens, tx hash, client_ref idempotency), burn-once, callback delivery with retry, redemption list/read
- [x] Alpaca: `POST .../callback/redeem` (dedupe on issuer_request_id), redeem branch in `advance()`, fault hooks
- [x] AP: `POST /api/redeem`, `GET /api/redemptions`, Redeem button + Issuer redemptions table
- [x] Mint behaviour preserved (all 18 mint-era checks still pass unchanged)
- [x] `npm test`: 27/27 pass, 3 consecutive runs. New: redeem 2 AAPLx, concurrent mint+redeem and mint->redeem round trip, over-balance + 5 other rejections, 3 callback failure scenarios, idempotency, final conservation
- [x] Hardening (2026-11-23): `callback_failed` record preserved + `retry-callback` recovery; `client_ref` required/deduped; UI double-click guard; 2 regression tests; `npm test` 29/29 x3
- [ ] Phase 4 (next)

## Not yet done
Extras (API key, Idempotency-Key, live log, `/accounts/connect`), verify payloads vs real guides, GitHub repo, prompt log, final "changed/rejected" note.

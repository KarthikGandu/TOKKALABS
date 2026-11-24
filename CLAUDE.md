# CLAUDE.md - Tokka Labs tokenization assignment

Local simulation of Alpaca's Instant Tokenization Network: three independent
Node.js/Express services talking over real HTTP. Assignment PDF is in the repo root.

## Commands
- `npm install` - once
- `npm start` - launches AP :3000, Alpaca :4000, Issuer :5000 (Ctrl+C stops all)
- `npm test` - starts everything, runs 33 checks (reads, mint, redeem, both flows together, rejections, callback failures, idempotency, conservation) over HTTP, stops everything
- `npm run start:ap|start:alpaca|start:issuer` - run one service alone

## Architecture rules (do not break)
1. Three separate processes; they communicate ONLY via HTTP. Never `require` one service from another.
2. Data ownership:
   - **Alpaca** owns share positions and tokenization request statuses.
   - **Issuer** owns token balances, wallets, AP registration, redemption wallet, tx hashes.
   - **AP** owns nothing; it reads from Alpaca (shares, requests) and Issuer (tokens).
3. All state is in memory. Restart resets to seed data.
4. `config.js` holds only ports and seed identifiers (shared constants, not shared state).
5. Follow Alpaca's documented paths/payloads; record every deviation in `notes/decisions.md`.
6. Shares and tokens must never be double-counted or lost: state changes are idempotent per `tokenization_request_id`.

## Mint flow (implemented, Phase 2)
AP `POST /api/mint` -> Alpaca `POST /v1/accounts/:id/tokenization/mint`:
1. Alpaca validates sync: fields, qty (positive, <=9 dp), issuer id; GETs Issuer `/tokenization/tokens` (token + network); checks shares **net of reservations** (check+record is atomic - no await between). Failure -> request stored `rejected` + reason, HTTP 422, nothing moves.
2. `advance()` state machine on the request (`step`): `submitted` -> Issuer `POST /tokenization/mint` (validates AP registered, wallet whitelisted, token/network, decimals; no tokens yet) -> `issuer_accepted` -> Alpaca moves shares AP->Issuer account (ONLY now) -> `shares_transferred` -> Issuer `POST /tokenization/mint/confirm` -> `confirm_sent`.
3. Issuer credits tokens exactly once (sync check `status==='accepted'` then credit, keyed on request id), fake tx hash, then calls Alpaca `.../callback/mint` in background with retry. Alpaca marks `completed`.
4. Issuer rejection at step 2 -> `rejected`, no shares moved. A `rejected` callback after shares moved -> shares returned to AP.
Statuses: `pending | completed | rejected`.

## Redeem flow (implemented, Phase 3)
AP `POST /api/redeem` -> Issuer `POST /tokenization/transfers` (own design; stands in for the on-chain transfer):
1. Issuer validates: wallet belongs to a registered AP, destination == redemption wallet, token/network supported, qty <=9 dp, balance sufficient. Failure -> record `rejected` + reason, HTTP 422, nothing moves. Success: debit AP wallet + credit redemption wallet (sync), fake tx hash, optional `client_ref` makes replays idempotent.
2. Background `processRedemption`: burn from the redemption wallet exactly once (`burned` flag, sync check-and-burn).
3. Issuer -> Alpaca `POST /v1/accounts/:id/tokenization/callback/redeem` (retried until 2xx, stops on 4xx). Alpaca dedupes on `issuer_request_id` (Alpaca creates its own `tokenization_request_id`), creates a `redeem` request (`pending/received`).
4. Alpaca `advance()` moves shares Issuer -> AP once and marks `completed`.
AP sees: Issuer-side redemption list (`/api/redemptions`: transferred/burned/notified/rejected) and the Alpaca request (pending/completed). Mint code paths are untouched (`r.type` branch only).
Permanent callback failure (Alpaca 4xx): Issuer sets `status=callback_failed`, `needs_attention=true`, KEEPS the burned record, stops retrying; recover with Issuer `POST /tokenization/redemptions/:id/retry-callback` (idempotent). Never delete redemption records.
Duplicate transfers: `client_ref` is required on `/tokenization/transfers` (registered synchronously; same key+params = replay, different params = 409).
Fault hooks: Issuer `drop_redeem_callback`; Alpaca `POST /admin/faults {fail_redeem_callback, lose_redeem_response, reject_redeem_callback}`.

## Optional extras (implemented, Phase 4)
- **X-API-KEY**: Issuer middleware (all but `/health`); key in `config.js` (`ISSUER_API_KEY`); `lib/http.js` `call()` attaches it to any URL on the Issuer port. New Issuer callers need nothing extra; raw curl/fetch must send the header.
- **Idempotency-Key** on Alpaca mint: `createMint()` returns `{status, body}`; route claims `idempotency` Map entry synchronously per `accountId:key` (fingerprint of body; mismatch 409; 503 not cached). AP sends a fresh key per click.
- **Live log**: `lib/http.js` ring buffer (300) -> `GET /logs` on Alpaca/Issuer -> AP `GET /api/logs` merges; `quiet:true` marks background polling (hidden unless `?polling=1`).
- **Account connect**: Issuer `POST /tokenization/accounts/connect` (idempotent); Alpaca calls it in `linkWithIssuer()` at startup.
- Mint confirm idempotency and step delay (`STEP_DELAY_MS`) were already in place.

## Failure handling
- Alpaca reconciler (every RETRY_MS/2) resumes pending requests idle >= RETRY_MS; Issuer retries undelivered callbacks. Peers are idempotent on `tokenization_request_id`, so retries cannot double-move shares or double-credit tokens.
- Test fault injection: Issuer `POST /admin/faults {fail_confirm:n, drop_callback:n}`.
- Env: `STEP_DELAY_MS` (default 300, visible transitions), `RETRY_MS` (default 1000). Tests use 50/300.

## Layout
- `services/{alpaca,issuer,ap}/server.js` - one file per service (AP also has `public/index.html`)
- `lib/decimal.js` (BigInt 9-dp fixed point; never use floats for qty), `lib/http.js` (logged fetch + sleep) - stateless helpers shared by all services
- `scripts/start-all.js` - one-command launcher; `scripts/smoke.js` - smoke tests
- `notes/` - `plan.md` (implementation plan), `progress.md` (log), `decisions.md` (choices/deviations)

## Seed data
AP account `ap-account-001`: 10 AAPL, 5 TSLA. Issuer custody `xstocks-custody-001`: 0/0.
Issuer `xstocks`: AAPLx, TSLAx on solana. AP `ap-001` registered with one whitelisted wallet (see config.js).

## Status
All phases done (bootstrap, mint, redeem, hardening, optional extras), 33/33 tests pass. Remaining deliverables outside the code: verify payloads vs real Alpaca guides, prompt log, final changed/rejected note, add interviewer as collaborator, make repo private.
Quantities are strings in JSON, BigInt units in memory.

## Verify after every change
```bash
npm test   # starts stack, runs all checks, stops
```

- `npm run demo` - scripted walkthrough (scripts/demo.sh) with expected values printed per step

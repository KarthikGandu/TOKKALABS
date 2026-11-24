# Implementation plan

## Phase 1 - Plan and bootstrap (DONE)
- Express services on 3000/4000/5000, in-memory state, one `npm start`
- Seeds: AP shares at Alpaca, Issuer tokens/AP registration/wallet
- Read endpoints + AP page showing balances; smoke tests (`npm test`)

## Phase 2 - Mint flow (DONE)
1. AP `POST /api/mint` -> Alpaca `POST /v1/accounts/:id/tokenization/mint` (returns request, status `pending`)
2. Alpaca validates: sufficient shares, decimals <= 9, then `GET issuer/tokenization/tokens` for token+network
3. Alpaca -> Issuer `POST /tokenization/mint`; Issuer validates AP registered + wallet whitelisted, replies accepted/rejected
4. Alpaca moves shares AP -> Issuer account, calls Issuer `POST /tokenization/mint/confirm`
5. Issuer credits tokens to AP wallet (idempotent on `tokenization_request_id`), calls Alpaca `POST .../callback/mint`
6. Alpaca marks `completed`; AP polls until `completed|rejected`
Failures at any step -> status `rejected` with `reason`, shown in UI. Shares only move after Issuer accepts; escrow/rollback if a later step fails.

## Phase 3 - Redeem flow (DONE)
1. AP -> Issuer transfer endpoint (own design, e.g. `POST /tokenization/transfers`) -> tx hash; reject if balance too low
2. Issuer burns tokens from redemption wallet
3. Issuer -> Alpaca `POST .../callback/redeem` (carries tx hash)
4. Alpaca moves shares Issuer -> AP, marks request `completed`

## Phase 4 - Hardening and extras
X-API-KEY on Issuer, Idempotency-Key on mint, idempotent confirm, step delays, live cross-service log on the page, e2e tests, final README + prompt log + "changed/rejected" note.

## Invariants to test
Total shares (AP + Issuer) constant at 15 AAPL-equivalent; token supply == shares held by Issuer per symbol; no double credit on repeated confirm.

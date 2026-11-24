# Tokenized Stock Mint & Redeem (Tokka Labs assignment)

Simulation of Alpaca's Instant Tokenization Network as three independent
Node.js + Express services using real HTTP calls and in-memory state.

> **Status: complete, including all optional extras.** Mint and redeem work end to end with validation, rejections and failure recovery. Extras: `X-API-KEY` on the Issuer, `Idempotency-Key` on mint, idempotent mint confirmations, step delays, live log on the page, and account connect at startup.

## Run
```bash
npm install
npm start      # AP http://localhost:3000, Alpaca :4000, Issuer :5000 (Ctrl+C stops)
npm test       # starts all services, runs 33 end-to-end checks, stops them
```
Requires Node 18+ (uses built-in `fetch`).

## Architecture
```mermaid
flowchart LR
    U([Browser])

    subgraph APS["AP - localhost:3000"]
        APN["Web page and backend<br/>owns no balances"]
    end

    subgraph ALS["Alpaca - localhost:4000"]
        ALN["Owns share positions<br/>and request statuses"]
    end

    subgraph ISS["Issuer xstocks - localhost:5000"]
        ISN["Owns token ledger, AP registry,<br/>whitelisted wallets,<br/>redemption wallet, tx hashes"]
    end

    U -->|"HTML and api calls"| APN
    APN -->|"mint, request lookup, share balances"| ALN
    APN -->|"token balances, transfer to redemption wallet"| ISN
    ALN -->|"tokens list, mint, mint confirm"| ISN
    ISN -->|"callbacks for mint and redeem"| ALN
```

Three separate processes talking only over HTTP. The Issuer requires a static `X-API-KEY` on every endpoint except `/health`. Each service keeps its own in-memory data and never reads another's.
| Service | Port | Owns | Phase 1 endpoints |
|---|---|---|---|
| AP | 3000 | nothing (UI + client) | `GET /`, `/api/config`, `/api/balances`, `/api/requests`, `POST /api/mint`, `POST /api/redeem`, `GET /api/redemptions`, `GET /api/logs` |
| Alpaca | 4000 | share positions, request statuses | `GET /v1/accounts/:id`, `.../positions`, `GET /logs`, `POST .../tokenization/mint` (Idempotency-Key), `GET .../tokenization/requests[/:rid]`, `POST .../tokenization/callback/mint`, `POST .../tokenization/callback/redeem`, test hook `POST /admin/faults` |
| Issuer | 5000 | token ledger, AP registry, redemption wallet, mint records | `GET /tokenization/tokens`, `POST /tokenization/accounts/connect`, `GET /logs`, `POST /tokenization/mint`, `POST /tokenization/mint/confirm`, own-design `POST /tokenization/transfers`, `GET /tokenization/redemptions[/:id]`, `POST /tokenization/redemptions/:id/retry-callback`, plus reads `/tokenization/{issuer,aps/:id,wallets/:addr/balances,supply,mint/:id}` and test hook `POST /admin/faults` |

Every service also exposes `GET /health`. All Issuer endpoints except `/health` need `X-API-KEY`.

## Mint flow
```mermaid
sequenceDiagram
    autonumber
    participant AP as AP :3000
    participant AL as Alpaca :4000
    participant IS as Issuer :5000
    AP->>AL: POST /v1/accounts/:id/tokenization/mint
    AL->>IS: GET /tokenization/tokens
    IS-->>AL: supported tokens and networks
    Note over AL: validate qty (max 9 dp), token, network,<br/>shares net of reservations
    AL-->>AP: pending (or 422 rejected with reason)
    AL->>IS: POST /tokenization/mint
    Note over IS: AP registered? wallet whitelisted?<br/>no tokens issued yet
    IS-->>AL: accepted (or 422 rejected)
    Note over AL: move shares AP to Issuer account<br/>only after both validations
    AL->>IS: POST /tokenization/mint/confirm
    Note over IS: credit tokens exactly once,<br/>fake tx hash
    IS->>AL: POST /v1/accounts/:id/tokenization/callback/mint
    Note over AL: status completed
    AP->>AL: poll requests until completed or rejected
```
Statuses: `pending` -> `completed` | `rejected` (with a `reason`). Each request also carries a `step` and an `events` audit trail.

**Rejections** (visible in the AP page and in `GET .../tokenization/requests`): insufficient shares, unsupported token, unsupported network, invalid / more than 9 decimal places quantity (rejected synchronously with HTTP 422); unregistered / non-whitelisted wallet (rejected by the Issuer, so request goes `pending` -> `rejected`, no shares move).

**Safety properties**
- Shares are reserved when a request is accepted (concurrent mints cannot spend the same shares) and move only after the Issuer accepts.
- Tokens are credited exactly once per `tokenization_request_id`; repeated confirm/callback calls are no-ops.
- Partial failure: the request stays `pending` with its `step`, `attempts` and `last_error`; Alpaca's reconciler and the Issuer's callback retry resume it. A `rejected` callback after shares moved returns the shares to the AP.
- Quantities use BigInt fixed point (9 dp), never floats.

## Redeem flow
```mermaid
sequenceDiagram
    autonumber
    participant AP as AP :3000
    participant IS as Issuer :5000
    participant AL as Alpaca :4000
    AP->>IS: POST /tokenization/transfers (client_ref)
    Note over IS: validate wallet, destination, token,<br/>network, 9 dp, balance
    Note over IS: move tokens AP wallet to redemption wallet
    IS-->>AP: tx hash (or 422 rejected with reason)
    Note over IS: burn tokens from redemption wallet, once
    IS->>AL: POST /v1/accounts/:id/tokenization/callback/redeem
    Note over AL: create redeem request,<br/>dedupe on issuer_request_id
    Note over AL: move shares Issuer to AP, once
    Note over AL: status completed
    AP->>AL: poll requests, balances updated
```
`POST /tokenization/transfers` body: `{from_wallet, to_wallet, token_symbol, qty, network, client_ref}` -> `{status, redemption_id, tx_hash}` (or 422 `{status:'rejected', reason}`).
Issuer redemption status: `transferred` -> `burned` -> `notified` (or `rejected`, or `callback_failed` after a permanent callback error). Alpaca request status: `pending` -> `completed`.

**Redeem rejections:** more tokens than the wallet holds, unsupported token/network, more than 9 decimals, wallet not a registered AP's, destination not the redemption wallet. All return 422 with a reason and appear in the AP page's "Redemptions at Issuer" table.

**Callback failure recovery (tested):** (a) Issuer drops the callback after burning: tokens stay burned once, shares wait, Issuer retries, shares returned once. (b) Alpaca fails before processing: Issuer retries. (c) Alpaca processes but the response is lost: the retry is deduped on `issuer_request_id`, so shares are returned once.

## Permanent redeem-callback failure: record preservation and recovery runbook
If Alpaca answers the Issuer's redeem callback with a 4xx (permanent: bad payload, unknown account, ...), the Issuer **stops retrying but keeps the redemption record** (tokens are already burned, the tx hash and payload are retained):
`status: "callback_failed"`, `needs_attention: true`, `callback_error: "alpaca returned 422: ..."`, `burned: true`. It shows in the AP page ("NEEDS ATTENTION") and in `GET /tokenization/redemptions?wallet=...`. Shares are not returned yet, and nothing is lost.

Recovery (after fixing the cause):
```bash
# 1. find stuck redemptions
curl -s localhost:5000/tokenization/redemptions | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).filter(r=>r.needs_attention)))"
# 2. re-send the callback (idempotent; Alpaca dedupes on issuer_request_id, burn is never repeated)
curl -s -X POST localhost:5000/tokenization/redemptions/<id>/retry-callback
```
-> `202`, Issuer record becomes `notified`, Alpaca creates the redeem request and returns the shares exactly once. Repeating the retry returns `200 {idempotent:true}`. Transient failures (network errors, 5xx) retry automatically and need no manual step.

**Duplicate transfer prevention:** `POST /tokenization/transfers` requires `client_ref` (idempotency key; 400 if missing). The same key returns the original result and tx hash without moving tokens again, including concurrent duplicates; the same key with different parameters returns 409. The AP page sends a fresh key per click and disables the button while a request is in flight. Note a replayed *rejected* transfer returns the same rejection for that key.

### Status lifecycles
Alpaca request (what the AP polls):
```mermaid
stateDiagram-v2
    [*] --> pending
    pending --> completed: settled
    pending --> rejected: validation or issuer rejection
    completed --> [*]
    rejected --> [*]
```
Issuer redemption record:
```mermaid
stateDiagram-v2
    [*] --> transferred: tokens moved to redemption wallet
    [*] --> refused: validation failed
    transferred --> burned: burn once
    burned --> notified: redeem callback delivered
    burned --> callback_failed: permanent 4xx, record kept
    callback_failed --> burned: retry-callback
    notified --> [*]
```

## Optional extras (all implemented)
| Extra | How it works | Where it is tested |
|---|---|---|
| **X-API-KEY on Issuer** | Static key (`issuer-secret-key`, override with env `ISSUER_API_KEY`) required on every Issuer endpoint except `GET /health`; missing or wrong key returns 401. Alpaca and the AP send it automatically (`lib/http.js` attaches it to calls aimed at the Issuer). | `X-API-KEY` check |
| **Idempotency-Key on mint** | Optional header on Alpaca's mint endpoint, scoped per account. The key is claimed synchronously, so concurrent duplicates share one request. Same key + same body replays the original request (live status, header `Idempotent-Replay: true`); same key + different body returns 409; transient 503s are not cached. The AP page sends a fresh key per click. | `IDEMPOTENCY-KEY on mint` |
| **Idempotent mint confirmation** | `POST /tokenization/mint/confirm` credits tokens once per `tokenization_request_id`; repeats return the original result and tx hash (credit is a synchronous check-and-credit). | `IDEMPOTENCY: repeated confirm...` |
| **Step delay** | `STEP_DELAY_MS` (default 300 ms) between steps so `pending -> issuer_accepted -> shares_transferred -> confirm_sent -> completed` is visible; `RETRY_MS` (default 1000) sets retry cadence. | all flow tests (run at 50 ms) |
| **Live log on the page** | Every cross-service call is recorded in a per-process ring buffer (`GET /logs` on Alpaca and Issuer). The AP merges them by time at `GET /api/logs` and the page shows them under "Live cross-service log" (background polling hidden unless ticked). | `LIVE LOG` |
| **Account connect** | Issuer `POST /tokenization/accounts/connect` (idempotent). Alpaca calls it at startup for the AP's account (retrying while the Issuer boots): already linked returns 200 `already_connected`, a new account returns 201, a wallet already whitelisted for another AP returns 409. | `ACCOUNT CONNECT` |

## Seed data
- Alpaca: AP account `ap-account-001` = 10 AAPL, 5 TSLA; Issuer custody `xstocks-custody-001` = 0 AAPL, 0 TSLA
- Issuer `xstocks`: tokens AAPLx, TSLAx on `solana`; AP `ap-001` registered with one whitelisted wallet; redemption wallet exists
- AP token balances start at 0 (tokens only exist after a mint). Account linking is treated as already done.

## Assumptions / deviations so far
- Issuer read endpoints, `/tokenization/supply`, and `/admin/faults` are my own design (not in Alpaca docs).
- Mint request/payload field names (`underlying_symbol`, `token_symbol`, `qty`, `network`, `wallet_address`, `issuer_id`, `account_id`) are from memory of the guides, NOT yet verified against them.
- Redeem: Alpaca creates the redeem request when the Issuer's callback arrives (so it is not visible at Alpaca before the burn); Alpaca generates its own `tokenization_request_id` and dedupes on the Issuer's `issuer_request_id`. This and the callback payload are my design, unverified against the guides.
- Validation rejections return HTTP 422 with the stored request (status `rejected`) instead of a bare error, so the AP history shows them.
- The Issuer API key is a static shared secret in `config.js` (a simulation, not real auth); `/logs` and `/admin/faults` sit behind the same key. Alpaca's own endpoints are not key-protected.
- Env `STEP_DELAY_MS` (300) / `RETRY_MS` (1000) control visible transitions and retry cadence.
- Alpaca response shapes for accounts/positions are simplified from the real Trading API.
- Details: `notes/decisions.md`. Plan: `notes/plan.md`. Log: `notes/progress.md`.

## One-command demo (no extra terminals)
```bash
npm run demo   # starts the stack, runs mint, redeem, rejections, failure recovery and the extras, prints each step, stops
```
For the live log in the browser run `npm start`, open http://localhost:3000, press Mint or Redeem and watch the "Live cross-service log" panel.

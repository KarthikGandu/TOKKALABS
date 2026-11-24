# Decisions and deviations

| # | Decision | Why |
|---|---|---|
| 1 | Express 4 + built-in `fetch`, zero extra deps | Minimal install, fast to run |
| 2 | `npm start` spawns three child processes via `scripts/start-all.js` | One command, but services stay truly independent processes |
| 3 | `config.js` shares ports/ids only | Seed identifiers must agree; no shared state |
| 4 | Account linking treated as already done (seeded) | Allowed by assignment; `/accounts/connect` can be added later |
| 5 | AP token balance starts at 0 | Tokens only exist after minting; keeps share/token conservation checkable |
| 6 | Issuer read endpoints (`/tokenization/aps/:id`, `/wallets/:addr/balances`, `/tokenization/issuer`) | Not in Alpaca docs; own design |
| 7 | Alpaca account/positions shapes simplified | Only need symbol/qty |
| 8 | Alpaca request routes `GET .../tokenization/requests[/:id]` | Follows documented AP lookup pattern; verify against guide in Phase 2 (I did not fetch the guides yet) |
| 9 | `npm test` boots the stack itself and kills the process group | Self-contained smoke test |

| 10 | Quantities are BigInt units (9 dp) in memory, strings in JSON | No float drift; 9-dp rule is exact |
| 11 | Shares are *reserved* at accept time (available = held - pending untransferred mints) | Two concurrent mints cannot double-spend; check+insert has no `await` between |
| 12 | Validation rejections stored and returned as 422 + request body | Rejection visible in AP history with a reason |
| 13 | Wallet/AP registration checked by Issuer at `POST /tokenization/mint` (not by Alpaca) | Issuer owns its registry; Alpaca never sees it |
| 14 | Shares move only after Issuer accepts; tokens credited only on `/mint/confirm` | Matches required sequencing |
| 15 | Request carries `step` and is advanced by an idempotent state machine + reconciler | Recoverable after peer failure without manual cleanup |
| 16 | Issuer retries callback until 2xx (stops on 4xx); no retry cap | Simple; a real system would add backoff/alerting |
| 17 | `rejected` callback after shares moved returns shares to AP | Shares never stranded |
| 18 | `POST /admin/faults` on Issuer injects confirm failures / dropped callbacks | Needed to test partial failure deterministically; would be removed/guarded in prod |
| 19 | AP `/api/mint` accepts optional network/wallet/token overrides | Lets rejection cases be exercised through the AP; UI doesn't expose them |
| 20 | Redeem transfer endpoint `POST /tokenization/transfers` (own design) validates AND moves tokens synchronously, burns async | Mirrors an on-chain transfer returning a tx hash; burn happens as a separate Issuer step |
| 21 | Alpaca creates the redeem request only on the Issuer callback, keyed on `issuer_request_id` | Alpaca has no earlier knowledge of the redemption; dedupe makes callback retries safe |
| 22 | Rejected redeems are recorded at the Issuer (not Alpaca) and shown via `/api/redemptions` | Rejection happens before Alpaca is involved; Issuer owns that data |
| 23 | Alpaca 4xx on redeem callback stops Issuer retries, sets `callback_failed` + `needs_attention`, keeps the burned record; manual `retry-callback` recovers | Avoid infinite retry on a permanent error without losing the AP's burned tokens (gap from Phase 3 now closed) |
| 25 | `client_ref` required on `/tokenization/transfers`; fingerprint mismatch -> 409; registered synchronously | Duplicate transfers (double click, client retry, concurrent) cannot move tokens twice |
| 26 | No automatic retry of permanent failures | A 4xx will not fix itself; a human must correct the cause, then call retry-callback |
| 24 | If share return fails at Alpaca the redeem request stays `pending` and retries instead of rejecting | Tokens are already burned; rejecting would lose the AP's value |

## Reviewed / rejected while building
- First reservation idea (check after fetching tokens, set later) had an await gap; restructured so check and `requests.set` are synchronous.
- Considered Alpaca verifying wallet whitelist itself: rejected, breaks data ownership.
- Considered rolling back shares on Issuer 5xx during confirm: rejected; instead retry, since the Issuer may already have credited. Rollback only on an explicit `rejected` callback.

- Considered auto-refunding tokens (re-minting) on permanent callback failure: rejected, would change token supply from a failure path; keep the record and let an operator retry.
- Redeem: considered burning inside the transfer call; rejected, kept as a separate async step so a failure between transfer and burn is representable and recoverable.
- Test bug found and fixed: a rejection from a foreign wallet is correctly absent from the AP's redemption history; assertion now skips that case.

## Open items
- Verify exact Alpaca payload field names against the AP and Issuer guides (still not done; Phase 2 used my best recollection).
- Issuer rejection of a mint with a 'completed' callback never carries `rejected` in the current Issuer; the rollback path in Alpaca is implemented but untested end to end.
- Token decimals set to 9 on each supported token to match the 9-decimal rule.

// Alpaca (localhost:4000) - owns brokerage accounts, share positions and
// tokenization request statuses. Orchestrates the mint flow as a resumable
// state machine (request.step) so partial failures can be retried safely.
const crypto = require('crypto');
const express = require('express');
const { PORTS, URLS, IDS } = require('../../config');
const D = require('../../lib/decimal');
const { call, sleep, recent } = require('../../lib/http');

const STEP_DELAY = Number(process.env.STEP_DELAY_MS ?? 300);
const RETRY_MS = Number(process.env.RETRY_MS ?? 1000);

// ---- in-memory state (owned exclusively by Alpaca); quantities are BigInt units ----
const accounts = new Map([
  [IDS.AP_ACCOUNT, { id: IDS.AP_ACCOUNT, owner: 'AP', status: 'ACTIVE', positions: { AAPL: 10n * D.ONE, TSLA: 5n * D.ONE } }],
  [IDS.ISSUER_ACCOUNT, { id: IDS.ISSUER_ACCOUNT, owner: 'Issuer (xstocks)', status: 'ACTIVE', positions: { AAPL: 0n, TSLA: 0n } }],
]);
const requests = new Map(); // tokenization_request_id -> request
const inflight = new Set(); // request ids currently being advanced (no concurrent runs)
const byIssuerRequest = new Map(); // issuer_request_id -> tokenization_request_id (redeem dedupe)
const faults = { fail_redeem_callback: 0, lose_redeem_response: 0, reject_redeem_callback: 0 }; // test-only fault injection

const toPositions = (a) =>
  Object.entries(a.positions).map(([symbol, q]) => ({ symbol, qty: D.format(q), asset_class: 'us_equity' }));

// Atomic share transfer (synchronous => no interleaving). Throws if insufficient.
function moveShares(from, to, symbol, units) {
  const src = accounts.get(from), dst = accounts.get(to);
  if ((src.positions[symbol] ?? 0n) < units) throw new Error(`insufficient ${symbol} in ${from}`);
  src.positions[symbol] -= units;
  dst.positions[symbol] = (dst.positions[symbol] ?? 0n) + units;
}

// Shares promised to in-flight mints that have not physically moved yet.
function reserved(accountId, symbol) {
  let sum = 0n;
  for (const r of requests.values())
    if (r.account_id === accountId && r.type === 'mint' && r.status === 'pending' && !r.shares_transferred && r.underlying_symbol === symbol)
      sum += D.parse(r.qty);
  return sum;
}

function event(r, msg) {
  r.updated_at = Date.now();
  r.events.push({ at: new Date().toISOString(), event: msg });
  console.log(`[alpaca] ${r.tokenization_request_id.slice(0, 8)} ${r.status}/${r.step}: ${msg}`);
}

function reject(r, reason) {
  if (r.shares_transferred && !r.shares_returned) { // roll back so shares are never lost
    moveShares(IDS.ISSUER_ACCOUNT, r.account_id, r.underlying_symbol, D.parse(r.qty));
    r.shares_returned = true;
    event(r, 'shares returned to AP');
  }
  r.status = 'rejected'; r.step = 'rejected'; r.reason = reason;
  event(r, `REJECTED: ${reason}`);
}

// Drive one request forward. Safe to call repeatedly: every step is guarded by
// state flags and the peer calls are idempotent on tokenization_request_id.
async function advance(id) {
  if (inflight.has(id)) return;
  inflight.add(id);
  const r = requests.get(id);
  try {
    while (r.status === 'pending') {
      await sleep(STEP_DELAY);
      if (r.status !== 'pending') return;
      if (r.type === 'redeem') { // step 'received': tokens already burned by Issuer -> return shares once
        moveShares(IDS.ISSUER_ACCOUNT, r.account_id, r.underlying_symbol, D.parse(r.qty)); // throws -> retried
        r.shares_transferred = true; r.status = 'completed'; r.step = 'completed'; r.last_error = null;
        event(r, `COMPLETED: returned ${r.qty} ${r.underlying_symbol} issuer -> AP`);
        return;
      }
      if (r.step === 'submitted') {
        // Issuer validates AP registration + wallet whitelist + token/network
        const res = await call('alpaca', 'POST', `${URLS.issuer}/tokenization/mint`, {
          tokenization_request_id: id, issuer_id: r.issuer_id, account_id: r.account_id,
          underlying_symbol: r.underlying_symbol, token_symbol: r.token_symbol, qty: r.qty,
          network: r.network, wallet_address: r.wallet_address,
        });
        if (res.status === 422) return reject(r, res.body?.reason || 'rejected by issuer');
        if (!res.ok) throw new Error(`issuer /tokenization/mint returned ${res.status}`);
        r.step = 'issuer_accepted'; event(r, 'issuer accepted mint');
      } else if (r.step === 'issuer_accepted') {
        // Only now (after validation by both sides) do shares physically move.
        try { moveShares(r.account_id, IDS.ISSUER_ACCOUNT, r.underlying_symbol, D.parse(r.qty)); }
        catch (e) { return reject(r, e.message); }
        r.shares_transferred = true; r.step = 'shares_transferred';
        event(r, `moved ${r.qty} ${r.underlying_symbol} AP -> issuer account`);
      } else { // shares_transferred | confirm_sent: (re)send confirm; Issuer credits exactly once
        const res = await call('alpaca', 'POST', `${URLS.issuer}/tokenization/mint/confirm`, { tokenization_request_id: id });
        if (!res.ok) throw new Error(`issuer /tokenization/mint/confirm returned ${res.status}`);
        if (r.status === 'pending') { r.step = 'confirm_sent'; event(r, 'confirm acknowledged; awaiting issuer callback'); }
        return;
      }
      r.last_error = null;
    }
  } catch (e) {
    r.attempts += 1; r.last_error = e.message;
    event(r, `step failed (attempt ${r.attempts}), will retry: ${e.message}`);
  } finally {
    inflight.delete(id);
  }
}

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ service: 'alpaca', status: 'ok' }));
app.get('/logs', (_req, res) => res.json(recent())); // cross-service calls made by Alpaca (live log)

app.get('/v1/accounts/:account_id', (req, res) => {
  const a = accounts.get(req.params.account_id);
  if (!a) return res.status(404).json({ message: 'account not found' });
  res.json({ id: a.id, owner: a.owner, status: a.status, positions: toPositions(a) });
});

app.get('/v1/accounts/:account_id/positions', (req, res) => {
  const a = accounts.get(req.params.account_id);
  if (!a) return res.status(404).json({ message: 'account not found' });
  res.json(toPositions(a));
});

// Creates a mint request. Returns { status, body } so the route can wrap it with Idempotency-Key handling.
async function createMint(accountId, b) {
  const underlying = b.underlying_symbol;
  const r = {
    tokenization_request_id: crypto.randomUUID(), type: 'mint', status: 'pending', step: 'submitted',
    account_id: accountId, issuer_id: b.issuer_id || IDS.ISSUER_ID, underlying_symbol: underlying,
    token_symbol: b.token_symbol || (underlying ? `${underlying}x` : undefined),
    qty: b.qty == null ? undefined : String(b.qty), network: b.network, wallet_address: b.wallet_address,
    issuer_tx_hash: null, reason: null, shares_transferred: false, shares_returned: false,
    attempts: 0, last_error: null, created_at: new Date().toISOString(), updated_at: Date.now(), events: [],
  };
  const refuse = (reason) => { // validation rejection: recorded, visible to AP, no state change
    requests.set(r.tokenization_request_id, r);
    r.status = 'rejected'; r.step = 'rejected_at_validation'; r.reason = reason;
    event(r, `REJECTED at validation: ${reason}`);
    return { status: 422, body: r };
  };

  // 1. synchronous input validation
  if (!underlying || !r.network || !r.wallet_address || r.qty === undefined)
    return refuse('missing required field (underlying_symbol, qty, network, wallet_address)');
  let units;
  try { units = D.parse(r.qty); } catch (e) { return refuse(e.message); }
  r.qty = D.format(units);
  if (r.issuer_id !== IDS.ISSUER_ID) return refuse(`unknown issuer ${r.issuer_id}`);

  // 2. token/network check against the Issuer
  let tokens;
  try {
    const t = await call('alpaca', 'GET', `${URLS.issuer}/tokenization/tokens`);
    if (!t.ok) throw new Error(`status ${t.status}`);
    tokens = t.body;
  } catch (e) {
    return { status: 503, body: { message: `issuer unavailable: ${e.message}` } };
  }
  // From here to requests.set() there is no await, so the share check and the
  // reservation are atomic (two concurrent mints cannot both spend the same shares).
  const named = tokens.filter((t) => t.symbol === r.token_symbol && t.underlying === underlying);
  if (!named.length) return refuse(`unsupported token ${r.token_symbol} for ${underlying}`);
  if (!named.some((t) => t.network === r.network)) return refuse(`unsupported network ${r.network} for ${r.token_symbol}`);

  // 3. share balance (net of shares reserved by in-flight mints)
  const held = accounts.get(accountId).positions[underlying] ?? 0n;
  const available = held - reserved(accountId, underlying);
  if (available < units) return refuse(`insufficient ${underlying} shares: requested ${r.qty}, available ${D.format(available)}`);

  requests.set(r.tokenization_request_id, r);
  event(r, `accepted: validated ${r.qty} ${underlying} (${r.token_symbol} on ${r.network})`);
  setImmediate(() => advance(r.tokenization_request_id));
  return { status: 200, body: r };
}

// Idempotency-Key -> { fingerprint, promise }, scoped per account. The entry is claimed
// synchronously, so concurrent duplicates await the same creation instead of creating twice.
const idempotency = new Map();

// AP-facing: create a mint request (optional Idempotency-Key header)
app.post('/v1/accounts/:account_id/tokenization/mint', async (req, res) => {
  const accountId = req.params.account_id;
  if (!accounts.has(accountId)) return res.status(404).json({ message: 'account not found' });
  const b = req.body || {};
  try {
    const key = req.get('Idempotency-Key');
    if (!key) { const out = await createMint(accountId, b); return res.status(out.status).json(out.body); }
    const id = `${accountId}:${key}`;
    const fingerprint = JSON.stringify([b.underlying_symbol, String(b.qty), b.token_symbol, b.network, b.wallet_address, b.issuer_id]);
    let entry = idempotency.get(id);
    if (entry && entry.fingerprint !== fingerprint) return res.status(409).json({ message: 'Idempotency-Key reused with a different request body' });
    const replay = !!entry;
    if (!entry) { entry = { fingerprint, promise: createMint(accountId, b) }; idempotency.set(id, entry); }
    const out = await entry.promise;
    if (out.status === 503) idempotency.delete(id); // transient: the client may retry with the same key
    res.set('Idempotent-Replay', String(replay)).status(out.status).json(out.body);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.get('/v1/accounts/:account_id/tokenization/requests', (req, res) => {
  if (!accounts.has(req.params.account_id)) return res.status(404).json({ message: 'account not found' });
  res.json([...requests.values()].filter((r) => r.account_id === req.params.account_id).reverse());
});

app.get('/v1/accounts/:account_id/tokenization/requests/:request_id', (req, res) => {
  const r = requests.get(req.params.request_id);
  if (!r || r.account_id !== req.params.account_id) return res.status(404).json({ message: 'request not found' });
  res.json(r);
});

// Issuer-facing: mint completion callback (idempotent on tokenization_request_id)
app.post('/v1/accounts/:account_id/tokenization/callback/mint', (req, res) => {
  const b = req.body || {};
  const r = requests.get(b.tokenization_request_id);
  if (!r || r.account_id !== req.params.account_id || r.type !== 'mint') return res.status(404).json({ message: 'request not found' });
  if (r.status !== 'pending') { // repeat delivery
    return b.status === r.status ? res.json({ idempotent: true, status: r.status })
      : res.status(409).json({ message: `request already ${r.status}` });
  }
  if (b.status === 'completed') {
    if (!r.shares_transferred) return res.status(409).json({ message: 'shares not transferred yet' });
    r.status = 'completed'; r.step = 'completed'; r.issuer_tx_hash = b.issuer_tx_hash || null; r.last_error = null;
    event(r, `COMPLETED: issuer credited tokens (tx ${r.issuer_tx_hash})`);
    return res.json({ status: 'completed' });
  }
  if (b.status === 'rejected') { reject(r, b.reason || 'rejected by issuer'); return res.json({ status: 'rejected' }); }
  res.status(400).json({ message: 'status must be completed or rejected' });
});

// Issuer-facing: tokens were transferred to the redemption wallet and burned; create the
// redeem request and return the shares. Idempotent on issuer_request_id (retries are safe).
app.post('/v1/accounts/:account_id/tokenization/callback/redeem', (req, res) => {
  if (faults.fail_redeem_callback > 0) { faults.fail_redeem_callback--; console.log('[alpaca] FAULT: failing redeem callback'); return res.status(503).json({ message: 'injected fault' }); }
  if (faults.reject_redeem_callback > 0) { faults.reject_redeem_callback--; console.log('[alpaca] FAULT: permanently rejecting redeem callback'); return res.status(422).json({ reason: 'injected permanent failure' }); }
  const accountId = req.params.account_id;
  if (!accounts.has(accountId) || accountId === IDS.ISSUER_ACCOUNT) return res.status(404).json({ message: 'account not found' });
  const b = req.body || {};
  const prior = byIssuerRequest.get(b.issuer_request_id);
  if (prior) return res.json(requests.get(prior)); // replay: no second share movement
  const bad = (reason) => res.status(422).json({ reason });
  if (!b.issuer_request_id || !b.tx_hash) return bad('issuer_request_id and tx_hash are required');
  let units;
  try { units = D.parse(b.qty); } catch (e) { return bad(e.message); }
  if (!(b.underlying_symbol in accounts.get(accountId).positions)) return bad(`unknown underlying ${b.underlying_symbol}`);
  const r = {
    tokenization_request_id: crypto.randomUUID(), issuer_request_id: b.issuer_request_id, type: 'redeem', status: 'pending', step: 'received',
    account_id: accountId, issuer_id: IDS.ISSUER_ID, underlying_symbol: b.underlying_symbol, token_symbol: b.token_symbol,
    qty: D.format(units), network: b.network, wallet_address: b.wallet_address, issuer_tx_hash: b.tx_hash, reason: null,
    shares_transferred: false, shares_returned: false, attempts: 0, last_error: null, created_at: new Date().toISOString(), updated_at: Date.now(), events: [],
  };
  requests.set(r.tokenization_request_id, r);
  byIssuerRequest.set(b.issuer_request_id, r.tokenization_request_id);
  event(r, `redeem callback received: ${r.qty} ${r.token_symbol} burned (tx ${b.tx_hash.slice(0, 12)}...)`);
  setImmediate(() => advance(r.tokenization_request_id));
  if (faults.lose_redeem_response > 0) { faults.lose_redeem_response--; console.log('[alpaca] FAULT: processed redeem but losing response'); return res.status(503).json({ message: 'injected fault (response lost)' }); }
  res.json(r);
});

app.post('/admin/faults', (req, res) => {
  for (const k of Object.keys(faults)) if (req.body?.[k] !== undefined) faults[k] = Number(req.body[k]);
  res.json(faults);
});

// Startup step: link the AP's account with the Issuer (POST /tokenization/accounts/connect).
// Retries because the services start concurrently. Idempotent on the Issuer side.
async function linkWithIssuer() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await call('alpaca', 'POST', `${URLS.issuer}/tokenization/accounts/connect`, { account_id: IDS.AP_ACCOUNT, wallet_address: IDS.AP_WALLET });
      if (r.ok) return console.log(`[alpaca] account link with issuer: ${r.body.status}`);
    } catch { /* issuer not up yet */ }
    await sleep(250);
  }
  console.log('[alpaca] WARNING: could not link account with issuer');
}

if (require.main === module) {
  app.listen(PORTS.alpaca, () => { console.log(`[alpaca] listening on :${PORTS.alpaca}`); linkWithIssuer(); });
  // Reconciler: resume any request stuck mid-flow (peer was down, call failed).
  setInterval(() => {
    for (const r of requests.values())
      if (r.status === 'pending' && !inflight.has(r.tokenization_request_id) && Date.now() - r.updated_at >= RETRY_MS)
        advance(r.tokenization_request_id);
  }, Math.max(100, RETRY_MS / 2));
}
module.exports = app;

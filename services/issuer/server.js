// Issuer "xstocks" (localhost:5000) - owns the token ledger: registered APs,
// whitelisted wallets, token balances, mint records and fake tx hashes.
const crypto = require('crypto');
const express = require('express');
const { PORTS, URLS, IDS } = require('../../config');
const D = require('../../lib/decimal');
const { call, sleep } = require('../../lib/http');

const RETRY_MS = Number(process.env.RETRY_MS ?? 1000);
const STEP_DELAY = Number(process.env.STEP_DELAY_MS ?? 300);

// ---- in-memory state (owned exclusively by the Issuer); token quantities are BigInt units ----
const issuer = { id: IDS.ISSUER_ID, name: 'xstocks', alpaca_account_id: IDS.ISSUER_ACCOUNT, redemption_wallet: IDS.REDEMPTION_WALLET };
const supportedTokens = [
  { symbol: 'AAPLx', underlying: 'AAPL', network: 'solana', decimals: 9 },
  { symbol: 'TSLAx', underlying: 'TSLA', network: 'solana', decimals: 9 },
];
const aps = new Map([
  [IDS.AP_ID, { id: IDS.AP_ID, alpaca_account_id: IDS.AP_ACCOUNT, status: 'REGISTERED', wallets: [IDS.AP_WALLET] }],
]);
const wallets = new Map([
  [IDS.AP_WALLET, { AAPLx: 0n, TSLAx: 0n }],
  [IDS.REDEMPTION_WALLET, { AAPLx: 0n, TSLAx: 0n }],
]);
// tokenization_request_id -> { status: accepted|rejected|credited, ... }. Source of truth for idempotency.
const mints = new Map();
// Test-only fault injection (simulates partial failures): see POST /admin/faults
const faults = { fail_confirm: 0, drop_callback: 0, drop_redeem_callback: 0 };
// Redemptions: issuer_request_id -> { status: transferred|burned|notified|rejected, ... }
const redemptions = new Map();
const clientRefs = new Map(); // client_ref -> redemption id (idempotent transfers)

const fmtBalances = (w) => Object.fromEntries(Object.entries(w).map(([k, v]) => [k, D.format(v)]));
const fakeTxHash = () => '0x' + crypto.randomBytes(32).toString('hex');
const pubRedemption = ({ delivering, units, fingerprint, ...r }) => ({ ...r, qty: D.format(units) });

// Redeem step 2+3: burn (once), then notify Alpaca until delivered.
async function processRedemption(rec) {
  await sleep(STEP_DELAY);
  if (!rec.burned) { // sync check-and-burn => burned exactly once
    const redemptionWallet = wallets.get(IDS.REDEMPTION_WALLET);
    if (redemptionWallet[rec.token_symbol] < rec.units) { rec.callback_error = 'redemption wallet short of tokens'; return; }
    redemptionWallet[rec.token_symbol] -= rec.units;
    rec.burned = true; rec.status = 'burned';
    console.log(`[issuer] burned ${D.format(rec.units)} ${rec.token_symbol} (redemption ${rec.id.slice(0, 8)})`);
  }
  await deliverRedeemCallback(rec);
}

// Tell Alpaca to return the shares. Retried until delivered; Alpaca dedupes on issuer_request_id.
async function deliverRedeemCallback(rec) {
  if (rec.callback_delivered || rec.delivering) return;
  rec.delivering = true;
  try {
    for (;;) {
      if (faults.drop_redeem_callback > 0) { faults.drop_redeem_callback--; console.log('[issuer] FAULT: dropping redeem callback'); await sleep(RETRY_MS); continue; }
      try {
        const r = await call('issuer', 'POST', `${URLS.alpaca}/v1/accounts/${rec.account_id}/tokenization/callback/redeem`, {
          issuer_request_id: rec.id, tx_hash: rec.tx_hash, underlying_symbol: rec.underlying_symbol,
          token_symbol: rec.token_symbol, qty: D.format(rec.units), network: rec.network, wallet_address: rec.from_wallet,
        });
        if (r.ok) { rec.callback_delivered = true; rec.status = 'notified'; rec.alpaca_request_id = r.body?.tokenization_request_id; return; }
        if (r.status >= 400 && r.status < 500) { // permanent: stop retrying but KEEP the burned record for manual recovery
          rec.callback_error = `alpaca returned ${r.status}: ${r.body?.reason || r.body?.message}`;
          rec.status = 'callback_failed'; rec.needs_attention = true;
          console.log(`[issuer] PERMANENT callback failure for redemption ${rec.id.slice(0, 8)}: ${rec.callback_error} (record preserved; POST /tokenization/redemptions/${rec.id}/retry-callback to recover)`);
          return;
        }
      } catch { /* alpaca down: retry */ }
      await sleep(RETRY_MS);
    }
  } finally { rec.delivering = false; }
}

// Notify Alpaca; retries until delivered so a lost callback is never fatal.
async function deliverCallback(m) {
  if (m.callback_delivered || m.delivering) return;
  m.delivering = true;
  try {
    for (;;) {
      if (faults.drop_callback > 0) { faults.drop_callback--; console.log('[issuer] FAULT: dropping callback'); await sleep(RETRY_MS); continue; }
      try {
        const r = await call('issuer', 'POST', `${URLS.alpaca}/v1/accounts/${m.account_id}/tokenization/callback/mint`,
          { tokenization_request_id: m.id, status: 'completed', issuer_tx_hash: m.tx_hash, token_symbol: m.token_symbol, qty: D.format(m.units), wallet_address: m.wallet_address });
        if (r.ok) { m.callback_delivered = true; return; }
        if (r.status >= 400 && r.status < 500) { m.callback_error = `alpaca returned ${r.status}`; return; }
      } catch { /* alpaca down: retry */ }
      await sleep(RETRY_MS);
    }
  } finally { m.delivering = false; }
}

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ service: 'issuer', status: 'ok' }));
app.get('/tokenization/issuer', (_req, res) => res.json(issuer));
app.get('/tokenization/tokens', (_req, res) => res.json(supportedTokens));

app.get('/tokenization/aps/:ap_id', (req, res) => {
  const ap = aps.get(req.params.ap_id);
  if (!ap) return res.status(404).json({ message: 'AP not registered' });
  res.json(ap);
});

app.get('/tokenization/wallets/:address/balances', (req, res) => {
  const w = wallets.get(req.params.address);
  if (!w) return res.status(404).json({ message: 'wallet not found' });
  res.json({ wallet: req.params.address, network: 'solana', balances: fmtBalances(w) });
});

// Total token supply per symbol (sum over wallets) - used to check conservation.
app.get('/tokenization/supply', (_req, res) => {
  const s = { AAPLx: 0n, TSLAx: 0n };
  for (const w of wallets.values()) for (const k of Object.keys(s)) s[k] += w[k];
  res.json(fmtBalances(s));
});

app.get('/tokenization/mint/:id', (req, res) => {
  const m = mints.get(req.params.id);
  if (!m) return res.status(404).json({ message: 'unknown tokenization_request_id' });
  const { delivering, units, ...pub } = m;
  res.json({ ...pub, qty: D.format(units) });
});

// Alpaca -> Issuer: validate a mint (no tokens are issued yet). Idempotent on request id.
app.post('/tokenization/mint', (req, res) => {
  const b = req.body || {};
  const id = b.tokenization_request_id;
  if (!id) return res.status(400).json({ message: 'tokenization_request_id required' });
  const prior = mints.get(id);
  if (prior) return prior.status === 'rejected' ? res.status(422).json({ status: 'rejected', reason: prior.reason }) : res.json({ status: 'accepted' });

  const m = { id, account_id: b.account_id, token_symbol: b.token_symbol, network: b.network, wallet_address: b.wallet_address, status: 'rejected', reason: null, tx_hash: null, callback_delivered: false };
  const no = (reason) => { m.reason = reason; m.units = 0n; mints.set(id, m); return res.status(422).json({ status: 'rejected', reason }); };
  try { m.units = D.parse(b.qty); } catch (e) { return no(e.message); }
  const tok = supportedTokens.find((t) => t.symbol === b.token_symbol && t.underlying === b.underlying_symbol);
  if (!tok) return no(`unsupported token ${b.token_symbol}`);
  if (tok.network !== b.network) return no(`unsupported network ${b.network} for ${b.token_symbol}`);
  const ap = [...aps.values()].find((a) => a.alpaca_account_id === b.account_id);
  if (!ap || ap.status !== 'REGISTERED') return no(`account ${b.account_id} is not a registered AP`);
  if (!ap.wallets.includes(b.wallet_address)) return no(`wallet ${b.wallet_address} is not whitelisted for AP ${ap.id}`);
  m.status = 'accepted';
  mints.set(id, m);
  res.json({ status: 'accepted' });
});

// Alpaca -> Issuer: shares are in custody; credit tokens EXACTLY ONCE, then call back.
app.post('/tokenization/mint/confirm', (req, res) => {
  const id = req.body?.tokenization_request_id;
  const m = mints.get(id);
  if (!m) return res.status(404).json({ message: 'unknown tokenization_request_id' });
  if (m.status === 'rejected') return res.status(409).json({ message: `mint was rejected: ${m.reason}` });
  if (faults.fail_confirm > 0) { faults.fail_confirm--; console.log('[issuer] FAULT: failing confirm'); return res.status(503).json({ message: 'injected fault' }); }
  if (m.status === 'accepted') { // synchronous check-and-credit => idempotent, cannot double-credit
    wallets.get(m.wallet_address)[m.token_symbol] += m.units;
    m.status = 'credited';
    m.tx_hash = fakeTxHash();
    console.log(`[issuer] credited ${D.format(m.units)} ${m.token_symbol} to ${m.wallet_address} (${id.slice(0, 8)})`);
  }
  deliverCallback(m); // background, retried until delivered
  res.json({ tokenization_request_id: id, status: m.status, issuer_tx_hash: m.tx_hash });
});

// Own design (not in Alpaca docs): stands in for an on-chain transfer of tokens to the
// redemption wallet. Validates, moves tokens, returns a fake tx hash, then (async) burns and notifies Alpaca.
app.post('/tokenization/transfers', (req, res) => {
  const b = req.body || {};
  // client_ref is the idempotency key: it prevents duplicate transfers from retries / double clicks.
  if (!b.client_ref) return res.status(400).json({ message: 'client_ref is required (idempotency key for transfers)' });
  const fingerprint = JSON.stringify([b.from_wallet, b.to_wallet, b.token_symbol, String(b.qty), b.network]);
  if (clientRefs.has(b.client_ref)) { // idempotent replay (registered synchronously below, so concurrent duplicates also land here)
    const prior = redemptions.get(clientRefs.get(b.client_ref));
    if (prior.fingerprint !== fingerprint) return res.status(409).json({ message: 'client_ref already used with different transfer parameters' });
    return prior.status === 'rejected' ? res.status(422).json({ status: 'rejected', redemption_id: prior.id, reason: prior.reason })
      : res.json({ status: 'transferred', redemption_id: prior.id, tx_hash: prior.tx_hash });
  }
  const rec = { id: crypto.randomUUID(), type: 'redeem', status: 'rejected', reason: null, tx_hash: null, from_wallet: b.from_wallet, to_wallet: b.to_wallet,
    token_symbol: b.token_symbol, underlying_symbol: null, network: b.network, account_id: null, units: 0n, burned: false, callback_delivered: false, needs_attention: false, fingerprint, created_at: new Date().toISOString() };
  redemptions.set(rec.id, rec);
  clientRefs.set(b.client_ref, rec.id);
  const no = (reason) => { rec.reason = reason; return res.status(422).json({ status: 'rejected', redemption_id: rec.id, reason }); };

  const ap = [...aps.values()].find((a) => a.wallets.includes(b.from_wallet));
  if (!ap || ap.status !== 'REGISTERED') return no(`wallet ${b.from_wallet} does not belong to a registered AP`);
  rec.account_id = ap.alpaca_account_id;
  if (b.to_wallet !== IDS.REDEMPTION_WALLET) return no('tokens can only be transferred to the redemption wallet for redemption');
  const tok = supportedTokens.find((t) => t.symbol === b.token_symbol);
  if (!tok) return no(`unsupported token ${b.token_symbol}`);
  rec.underlying_symbol = tok.underlying;
  if (tok.network !== b.network) return no(`unsupported network ${b.network} for ${b.token_symbol}`);
  let units;
  try { units = D.parse(b.qty); } catch (e) { return no(e.message); }
  rec.units = units;
  const from = wallets.get(b.from_wallet);
  if (from[tok.symbol] < units) return no(`insufficient ${tok.symbol} balance: requested ${D.format(units)}, wallet holds ${D.format(from[tok.symbol])}`);

  // synchronous debit + credit: tokens move exactly once
  from[tok.symbol] -= units;
  wallets.get(IDS.REDEMPTION_WALLET)[tok.symbol] += units;
  rec.status = 'transferred'; rec.tx_hash = fakeTxHash();
  console.log(`[issuer] transfer ${D.format(units)} ${tok.symbol} ${b.from_wallet.slice(0, 8)}.. -> redemption wallet (${rec.id.slice(0, 8)})`);
  processRedemption(rec); // background: burn, then callback
  res.json({ status: 'transferred', redemption_id: rec.id, tx_hash: rec.tx_hash });
});

app.get('/tokenization/redemptions', (req, res) => {
  const list = [...redemptions.values()].filter((r) => !req.query.wallet || r.from_wallet === req.query.wallet).reverse();
  res.json(list.map(pubRedemption));
});
app.get('/tokenization/redemptions/:id', (req, res) => {
  const r = redemptions.get(req.params.id);
  if (!r) return res.status(404).json({ message: 'unknown redemption' });
  res.json(pubRedemption(r));
});

// Recovery: re-send the redeem callback for a burned redemption whose callback failed permanently.
// Safe to repeat: Alpaca dedupes on issuer_request_id, and the burn already happened exactly once.
app.post('/tokenization/redemptions/:id/retry-callback', (req, res) => {
  const rec = redemptions.get(req.params.id);
  if (!rec) return res.status(404).json({ message: 'unknown redemption' });
  if (!rec.burned) return res.status(409).json({ message: `nothing to retry: redemption is ${rec.status}` });
  if (rec.callback_delivered) return res.json({ idempotent: true, ...pubRedemption(rec) });
  if (!rec.delivering) { rec.callback_error = null; rec.needs_attention = false; rec.status = 'burned'; deliverRedeemCallback(rec); }
  res.status(202).json(pubRedemption(rec));
});

app.post('/admin/faults', (req, res) => {
  for (const k of Object.keys(faults)) if (req.body?.[k] !== undefined) faults[k] = Number(req.body[k]);
  res.json(faults);
});

if (require.main === module) {
  app.listen(PORTS.issuer, () => console.log(`[issuer] listening on :${PORTS.issuer}`));
}
module.exports = app;

// AP (localhost:3000) - serves the web page and talks to Alpaca (shares, mint,
// requests) and the Issuer (token balances). Owns no balances itself.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { PORTS, URLS, IDS } = require('../../config');
const { call, recent } = require('../../lib/http');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upstream = (res, e) => res.status(502).json({ message: 'upstream unavailable', detail: e.message });

app.get('/health', (_req, res) => res.json({ service: 'ap', status: 'ok' }));

app.get('/api/config', (_req, res) =>
  res.json({ account_id: IDS.AP_ACCOUNT, wallet: IDS.AP_WALLET, tokens: ['AAPLx', 'TSLAx'], network: 'solana' }));

app.get('/api/balances', async (_req, res) => {
  try {
    const [shares, tokens] = await Promise.all([
      call('ap', 'GET', `${URLS.alpaca}/v1/accounts/${IDS.AP_ACCOUNT}/positions`, undefined, { quiet: true }),
      call('ap', 'GET', `${URLS.issuer}/tokenization/wallets/${IDS.AP_WALLET}/balances`, undefined, { quiet: true }),
    ]);
    res.json({ shares: shares.body, tokens: tokens.body });
  } catch (e) { upstream(res, e); }
});

app.get('/api/requests', async (_req, res) => {
  try {
    const r = await call('ap', 'GET', `${URLS.alpaca}/v1/accounts/${IDS.AP_ACCOUNT}/tokenization/requests`, undefined, { quiet: true });
    res.status(r.status).json(r.body);
  } catch (e) { upstream(res, e); }
});

// Mint button -> Alpaca. Defaults come from the AP's own config; overrides allow
// testing rejection cases (bad network / wallet / token).
app.post('/api/mint', async (req, res) => {
  const b = req.body || {};
  try {
    const r = await call('ap', 'POST', `${URLS.alpaca}/v1/accounts/${IDS.AP_ACCOUNT}/tokenization/mint`, {
      underlying_symbol: b.underlying_symbol, qty: b.qty, token_symbol: b.token_symbol,
      network: b.network ?? 'solana', wallet_address: b.wallet_address ?? IDS.AP_WALLET, issuer_id: IDS.ISSUER_ID,
    }, { headers: { 'Idempotency-Key': b.idempotency_key ?? crypto.randomUUID() } });
    res.status(r.status).json(r.body);
  } catch (e) { upstream(res, e); }
});

// Redeem button -> Issuer transfer endpoint (stands in for the on-chain transfer to the
// redemption wallet). Overrides exist only to exercise rejection cases.
app.post('/api/redeem', async (req, res) => {
  const b = req.body || {};
  try {
    const iss = await call('ap', 'GET', `${URLS.issuer}/tokenization/issuer`);
    const r = await call('ap', 'POST', `${URLS.issuer}/tokenization/transfers`, {
      from_wallet: b.from_wallet ?? IDS.AP_WALLET, to_wallet: b.to_wallet ?? iss.body.redemption_wallet,
      token_symbol: b.token_symbol, qty: b.qty, network: b.network ?? 'solana', client_ref: b.client_ref ?? crypto.randomUUID(),
    });
    res.status(r.status).json(r.body);
  } catch (e) { upstream(res, e); }
});

// Issuer-side view of this wallet's redemptions (covers the window before Alpaca has the redeem request)
app.get('/api/redemptions', async (_req, res) => {
  try {
    const r = await call('ap', 'GET', `${URLS.issuer}/tokenization/redemptions?wallet=${IDS.AP_WALLET}`, undefined, { quiet: true });
    res.status(r.status).json(r.body);
  } catch (e) { upstream(res, e); }
});

// Live log: every cross-service call made by AP, Alpaca and the Issuer, merged by time.
// Background polling is hidden unless ?polling=1.
app.get('/api/logs', async (req, res) => {
  const fetchLogs = (url) => call('ap', 'GET', url, undefined, { quiet: true }).then((r) => (r.ok ? r.body : [])).catch(() => []);
  const [alpaca, issuer] = await Promise.all([fetchLogs(`${URLS.alpaca}/logs`), fetchLogs(`${URLS.issuer}/logs`)]);
  let all = [...recent(), ...alpaca, ...issuer].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  if (req.query.polling !== '1') all = all.filter((c) => !c.quiet);
  res.json(all.slice(-150));
});

if (require.main === module) {
  app.listen(PORTS.ap, () => console.log(`[ap] listening on :${PORTS.ap}`));
}
module.exports = app;

// Test runner: boots the stack with `npm start` (fast timings), runs phase-1
// read checks and phase-2 mint flow tests over real HTTP, then stops everything.
// Checks run sequentially and build on each other's state. Exit 0 = all pass.
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const { URLS, IDS } = require('../config');

const send = async (method, url, body) => {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const get = (url) => send('GET', url);
const post = (url, body) => send('POST', url, body);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(url, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if ((await fetch(url)).ok) return; } catch {} await sleep(150); }
  throw new Error(`timeout waiting for ${url}`);
}
// poll until predicate(request) is true
async function until(id, pred, what, ms = 8000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) {
    last = (await get(`${URLS.alpaca}/v1/accounts/${IDS.AP_ACCOUNT}/tokenization/requests/${id}`)).body;
    if (pred(last)) return last;
    await sleep(30);
  }
  throw new Error(`timeout waiting for ${what}; last status=${last?.status} step=${last?.step} err=${last?.last_error}`);
}
const finished = (id) => until(id, (r) => r.status !== 'pending', 'terminal status');

const shares = async (acct) => Object.fromEntries((await get(`${URLS.alpaca}/v1/accounts/${acct}/positions`)).body.map((p) => [p.symbol, p.qty]));
const tokens = async (wallet = IDS.AP_WALLET) => (await get(`${URLS.issuer}/tokenization/wallets/${wallet}/balances`)).body.balances;
const mintBody = (o = {}) => ({ underlying_symbol: 'AAPL', qty: '1', network: 'solana', wallet_address: IDS.AP_WALLET, issuer_id: IDS.ISSUER_ID, ...o });
const mint = (o) => post(`${URLS.alpaca}/v1/accounts/${IDS.AP_ACCOUNT}/tokenization/mint`, mintBody(o));
async function snapshot() {
  return JSON.stringify([await shares(IDS.AP_ACCOUNT), await shares(IDS.ISSUER_ACCOUNT), await tokens()]);
}
async function expectSyncReject(over, re) {
  const before = await snapshot();
  const r = await mint(over);
  assert.strictEqual(r.status, 422, `expected 422, got ${r.status}`);
  assert.strictEqual(r.body.status, 'rejected');
  assert.match(r.body.reason, re);
  assert.strictEqual(await snapshot(), before, 'balances must not change on rejection');
  // rejection is visible to the AP in its request history, with the reason
  const hist = (await get(`${URLS.ap}/api/requests`)).body;
  assert.ok(hist.some((x) => x.tokenization_request_id === r.body.tokenization_request_id && x.reason === r.body.reason));
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

// ---------------- phase 1: startup, seeds, reads ----------------
check('health: all three services up', async () => {
  for (const k of ['ap', 'alpaca', 'issuer']) assert.strictEqual((await get(`${URLS[k]}/health`)).body.status, 'ok');
});
check('seed: AP holds 10 AAPL and 5 TSLA; issuer custody 0/0', async () => {
  assert.deepStrictEqual(await shares(IDS.AP_ACCOUNT), { AAPL: '10', TSLA: '5' });
  assert.deepStrictEqual(await shares(IDS.ISSUER_ACCOUNT), { AAPL: '0', TSLA: '0' });
});
check('alpaca: unknown account -> 404; request list empty', async () => {
  assert.strictEqual((await get(`${URLS.alpaca}/v1/accounts/nope`)).status, 404);
  assert.deepStrictEqual((await get(`${URLS.alpaca}/v1/accounts/${IDS.AP_ACCOUNT}/tokenization/requests`)).body, []);
});
check('issuer: tokens AAPLx/TSLAx on solana; AP registered with one wallet', async () => {
  const t = (await get(`${URLS.issuer}/tokenization/tokens`)).body;
  assert.deepStrictEqual(t.map((x) => `${x.symbol}:${x.network}`), ['AAPLx:solana', 'TSLAx:solana']);
  assert.deepStrictEqual((await get(`${URLS.issuer}/tokenization/aps/${IDS.AP_ID}`)).body.wallets, [IDS.AP_WALLET]);
  assert.deepStrictEqual(await tokens(), { AAPLx: '0', TSLAx: '0' });
});
check('ap: serves page and aggregates balances', async () => {
  assert.ok((await (await fetch(URLS.ap)).text()).includes('Mint'));
  const { body } = await get(`${URLS.ap}/api/balances`);
  assert.strictEqual(body.shares.length, 2); assert.strictEqual(body.tokens.balances.AAPLx, '0');
});

// ---------------- phase 2: mint ----------------
let okId;
check('MINT 2 AAPL via AP: pending -> completed; shares move, tokens credited once', async () => {
  const r = await post(`${URLS.ap}/api/mint`, { underlying_symbol: 'AAPL', qty: '2' });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.status, 'pending');
  okId = r.body.tokenization_request_id;
  const done = await finished(okId);
  assert.strictEqual(done.status, 'completed', done.reason);
  assert.match(done.issuer_tx_hash, /^0x[0-9a-f]{64}$/);
  assert.deepStrictEqual(await shares(IDS.AP_ACCOUNT), { AAPL: '8', TSLA: '5' });
  assert.deepStrictEqual(await shares(IDS.ISSUER_ACCOUNT), { AAPL: '2', TSLA: '0' });
  assert.deepStrictEqual(await tokens(), { AAPLx: '2', TSLAx: '0' });
  const steps = done.events.map((e) => e.event).join(' | ');
  assert.ok(steps.indexOf('issuer accepted') < steps.indexOf('moved 2 AAPL'), 'shares moved only after issuer validation');
  assert.ok(steps.indexOf('moved 2 AAPL') < steps.indexOf('COMPLETED'));
});
check('REJECT insufficient shares (100 AAPL)', () => expectSyncReject({ qty: '100' }, /insufficient AAPL/));
check('REJECT unsupported token (NVDAx)', () => expectSyncReject({ token_symbol: 'NVDAx' }, /unsupported token NVDAx/));
check('REJECT unsupported network (ethereum)', () => expectSyncReject({ network: 'ethereum' }, /unsupported network ethereum/));
check('REJECT more than 9 decimal places', () => expectSyncReject({ qty: '0.0000000001' }, /more than 9 decimal places/));
check('ACCEPT exactly 9 decimal places (0.000000001 TSLA)', async () => {
  const r = await mint({ underlying_symbol: 'TSLA', qty: '0.000000001' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await finished(r.body.tokenization_request_id)).status, 'completed');
  assert.deepStrictEqual(await tokens(), { AAPLx: '2', TSLAx: '0.000000001' });
});
check('REJECT invalid quantities (0, -1, abc)', async () => {
  for (const qty of ['0', '-1', 'abc']) await expectSyncReject({ qty }, /invalid quantity/);
});
check('REJECT unregistered wallet: issuer rejects, no shares move', async () => {
  const before = await snapshot();
  const r = await mint({ wallet_address: 'NotWhitelistedWallet111' });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.status, 'pending');
  const done = await finished(r.body.tokenization_request_id);
  assert.strictEqual(done.status, 'rejected');
  assert.match(done.reason, /not whitelisted/);
  assert.ok(!done.shares_transferred);
  assert.strictEqual(await snapshot(), before);
});
check('CONCURRENT mints cannot double-spend shares (5+5 AAPL with 8 held)', async () => {
  const [a, b] = await Promise.all([mint({ qty: '5' }), mint({ qty: '5' })]);
  const statuses = [a.status, b.status].sort();
  assert.deepStrictEqual(statuses, [200, 422]);
  const winner = a.status === 200 ? a : b;
  assert.strictEqual((await finished(winner.body.tokenization_request_id)).status, 'completed');
  assert.deepStrictEqual(await shares(IDS.AP_ACCOUNT), { AAPL: '3', TSLA: '4.999999999' });
  assert.deepStrictEqual(await shares(IDS.ISSUER_ACCOUNT), { AAPL: '7', TSLA: '0.000000001' });
});
let idemId;
check('PARTIAL FAILURE: confirm fails twice after shares moved -> state kept, retried, tokens exactly once', async () => {
  await post(`${URLS.issuer}/admin/faults`, { fail_confirm: 2 });
  const tslaBefore = (await tokens()).TSLAx;
  const r = await mint({ underlying_symbol: 'TSLA', qty: '1' });
  idemId = r.body.tokenization_request_id;
  const stuck = await until(idemId, (x) => x.shares_transferred && x.last_error, 'stuck mid-flow');
  assert.strictEqual(stuck.status, 'pending');                  // not lost, not rejected
  assert.strictEqual((await tokens()).TSLAx, tslaBefore);       // tokens not issued yet
  assert.strictEqual((await shares(IDS.ISSUER_ACCOUNT)).TSLA, '1.000000001'); // shares are safely in custody
  const done = await finished(idemId);                          // reconciler resumes it
  assert.strictEqual(done.status, 'completed');
  assert.ok(done.attempts >= 2);
  assert.strictEqual((await tokens()).TSLAx, '1.000000001');    // credited once
});
check('PARTIAL FAILURE: callback lost after crediting -> issuer retries, no double credit', async () => {
  await post(`${URLS.issuer}/admin/faults`, { drop_callback: 2 });
  const r = await mint({ underlying_symbol: 'TSLA', qty: '1' });
  const id = r.body.tokenization_request_id;
  const end = Date.now() + 6000; let credited = false;
  while (Date.now() < end && !credited) { credited = (await tokens()).TSLAx === '2.000000001'; if (!credited) await sleep(20); }
  assert.ok(credited, 'tokens credited');
  assert.strictEqual((await get(`${URLS.alpaca}/v1/accounts/${IDS.AP_ACCOUNT}/tokenization/requests/${id}`)).body.status, 'pending'); // Alpaca hasn't heard yet
  assert.strictEqual((await finished(id)).status, 'completed');
  assert.strictEqual((await tokens()).TSLAx, '2.000000001');
});
check('IDEMPOTENCY: repeated confirm / mint / callback change nothing', async () => {
  const before = await snapshot();
  for (let i = 0; i < 3; i++) {
    assert.strictEqual((await post(`${URLS.issuer}/tokenization/mint/confirm`, { tokenization_request_id: idemId })).status, 200);
    assert.strictEqual((await post(`${URLS.issuer}/tokenization/mint/confirm`, { tokenization_request_id: okId })).status, 200);
  }
  assert.strictEqual((await post(`${URLS.issuer}/tokenization/mint`, { tokenization_request_id: okId })).status, 200); // replay returns prior decision
  const cb = await post(`${URLS.alpaca}/v1/accounts/${IDS.AP_ACCOUNT}/tokenization/callback/mint`, { tokenization_request_id: okId, status: 'completed' });
  assert.strictEqual(cb.status, 200); assert.strictEqual(cb.body.idempotent, true);
  await sleep(300);
  assert.strictEqual(await snapshot(), before);
  assert.strictEqual((await post(`${URLS.issuer}/tokenization/mint/confirm`, { tokenization_request_id: 'nope' })).status, 404);
});
check('CONSERVATION: shares and tokens never created or lost', async () => {
  const ap = await shares(IDS.AP_ACCOUNT), is = await shares(IDS.ISSUER_ACCOUNT), supply = (await get(`${URLS.issuer}/tokenization/supply`)).body;
  const toUnits = (s) => { const [i, f = ''] = s.split('.'); return BigInt(i) * 10n ** 9n + BigInt(f.padEnd(9, '0')); };
  assert.strictEqual(toUnits(ap.AAPL) + toUnits(is.AAPL), 10n * 10n ** 9n);
  assert.strictEqual(toUnits(ap.TSLA) + toUnits(is.TSLA), 5n * 10n ** 9n);
  assert.strictEqual(toUnits(supply.AAPLx), toUnits(is.AAPL));   // every token backed by a custody share
  assert.strictEqual(toUnits(supply.TSLAx), toUnits(is.TSLA));
  assert.deepStrictEqual(ap, { AAPL: '3', TSLA: '2.999999999' });
  assert.deepStrictEqual(is, { AAPL: '7', TSLA: '2.000000001' });
});

// ---------------- phase 3: redeem (+ both flows together) ----------------
const toUnits = (x) => { const [i, f = ''] = x.split('.'); return BigInt(i) * 10n ** 9n + BigInt(f.padEnd(9, '0')); };
const redeem = (o) => post(`${URLS.ap}/api/redeem`, o);
const alpacaRequests = async () => (await get(`${URLS.alpaca}/v1/accounts/${IDS.AP_ACCOUNT}/tokenization/requests`)).body;
const redeemsFor = async (rid) => (await alpacaRequests()).filter((r) => r.type === 'redeem' && r.issuer_request_id === rid);
async function redeemDone(rid, ms = 8000) {
  const end = Date.now() + ms; let r;
  while (Date.now() < end) { [r] = await redeemsFor(rid); if (r && r.status !== 'pending') return r; await sleep(30); }
  throw new Error(`timeout waiting for redeem ${rid} on alpaca; got ${JSON.stringify(r)}`);
}
async function issuerRedemption(rid, pred, ms = 8000) {
  const end = Date.now() + ms; let r;
  while (Date.now() < end) { r = (await get(`${URLS.issuer}/tokenization/redemptions/${rid}`)).body; if (pred(r)) return r; await sleep(30); }
  throw new Error(`timeout waiting on issuer redemption; last=${JSON.stringify(r)}`);
}
const redemptionWallet = () => tokens(IDS.REDEMPTION_WALLET);
async function expectRedeemReject(over, re) {
  const before = await snapshot(); const reqs = (await alpacaRequests()).length;
  const r = await redeem(over);
  assert.strictEqual(r.status, 422, `expected 422, got ${r.status}`);
  assert.strictEqual(r.body.status, 'rejected'); assert.match(r.body.reason, re);
  assert.strictEqual(await snapshot(), before, 'balances must not change');
  assert.deepStrictEqual(await redemptionWallet(), { AAPLx: '0', TSLAx: '0' });
  assert.strictEqual((await alpacaRequests()).length, reqs, 'no alpaca request for a rejected transfer');
  // visible to the AP with the reason (a foreign wallet's rejection is correctly not in the AP's history)
  const hist = (await get(`${URLS.ap}/api/redemptions`)).body;
  if (!over.from_wallet) assert.ok(hist.some((x) => x.id === r.body.redemption_id && x.reason === r.body.reason));
}

check('REDEEM 2 AAPLx via AP: transfer -> burn -> callback -> shares returned once', async () => {
  const r = await redeem({ token_symbol: 'AAPLx', qty: '2' });
  assert.strictEqual(r.status, 200); assert.match(r.body.tx_hash, /^0x[0-9a-f]{64}$/);
  assert.strictEqual((await tokens()).AAPLx, '5');           // debited from AP wallet at transfer time
  const done = await redeemDone(r.body.redemption_id);
  assert.strictEqual(done.status, 'completed', done.reason);
  assert.strictEqual(done.issuer_tx_hash, r.body.tx_hash);
  assert.deepStrictEqual(await shares(IDS.AP_ACCOUNT), { AAPL: '5', TSLA: '2.999999999' });
  assert.deepStrictEqual(await shares(IDS.ISSUER_ACCOUNT), { AAPL: '5', TSLA: '2.000000001' });
  assert.deepStrictEqual(await redemptionWallet(), { AAPLx: '0', TSLAx: '0' });   // burned, not parked
  assert.strictEqual((await get(`${URLS.issuer}/tokenization/supply`)).body.AAPLx, '5');
  const ir = (await get(`${URLS.issuer}/tokenization/redemptions/${r.body.redemption_id}`)).body;
  assert.ok(ir.burned && ir.callback_delivered && ir.status === 'notified');
  assert.ok(done.events.some((e) => /COMPLETED/.test(e.event)));
});
check('BOTH FLOWS TOGETHER: concurrent mint 1 TSLA + redeem 1 AAPLx, then mint->redeem round trip', async () => {
  const [m, rd] = await Promise.all([mint({ underlying_symbol: 'TSLA', qty: '1' }), redeem({ token_symbol: 'AAPLx', qty: '1' })]);
  assert.strictEqual(m.status, 200); assert.strictEqual(rd.status, 200);
  assert.strictEqual((await finished(m.body.tokenization_request_id)).status, 'completed');
  assert.strictEqual((await redeemDone(rd.body.redemption_id)).status, 'completed');
  assert.deepStrictEqual(await shares(IDS.AP_ACCOUNT), { AAPL: '6', TSLA: '1.999999999' });
  assert.deepStrictEqual(await tokens(), { AAPLx: '4', TSLAx: '3.000000001' });
  // round trip: mint 1 AAPL then redeem the same 1 AAPLx -> net zero
  const before = await snapshot();
  const m2 = await mint({ qty: '1' }); await finished(m2.body.tokenization_request_id);
  const r2 = await redeem({ token_symbol: 'AAPLx', qty: '1' }); await redeemDone(r2.body.redemption_id);
  assert.strictEqual(await snapshot(), before);
});
check('REJECT redeem of more tokens than the wallet holds', () => expectRedeemReject({ token_symbol: 'AAPLx', qty: '1000' }, /insufficient AAPLx balance/));
check('REJECT redeem: unsupported token / network / >9 dp / bad wallet / wrong destination', async () => {
  await expectRedeemReject({ token_symbol: 'NVDAx', qty: '1' }, /unsupported token/);
  await expectRedeemReject({ token_symbol: 'AAPLx', qty: '1', network: 'ethereum' }, /unsupported network/);
  await expectRedeemReject({ token_symbol: 'AAPLx', qty: '0.0000000001' }, /more than 9 decimal places/);
  await expectRedeemReject({ token_symbol: 'AAPLx', qty: '1', from_wallet: 'SomeoneElsesWallet' }, /does not belong to a registered AP/);
  await expectRedeemReject({ token_symbol: 'AAPLx', qty: '1', to_wallet: 'RandomWallet' }, /redemption wallet/);
});
check('CALLBACK FAILURE (issuer drops redeem callback x2): tokens burned once, shares wait, then returned once', async () => {
  await post(`${URLS.issuer}/admin/faults`, { drop_redeem_callback: 2 });
  const sharesBefore = await shares(IDS.AP_ACCOUNT); const supplyBefore = (await get(`${URLS.issuer}/tokenization/supply`)).body.TSLAx;
  const r = await redeem({ token_symbol: 'TSLAx', qty: '1' });
  const rid = r.body.redemption_id;
  const burned = await issuerRedemption(rid, (x) => x.burned && !x.callback_delivered);
  assert.strictEqual(burned.status, 'burned');
  assert.strictEqual(toUnits((await get(`${URLS.issuer}/tokenization/supply`)).body.TSLAx), toUnits(supplyBefore) - 10n ** 9n); // burned
  assert.deepStrictEqual(await redemptionWallet(), { AAPLx: '0', TSLAx: '0' });
  assert.deepStrictEqual(await shares(IDS.AP_ACCOUNT), sharesBefore);   // shares not returned yet
  assert.strictEqual((await redeemsFor(rid)).length, 0);                // alpaca hasn't heard yet
  const done = await redeemDone(rid);
  assert.strictEqual(done.status, 'completed');
  assert.strictEqual(toUnits((await shares(IDS.AP_ACCOUNT)).TSLA), toUnits(sharesBefore.TSLA) + 10n ** 9n);  // exactly +1
  assert.strictEqual(toUnits((await get(`${URLS.issuer}/tokenization/supply`)).body.TSLAx), toUnits(supplyBefore) - 10n ** 9n); // not burned twice
});
check('CALLBACK FAILURE (alpaca returns 503 x2 before processing): issuer retries, shares returned once', async () => {
  await post(`${URLS.alpaca}/admin/faults`, { fail_redeem_callback: 2 });
  const before = toUnits((await shares(IDS.AP_ACCOUNT)).TSLA);
  const r = await redeem({ token_symbol: 'TSLAx', qty: '1' });
  const done = await redeemDone(r.body.redemption_id);
  assert.strictEqual(done.status, 'completed');
  assert.strictEqual((await redeemsFor(r.body.redemption_id)).length, 1);
  assert.strictEqual(toUnits((await shares(IDS.AP_ACCOUNT)).TSLA), before + 10n ** 9n);
});
check('CALLBACK FAILURE (alpaca processes but response lost): replay deduped, shares returned once', async () => {
  await post(`${URLS.alpaca}/admin/faults`, { lose_redeem_response: 1 });
  const before = toUnits((await shares(IDS.AP_ACCOUNT)).TSLA);
  const r = await redeem({ token_symbol: 'TSLAx', qty: '0.5' });
  const rid = r.body.redemption_id;
  await issuerRedemption(rid, (x) => x.callback_delivered);           // issuer only succeeds on the retry
  const done = await redeemDone(rid);
  assert.strictEqual(done.status, 'completed');
  assert.strictEqual((await redeemsFor(rid)).length, 1, 'exactly one alpaca request despite two callbacks');
  await sleep(300);
  assert.strictEqual(toUnits((await shares(IDS.AP_ACCOUNT)).TSLA), before + 5n * 10n ** 8n);
});
check('IDEMPOTENCY (redeem): same client_ref and replayed callback change nothing', async () => {
  const ref = 'client-ref-1';
  const a = await post(`${URLS.issuer}/tokenization/transfers`, { from_wallet: IDS.AP_WALLET, to_wallet: IDS.REDEMPTION_WALLET, token_symbol: 'AAPLx', qty: '1', network: 'solana', client_ref: ref });
  await redeemDone(a.body.redemption_id);
  const settled = await snapshot();
  const b = await post(`${URLS.issuer}/tokenization/transfers`, { from_wallet: IDS.AP_WALLET, to_wallet: IDS.REDEMPTION_WALLET, token_symbol: 'AAPLx', qty: '1', network: 'solana', client_ref: ref });
  assert.strictEqual(b.body.tx_hash, a.body.tx_hash); assert.strictEqual(b.body.redemption_id, a.body.redemption_id);
  const [req] = await redeemsFor(a.body.redemption_id);
  const cb = await post(`${URLS.alpaca}/v1/accounts/${IDS.AP_ACCOUNT}/tokenization/callback/redeem`, { issuer_request_id: a.body.redemption_id, tx_hash: a.body.tx_hash, underlying_symbol: 'AAPL', token_symbol: 'AAPLx', qty: '1', network: 'solana', wallet_address: IDS.AP_WALLET });
  assert.strictEqual(cb.status, 200); assert.strictEqual(cb.body.tokenization_request_id, req.tokenization_request_id);
  await sleep(300);
  assert.strictEqual(await snapshot(), settled); assert.strictEqual((await redeemsFor(a.body.redemption_id)).length, 1);
});
check('REGRESSION permanent callback failure: burned record preserved, no endless retry, manual recovery returns shares once', async () => {
  await post(`${URLS.alpaca}/admin/faults`, { reject_redeem_callback: 1 });   // Alpaca answers 422 (permanent)
  const sharesBefore = await shares(IDS.AP_ACCOUNT);
  const supplyBefore = toUnits((await get(`${URLS.issuer}/tokenization/supply`)).body.AAPLx);
  const r = await redeem({ token_symbol: 'AAPLx', qty: '1' });
  const rid = r.body.redemption_id;
  const rec = await issuerRedemption(rid, (x) => x.status === 'callback_failed');
  assert.ok(rec.burned && rec.needs_attention && !rec.callback_delivered, 'record kept, burned, flagged');
  assert.match(rec.callback_error, /injected permanent failure/);
  assert.match(rec.tx_hash, /^0x[0-9a-f]{64}$/);                                   // tx evidence preserved
  assert.strictEqual(toUnits((await get(`${URLS.issuer}/tokenization/supply`)).body.AAPLx), supplyBefore - 10n ** 9n); // burned once
  assert.deepStrictEqual(await redemptionWallet(), { AAPLx: '0', TSLAx: '0' });
  await sleep(1000);                                                               // > 3 retry intervals: it must NOT keep retrying
  assert.strictEqual((await get(`${URLS.issuer}/tokenization/redemptions/${rid}`)).body.status, 'callback_failed');
  assert.strictEqual((await redeemsFor(rid)).length, 0);
  assert.deepStrictEqual(await shares(IDS.AP_ACCOUNT), sharesBefore);              // shares not returned (yet), not lost
  const hist = (await get(`${URLS.ap}/api/redemptions`)).body;                     // visible to the AP
  assert.ok(hist.some((x) => x.id === rid && x.status === 'callback_failed' && x.needs_attention));
  const rr = await post(`${URLS.issuer}/tokenization/redemptions/${rid}/retry-callback`);   // recovery
  assert.strictEqual(rr.status, 202);
  const done = await redeemDone(rid);
  assert.strictEqual(done.status, 'completed');
  assert.strictEqual(toUnits((await shares(IDS.AP_ACCOUNT)).AAPL), toUnits(sharesBefore.AAPL) + 10n ** 9n);  // exactly +1
  const fixed = (await get(`${URLS.issuer}/tokenization/redemptions/${rid}`)).body;
  assert.ok(fixed.status === 'notified' && !fixed.needs_attention && fixed.callback_delivered);
  const again = await post(`${URLS.issuer}/tokenization/redemptions/${rid}/retry-callback`);               // recovery is idempotent
  assert.strictEqual(again.status, 200); assert.strictEqual(again.body.idempotent, true);
  await sleep(300);
  assert.strictEqual(toUnits((await shares(IDS.AP_ACCOUNT)).AAPL), toUnits(sharesBefore.AAPL) + 10n ** 9n);
  assert.strictEqual((await redeemsFor(rid)).length, 1);
  assert.strictEqual((await post(`${URLS.issuer}/tokenization/redemptions/nope/retry-callback`)).status, 404);
});
check('REGRESSION duplicate transfers prevented: client_ref required, concurrent duplicates collapse, reuse with other params -> 409', async () => {
  const body = { from_wallet: IDS.AP_WALLET, to_wallet: IDS.REDEMPTION_WALLET, token_symbol: 'AAPLx', qty: '1', network: 'solana' };
  assert.strictEqual((await post(`${URLS.issuer}/tokenization/transfers`, body)).status, 400);       // no key -> refused
  const tokBefore = toUnits((await tokens()).AAPLx);
  const [a, b] = await Promise.all([1, 2].map(() => post(`${URLS.issuer}/tokenization/transfers`, { ...body, client_ref: 'dup-ref' })));
  assert.strictEqual(a.status, 200); assert.strictEqual(b.status, 200);
  assert.strictEqual(a.body.tx_hash, b.body.tx_hash); assert.strictEqual(a.body.redemption_id, b.body.redemption_id);
  assert.strictEqual(toUnits((await tokens()).AAPLx), tokBefore - 10n ** 9n, 'debited once');
  assert.strictEqual((await post(`${URLS.issuer}/tokenization/transfers`, { ...body, qty: '2', client_ref: 'dup-ref' })).status, 409);
  await redeemDone(a.body.redemption_id);
  const c = await post(`${URLS.issuer}/tokenization/transfers`, { ...body, client_ref: 'dup-ref' });   // replay after completion
  assert.strictEqual(c.body.tx_hash, a.body.tx_hash);
  await sleep(300);
  assert.strictEqual(toUnits((await tokens()).AAPLx), tokBefore - 10n ** 9n);
  assert.strictEqual((await redeemsFor(a.body.redemption_id)).length, 1, 'one alpaca request, shares returned once');
  const burned = (await get(`${URLS.issuer}/tokenization/redemptions?wallet=${IDS.AP_WALLET}`)).body.filter((x) => x.id === a.body.redemption_id);
  assert.strictEqual(burned.length, 1);
});
check('FINAL CONSERVATION across mint + redeem: nothing double-counted or lost', async () => {
  const ap = await shares(IDS.AP_ACCOUNT), is = await shares(IDS.ISSUER_ACCOUNT), supply = (await get(`${URLS.issuer}/tokenization/supply`)).body;
  assert.strictEqual(toUnits(ap.AAPL) + toUnits(is.AAPL), 10n * 10n ** 9n);
  assert.strictEqual(toUnits(ap.TSLA) + toUnits(is.TSLA), 5n * 10n ** 9n);
  assert.strictEqual(toUnits(supply.AAPLx), toUnits(is.AAPL));
  assert.strictEqual(toUnits(supply.TSLAx), toUnits(is.TSLA));
  assert.deepStrictEqual(await redemptionWallet(), { AAPLx: '0', TSLAx: '0' });
  assert.deepStrictEqual(ap, { AAPL: '9', TSLA: '4.499999999' });
  assert.deepStrictEqual(is, { AAPL: '1', TSLA: '0.500000001' });
  assert.deepStrictEqual(await tokens(), { AAPLx: '1', TSLAx: '0.500000001' });
  const all = await alpacaRequests(); // every request reached a terminal state
  assert.ok(all.every((r) => r.status !== 'pending'), 'no request left pending');
});

(async () => {
  const proc = spawn('npm', ['start'], {
    cwd: path.join(__dirname, '..'), stdio: 'ignore', detached: true,
    env: { ...process.env, STEP_DELAY_MS: '50', RETRY_MS: '300' },
  });
  let failed = 0;
  try {
    await Promise.all(['ap', 'alpaca', 'issuer'].map((k) => waitFor(`${URLS[k]}/health`)));
    for (const c of checks) {
      try { await c.fn(); console.log(`PASS  ${c.name}`); }
      catch (e) { failed++; console.log(`FAIL  ${c.name}\n      ${e.message}`); }
    }
  } catch (e) { failed++; console.log(`FAIL  startup: ${e.message}`); }
  try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
  console.log(failed ? `\n${failed} failed` : `\nall ${checks.length} passed`);
  process.exit(failed ? 1 : 0);
})();

// Logged HTTP client used for every cross-service call. Stateless apart from a
// per-process ring buffer of recent calls, exposed via GET /logs for the live log.
// - Attaches the Issuer's static X-API-KEY automatically to calls aimed at the Issuer.
// - Resolves {status, ok, body} for any HTTP response; throws (err.network=true)
//   only when the peer is unreachable/timed out.
const { PORTS, ISSUER_API_KEY } = require('../config');

const NAMES = { [PORTS.ap]: 'AP', [PORTS.alpaca]: 'Alpaca', [PORTS.issuer]: 'Issuer' };
const calls = [];
let seq = 0;
const MAX_CALLS = 300;

function record(entry) {
  calls.push({ seq: ++seq, ts: new Date().toISOString(), ...entry });
  if (calls.length > MAX_CALLS) calls.shift();
}
const recent = () => calls.slice();

// opts: { headers, quiet } - quiet marks background polling so the live log can hide it by default
async function call(from, method, url, body, opts = {}) {
  const u = new URL(url);
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  if (Number(u.port) === PORTS.issuer) headers['X-API-KEY'] = ISSUER_API_KEY;
  const base = { from: { ap: 'AP', alpaca: 'Alpaca', issuer: 'Issuer' }[from] || from, to: NAMES[u.port] || u.host, method, path: u.pathname + u.search, quiet: !!opts.quiet };
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    const json = await r.json().catch(() => null);
    record({ ...base, status: r.status, ms: Date.now() - t0 });
    if (!base.quiet) console.log(`[${from}] ${method} ${url} -> ${r.status}`);
    return { status: r.status, ok: r.ok, body: json };
  } catch (e) {
    record({ ...base, status: 'ERR', ms: Date.now() - t0 });
    console.log(`[${from}] ${method} ${url} !! ${e.message}`);
    const err = new Error(`network error calling ${url}: ${e.message}`);
    err.network = true;
    throw err;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = { call, sleep, recent };

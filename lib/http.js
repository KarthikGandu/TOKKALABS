// Tiny logged HTTP client used for every cross-service call.
// Resolves {status, ok, body} for any HTTP response; throws (err.network=true)
// only when the peer is unreachable/timed out.
async function call(from, method, url, body) {
  try {
    const r = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    const json = await r.json().catch(() => null);
    console.log(`[${from}] ${method} ${url} -> ${r.status}`);
    return { status: r.status, ok: r.ok, body: json };
  } catch (e) {
    console.log(`[${from}] ${method} ${url} !! ${e.message}`);
    const err = new Error(`network error calling ${url}: ${e.message}`);
    err.network = true;
    throw err;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = { call, sleep };

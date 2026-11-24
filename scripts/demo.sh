#!/usr/bin/env bash
# One-command demo: starts the 3 services, runs mint + redeem + rejections, prints
# what happened at each step, then stops everything. No extra terminals needed.
cd "$(dirname "$0")/.." || exit 1
export STEP_DELAY_MS=${STEP_DELAY_MS:-400} RETRY_MS=${RETRY_MS:-500}
LOG=$(mktemp -t tokka-demo.XXXXXX)
npm start >"$LOG" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; pkill -P $PID 2>/dev/null; wait $PID 2>/dev/null' EXIT

for p in 3000 4000 5000; do
  for _ in $(seq 1 50); do curl -sf localhost:$p/health >/dev/null && break; sleep 0.2; done
done

J=(-s -H 'content-type: application/json')
jqs() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log($1)})"; }
bal() {
  curl -s localhost:3000/api/balances | jqs "'  AP shares: '+j.shares.map(p=>p.symbol+'='+p.qty).join(', ')+'   |   AP tokens: '+Object.entries(j.tokens.balances).map(([k,v])=>k+'='+v).join(', ')"
  curl -s localhost:4000/v1/accounts/xstocks-custody-001/positions | jqs "'  Issuer custody shares: '+j.map(p=>p.symbol+'='+p.qty).join(', ')"
}
step() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }

step "0. SEED STATE (expect AP shares AAPL=10 TSLA=5, tokens 0, issuer custody 0)"; bal

step "1. MINT 2 AAPL  (expect: status pending, then completed)"
curl "${J[@]}" -X POST localhost:3000/api/mint -d '{"underlying_symbol":"AAPL","qty":"2"}' | jqs "'  submitted: status='+j.status+' step='+j.step"
sleep 0.5; curl -s localhost:3000/api/requests | jqs "'  after 0.5s: '+j[0].status+' / '+j[0].step"
sleep 2.5; curl -s localhost:3000/api/requests | jqs "'  after 3s:   '+j[0].status+' / '+j[0].step+'  tx='+j[0].issuer_tx_hash.slice(0,14)+'...'"
echo "  balances (expect AAPL=8, AAPLx=2, issuer custody AAPL=2):"; bal

step "2. MINT REJECTIONS (expect 4 x 422 with a reason)"
for body in '{"underlying_symbol":"AAPL","qty":"100"}' '{"underlying_symbol":"AAPL","qty":"1","token_symbol":"NVDAx"}' '{"underlying_symbol":"AAPL","qty":"1","network":"ethereum"}' '{"underlying_symbol":"AAPL","qty":"0.0000000001"}'; do
  curl "${J[@]}" -X POST localhost:3000/api/mint -d "$body" | jqs "'  '+j.status+': '+j.reason"
done
echo "  unregistered wallet (expect pending -> rejected by Issuer, no shares move):"
curl "${J[@]}" -X POST localhost:3000/api/mint -d '{"underlying_symbol":"AAPL","qty":"1","wallet_address":"UnknownWallet"}' | jqs "'  submitted: '+j.status"
sleep 3; curl -s localhost:3000/api/requests | jqs "'  after 3s: '+j[0].status+': '+j[0].reason"

step "3. REDEEM 1 AAPLx  (expect: tokens leave AP wallet at once, shares return after burn + callback)"
curl "${J[@]}" -X POST localhost:3000/api/redeem -d '{"token_symbol":"AAPLx","qty":"1"}' | jqs "'  transfer: '+j.status+' tx='+j.tx_hash.slice(0,14)+'...'"
sleep 0.2; echo "  right after transfer (expect AAPLx=1, AAPL still 8):"; bal
sleep 3; curl -s localhost:3000/api/redemptions | jqs "'  issuer redemption status: '+j[0].status+'  (burned='+j[0].burned+', callback_delivered='+j[0].callback_delivered+')'"
curl -s localhost:3000/api/requests | jqs "'  alpaca redeem request: '+j[0].type+' '+j[0].status"
echo "  after completion (expect AAPL=9, AAPLx=1, issuer custody AAPL=1):"; bal

step "4. REDEEM REJECTION (expect 422 insufficient balance)"
curl "${J[@]}" -X POST localhost:3000/api/redeem -d '{"token_symbol":"AAPLx","qty":"1000"}' | jqs "'  '+j.status+': '+j.reason"

step "5. CALLBACK FAILURE RECOVERY (Issuer drops redeem callback twice)"
curl "${J[@]}" -X POST localhost:5000/admin/faults -d '{"drop_redeem_callback":2}' >/dev/null
curl "${J[@]}" -X POST localhost:3000/api/redeem -d '{"token_symbol":"AAPLx","qty":"1"}' | jqs "'  transfer: '+j.status"
sleep 1; curl -s localhost:3000/api/redemptions | jqs "'  issuer status: '+j[0].status+' (tokens burned, shares not back yet, callback_delivered='+j[0].callback_delivered+')'"
curl -s localhost:3000/api/balances | jqs "'  AP shares now: '+j.shares.map(p=>p.symbol+'='+p.qty).join(', ')+'   (expect AAPL=9, unchanged)'"
sleep 3.5; curl -s localhost:3000/api/requests | jqs "'  alpaca redeem: '+j[0].status+'  attempts to deliver were retried by issuer'"
echo "  final (expect AAPL=10, TSLA=5, AAPLx=0, issuer custody 0):"; bal

step "6. PERMANENT CALLBACK FAILURE + MANUAL RECOVERY (Alpaca answers 422 once)"
curl "${J[@]}" -X POST localhost:4000/admin/faults -d '{"reject_redeem_callback":1}' >/dev/null
mint_id=$(curl "${J[@]}" -X POST localhost:3000/api/mint -d '{"underlying_symbol":"AAPL","qty":"1"}' | jqs "j.tokenization_request_id"); sleep 3
RID=$(curl "${J[@]}" -X POST localhost:3000/api/redeem -d '{"token_symbol":"AAPLx","qty":"1"}' | jqs "j.redemption_id"); sleep 2
curl -s localhost:5000/tokenization/redemptions/$RID | jqs "'  issuer record: status='+j.status+' burned='+j.burned+' needs_attention='+j.needs_attention+'\n  error: '+j.callback_error"
curl -s localhost:3000/api/balances | jqs "'  AP shares: AAPL='+j.shares[0].qty+'  (expect 9: burned token NOT lost, shares pending recovery)'"
echo "  recovering: POST /tokenization/redemptions/<id>/retry-callback"
curl "${J[@]}" -X POST localhost:5000/tokenization/redemptions/$RID/retry-callback | jqs "'  -> '+j.status"; sleep 2
curl -s localhost:5000/tokenization/redemptions/$RID | jqs "'  issuer record now: '+j.status+' needs_attention='+j.needs_attention"
curl -s localhost:3000/api/balances | jqs "'  AP shares: AAPL='+j.shares[0].qty+'  (expect 10)'"

step "7. DUPLICATE TRANSFER PREVENTION (same client_ref sent twice)"
curl "${J[@]}" -X POST localhost:3000/api/mint -d '{"underlying_symbol":"AAPL","qty":"2"}' >/dev/null; sleep 3
T='{"from_wallet":"ApWa11etSo1anaAddressWhiteListed111111111111111","to_wallet":"XstocksRedemption1Wa11etSo1ana1111111111111","token_symbol":"AAPLx","qty":"1","network":"solana"}'
echo "  no client_ref:"; curl "${J[@]}" -X POST localhost:5000/tokenization/transfers -d "$T" | jqs "'  -> '+j.message"
A=$(curl "${J[@]}" -X POST localhost:5000/tokenization/transfers -d "${T%\}}"',"client_ref":"demo-dup"}' | jqs "j.tx_hash.slice(0,14)")
B=$(curl "${J[@]}" -X POST localhost:5000/tokenization/transfers -d "${T%\}}"',"client_ref":"demo-dup"}' | jqs "j.tx_hash.slice(0,14)")
echo "  first tx=$A  second tx=$B  (expect identical: second call was a replay)"; sleep 3
curl -s localhost:3000/api/balances | jqs "'  AP tokens: AAPLx='+j.tokens.balances.AAPLx+'  (expect 1: only ONE token debited of the 2 minted)'"

step "8. CROSS-SERVICE LOG (last calls)"
grep -E '^\[(ap|alpaca|issuer)\] (GET|POST)|FAULT|PERMANENT' "$LOG" | grep -v health | tail -12
printf '\n\033[1;32mDone. Services stopped.\033[0m  Full log: %s\n' "$LOG"

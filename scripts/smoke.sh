#!/usr/bin/env bash
# End-to-end smoke test against a running API. Usage:
#   API=http://localhost:3000 npm run smoke
# Creates a guest, claims the daily allowance, buys, locks in, and reads the
# public boards. Needs curl and node (for JSON parsing).
set -euo pipefail
API="${API:-http://localhost:3000}"
j() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);console.log(new Function('o','with(o){return '+process.argv[1]+'}')(o))})" "$1"; }

echo "# guest"
GUEST=$(curl -sf -X POST "$API/auth/guest")
TOKEN=$(echo "$GUEST" | j token)
AUTH="Authorization: Bearer $TOKEN"
echo "$GUEST" | j user.username

echo "# me (grants today's allowance)"
ME=$(curl -sf "$API/me" -H "$AUTH")
echo "cash=$(echo "$ME" | j user.cash) streak=$(echo "$ME" | j user.streak) day=$(echo "$ME" | j day.number)"

echo "# second /me does not grant twice"
curl -sf "$API/me" -H "$AUTH" | j user.cash

echo "# buy"
BUY=$(curl -sf -X POST "$API/buy" -H "$AUTH" -H 'Content-Type: application/json' -d '{"symbol":"NVDA","amount":60}')
PID=$(echo "$BUY" | j position.id)
echo "position=$PID cash_after=$(echo "$BUY" | j cash)"

echo "# overspend is refused"
curl -s -X POST "$API/buy" -H "$AUTH" -H 'Content-Type: application/json' -d '{"symbol":"BTC","amount":500}'; echo

echo "# positions on /me"
curl -sf "$API/me" -H "$AUTH" | j 'positions.map(p=>p.symbol+" "+p.invested+" -> "+p.value+" ("+(p.swing_pct*100).toFixed(1)+"%)").join(", ")'

echo "# charities"
CID=$(curl -sf "$API/charities" | j charities[0].id)

echo "# sell"
curl -s -X POST "$API/sell" -H "$AUTH" -H 'Content-Type: application/json' -d "{\"position_id\":$PID,\"charity_id\":$CID}"; echo

echo "# trickle"
curl -sf "$API/trickle" | j 'quarter+" total="+quarter_total+" top="+charities[0].name+" "+(charities[0].share*100).toFixed(0)+"%"'

echo "# leaderboard"
curl -sf "$API/leaderboard" | j 'all_time.length+" all-time rows, "+last_24h.length+" last-24h rows"'
echo "ok"

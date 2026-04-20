#!/usr/bin/env bash
# Test secuencial de acoplamiento state machine ↔ bot_handoffs (Tarea 6 · ADR-009)
# Uso: PORT=3000 ADMIN_TOKEN=<jwt> CHAT_ID=<id> bash handoff_coupling.sh
# Requiere: curl, jq

PORT="${PORT:-3000}"
BASE="http://localhost:${PORT}"
TOKEN="${ADMIN_TOKEN:-}"
CHAT_ID="${CHAT_ID:-1}"

H_AUTH="Authorization: Bearer ${TOKEN}"
H_JSON="Content-Type: application/json"

pass() { echo "[PASS] $1"; }
fail() { echo "[FAIL] $1"; exit 1; }

echo "=== Test acoplamiento handoff · chat_id=${CHAT_ID} ==="

# ── 1. take-over sobre chat que debería estar en UNASSIGNED o ATTENDED ─────────
echo ""
echo "-- 1. take-over (espera 200, status=PENDING_RESPONSE y handoff activo)"
R=$(curl -s -X POST "${BASE}/api/sales/chats/${CHAT_ID}/take-over" \
  -H "${H_AUTH}" -H "${H_JSON}" -d '{"reason":"test acoplamiento"}')
echo "${R}" | jq .
STATUS_CODE=$(echo "${R}" | jq -r '.data.status // empty')
HANDOFF_ID=$(echo "${R}" | jq -r '.data.handoff_id // empty')
[ "${STATUS_CODE}" = "PENDING_RESPONSE" ] && pass "take-over devuelve PENDING_RESPONSE" || fail "take-over no devolvió PENDING_RESPONSE: ${R}"
[ -n "${HANDOFF_ID}" ] && pass "take-over creó handoff_id=${HANDOFF_ID}" || fail "take-over no creó handoff: ${R}"

# ── 2. Verificar crm_chats.status = PENDING_RESPONSE ───────────────────────────
echo ""
echo "-- 2. crm_chats.status debe ser PENDING_RESPONSE (via /api/inbox u otra ruta si existe)"
# (validación manual en DB)  SELECT status FROM crm_chats WHERE id=${CHAT_ID};

# ── 3. return-to-bot ────────────────────────────────────────────────────────────
echo ""
echo "-- 3. return-to-bot (espera 200 y chat_released)"
R=$(curl -s -X POST "${BASE}/api/sales/chats/${CHAT_ID}/return-to-bot" \
  -H "${H_AUTH}" -H "${H_JSON}")
echo "${R}" | jq .
ENDED=$(echo "${R}" | jq -r '.data.ended_at // empty')
[ -n "${ENDED}" ] && pass "return-to-bot devolvió ended_at=${ENDED}" || fail "return-to-bot falló: ${R}"

# ── 4. Segundo take-over — ahora sobre UNASSIGNED de nuevo ──────────────────────
echo ""
echo "-- 4. segundo take-over (espera 200)"
R=$(curl -s -X POST "${BASE}/api/sales/chats/${CHAT_ID}/take-over" \
  -H "${H_AUTH}" -H "${H_JSON}" -d '{"reason":"segundo test"}')
echo "${R}" | jq .
[ "$(echo "${R}" | jq -r '.data.status // empty')" = "PENDING_RESPONSE" ] && pass "segundo take-over OK" || fail "segundo take-over falló: ${R}"

# ── 5. Tercer take-over mientras ya hay uno activo — debe devolver 409 ───────────
echo ""
echo "-- 5. take-over duplicado (espera 409 handoff_already_active o PENDING_SLOT_BUSY)"
R=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE}/api/sales/chats/${CHAT_ID}/take-over" \
  -H "${H_AUTH}" -H "${H_JSON}" -d '{"reason":"duplicado"}')
[ "${R}" = "409" ] && pass "duplicado retornó 409" || fail "duplicado retornó ${R}, esperaba 409"

# ── 6. return-to-bot para limpiar ───────────────────────────────────────────────
curl -s -X POST "${BASE}/api/sales/chats/${CHAT_ID}/return-to-bot" -H "${H_AUTH}" -H "${H_JSON}" > /dev/null

# ── 7. return-to-bot desde UNASSIGNED — debe devolver 400 HANDOFF_INVALID_STATE ─
echo ""
echo "-- 7. return-to-bot desde UNASSIGNED (espera 400 HANDOFF_INVALID_STATE)"
R=$(curl -s -X POST "${BASE}/api/sales/chats/${CHAT_ID}/return-to-bot" \
  -H "${H_AUTH}" -H "${H_JSON}")
echo "${R}" | jq .
ERR=$(echo "${R}" | jq -r '.error // empty')
[ "${ERR}" = "HANDOFF_INVALID_STATE" ] && pass "return-to-bot desde UNASSIGNED retornó HANDOFF_INVALID_STATE" || fail "esperaba HANDOFF_INVALID_STATE, obtuve: ${R}"

echo ""
echo "=== Todos los tests pasaron ==="

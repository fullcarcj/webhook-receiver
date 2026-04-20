#!/usr/bin/env bash
# Bloque 3 · Fase 0 — pruebas manuales (requiere servidor + migración db:crm-ml-question-answered-at)
# Uso: PORT=3000 SKU=ABC-001 bash scripts/tests/bloque3-phase0-curl.sh

PORT="${PORT:-3000}"
SKU="${SKU:-TEST-SKU}"
BASE="http://localhost:${PORT}"

echo "=== GET La Lupita (alias) ==="
curl -sS "${BASE}/api/products/${SKU}/detail" | head -c 2000
echo ""

echo "=== GET La Lupita (canónico catálogo) ==="
curl -sS "${BASE}/api/catalog/products/${SKU}/detail" | head -c 2000
echo ""

echo "=== POST respuesta ML (requiere JWT + chat ml_question) ==="
echo "curl -X POST '${BASE}/api/inbox/<CHAT_ID>/ml-question/answer' \\"
echo "  -H 'Authorization: Bearer <TOKEN>' -H 'Content-Type: application/json' \\"
echo "  -d '{\"answer_text\":\"...\",\"answered_by\":1}'"

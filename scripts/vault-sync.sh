#!/usr/bin/env bash
# Sync Wapify → Obsidian vault GIOCORE (_ENGINEERING)
# Uso: ./scripts/vault-sync.sh [pipeline_id|all]
# Bootstrap v17 · skeleton: hoy verifica conectividad Wapify por pipeline.
# El parseo + escritura al vault es TODO Fase 2 (subagent giocore-vault-sync).
set -euo pipefail

VAULT_ROOT="${VAULT_ROOT:-$HOME/Documents/Claude/OBSIDIAN/GIOCORE/_ENGINEERING}"

# WAPIFY_TOKEN: si no está en env, extrae SOLO esa línea de giolens_deploy/.env.local.
# NO se hace `source` del .env.local: es un env estilo Vercel con valores sin
# comillas (p.ej. VERCEL_GIT_COMMIT_MESSAGE con espacios) que romperían el sourcing.
ENV_FILE="$HOME/giolens_deploy/.env.local"
if [[ -z "${WAPIFY_TOKEN:-}" && -f "$ENV_FILE" ]]; then
  _line="$(grep -E '^WAPIFY_TOKEN=' "$ENV_FILE" | head -1)"
  WAPIFY_TOKEN="${_line#WAPIFY_TOKEN=}"
  WAPIFY_TOKEN="${WAPIFY_TOKEN%\"}"; WAPIFY_TOKEN="${WAPIFY_TOKEN#\"}"
  WAPIFY_TOKEN="${WAPIFY_TOKEN%\'}"; WAPIFY_TOKEN="${WAPIFY_TOKEN#\'}"
fi
WAPIFY_TOKEN="${WAPIFY_TOKEN:?WAPIFY_TOKEN no seteada (ni en env ni en ~/giolens_deploy/.env.local)}"

PIPELINE="${1:-all}"
PIPELINES=(216977 755062 252999 94103 273944)
if [[ "$PIPELINE" != "all" ]]; then
  PIPELINES=("$PIPELINE")
fi

echo "vault-sync · root=$VAULT_ROOT"
fails=0
for pid in "${PIPELINES[@]}"; do
  echo ">> Sync pipeline $pid"
  # TODO Fase 2: curl Wapify + parsear contactos + escribir vault/Contactos y vault/Pipelines
  if curl -sf -H "X-ACCESS-TOKEN: $WAPIFY_TOKEN" \
       "https://ap.whapify.ai/api/contacts?pipeline_id=$pid&limit=1" > /dev/null; then
    echo "  OK"
  else
    echo "  FAIL"
    fails=$((fails + 1))
  fi
done

echo "vault-sync done · fails=$fails"
exit "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"

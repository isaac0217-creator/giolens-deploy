#!/bin/bash
# ============================================================================
# GioLens — Migración Fase 1 Sprint 1
# ----------------------------------------------------------------------------
# Setup automatizado de Supabase + fusión de APIs + deploy + smoke tests.
# Portable Mac/Linux (bash 3.2+).
#
# Uso:
#   export SUPABASE_URL=https://xxx.supabase.co
#   export SUPABASE_SERVICE_ROLE_KEY=eyJ...
#   export ANTHROPIC_API_KEY=sk-ant-...   # ya seteado normalmente
#   bash scripts/migrate-fase1-sprint1.sh
#
# Rollback: ver scripts/README.md sección "Rollback".
# ============================================================================

set -euo pipefail

# ----- Helpers --------------------------------------------------------------
step() {
  printf '\n===== PASO %s · %s =====\n' "$1" "$2"
}
ok()   { printf '  [OK]  %s\n'   "$1"; }
warn() { printf '  [WARN] %s\n'  "$1"; }
err()  { printf '  [ERR] %s\n'   "$1" >&2; }
ask()  { printf '\n>>> %s\n   Presiona ENTER cuando esté listo (Ctrl+C para abortar)...' "$1"; read -r _; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
echo "Repo: $REPO_ROOT"

# ----- Paso 0 · Pre-flight --------------------------------------------------
step 0 "Pre-flight · variables de entorno y herramientas"

MISSING=()
[ -z "${SUPABASE_URL:-}" ]              && MISSING+=("SUPABASE_URL")
[ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ] && MISSING+=("SUPABASE_SERVICE_ROLE_KEY")
[ -z "${ANTHROPIC_API_KEY:-}" ]         && MISSING+=("ANTHROPIC_API_KEY")

if [ "${#MISSING[@]}" -gt 0 ]; then
  err "Faltan variables de entorno: ${MISSING[*]}"
  err "Exporta cada variable y vuelve a correr. Ej:"
  err "  export SUPABASE_URL=https://xxx.supabase.co"
  err "  export SUPABASE_SERVICE_ROLE_KEY=eyJ..."
  exit 1
fi
ok "ENV vars presentes (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY)"

if ! command -v vercel >/dev/null 2>&1; then
  err "vercel CLI no encontrado. Instala con: npm i -g vercel"
  exit 1
fi
ok "vercel CLI disponible ($(vercel --version 2>/dev/null | head -1))"

if ! command -v npm >/dev/null 2>&1; then
  err "npm no encontrado. Instala Node.js >=18 (https://nodejs.org)"
  exit 1
fi
ok "npm disponible ($(npm --version))"

if ! command -v curl >/dev/null 2>&1; then
  err "curl no encontrado. Necesario para smoke tests."
  exit 1
fi
ok "curl disponible"

if ! command -v jq >/dev/null 2>&1; then
  err "jq no encontrado. Necesario para validar payloads en smoke tests."
  err "  Mac: brew install jq"
  err "  Linux: apt-get install jq | yum install jq"
  exit 1
fi
ok "jq disponible ($(jq --version))"

# Verificar que los archivos staged existen (pre-creados en sesión Code 16 may PM)
STAGED_DIR="$REPO_ROOT/scripts/sprint1-staged"
for staged in text-utils.js state.js; do
  if [ ! -f "$STAGED_DIR/$staged" ]; then
    err "Falta archivo staged: $STAGED_DIR/$staged"
    err "Sin esto, los Pasos 5 y 6 no pueden automatizar."
    err "Recuperar con: git checkout HEAD -- scripts/sprint1-staged/"
    exit 1
  fi
done
ok "Archivos staged presentes (text-utils.js + state.js)"

# ----- Paso 1 · Aplicar SQL Supabase (manual) -------------------------------
step 1 "Aplicar SQL Supabase schema"

SQL_FILE="agents/_shared/supabase-schema.sql"
if [ ! -f "$SQL_FILE" ]; then
  err "No existe $SQL_FILE. Verifica el repo antes de continuar."
  exit 1
fi
echo "Aplicando SQL Supabase schema..."
echo "  Archivo: $REPO_ROOT/$SQL_FILE  ($(wc -l < "$SQL_FILE" | tr -d ' ') líneas)"
echo ""
echo "  ACCIÓN MANUAL requerida (Supabase Free tier no tiene CLI directa):"
echo "    1. Abre https://supabase.com/dashboard/project/_/sql/new"
echo "    2. Copia TODO el contenido de $SQL_FILE"
echo "    3. Pégalo en el SQL Editor"
echo "    4. Haz click en 'Run'"
echo "    5. Verifica que la última query (SECCIÓN 8) devuelva:"
echo "       tables_ok=2  policies_ok=4  cron_ok=1  kv_seed_ok=3  kv_upsert_overloads=2"
ask "¿SQL aplicado y verificación OK?"
ok "Schema Supabase aplicado"

# ----- Paso 2 · vercel env add ---------------------------------------------
step 2 "Registrar credenciales Supabase en Vercel (production)"

echo "Vercel pedirá interactivamente el valor de cada var."
echo "Tendrás los valores en tu portapapeles — pégalos cuando los pida."
echo ""
echo "  Valores a pegar:"
echo "    SUPABASE_URL              = $SUPABASE_URL"
echo "    SUPABASE_SERVICE_ROLE_KEY = (oculto)"
echo ""
ask "Listo para registrar SUPABASE_URL en Vercel"
vercel env add SUPABASE_URL production || warn "Si ya existe, continúa"

ask "Listo para registrar SUPABASE_SERVICE_ROLE_KEY en Vercel"
vercel env add SUPABASE_SERVICE_ROLE_KEY production || warn "Si ya existe, continúa"

ok "ENV vars registradas en Vercel"

# ----- Paso 3 · npm install @supabase/supabase-js ---------------------------
step 3 "Instalar @supabase/supabase-js"

npm install @supabase/supabase-js
ok "@supabase/supabase-js instalado"
echo "  Confirmado en package.json:"
node -e "const p=require('./package.json'); console.log('   ', '@supabase/supabase-js =', (p.dependencies||{})['@supabase/supabase-js']||'NO INSTALADO');"

# ----- Paso 4 · Backup APIs a fusionar --------------------------------------
step 4 "Backup de /api/auto-prompt.js y /api/clean-message.js"

mkdir -p api/_backup
TS="$(date +%Y%m%d-%H%M%S)"
for f in auto-prompt.js clean-message.js; do
  if [ -f "api/$f" ]; then
    cp "api/$f" "api/_backup/${f%.js}-${TS}.js"
    ok "Backup: api/_backup/${f%.js}-${TS}.js"
  else
    warn "api/$f no existe — probablemente ya fue fusionado. Skip."
  fi
done

# ----- Paso 5 · Instalar /api/text-utils.js (automático desde staged) -------
step 5 "Instalar /api/text-utils.js (fusión auto-prompt + clean-message)"

if [ -f "api/text-utils.js" ]; then
  warn "api/text-utils.js ya existe — sobreescribiendo con versión staged (idempotente)"
fi
cp "$STAGED_DIR/text-utils.js" "api/text-utils.js"
ok "api/text-utils.js instalado desde staged ($(wc -l < api/text-utils.js | tr -d ' ') líneas)"

# Sanity: node --check antes de eliminar los originales
if ! node --check api/text-utils.js >/dev/null 2>&1; then
  err "api/text-utils.js NO pasa node --check. Aborto antes de eliminar originales."
  exit 1
fi
ok "Sintaxis JS válida"

# Eliminar los 2 archivos fusionados (idempotente con -f)
rm -f api/auto-prompt.js api/clean-message.js
ok "api/auto-prompt.js y api/clean-message.js eliminados (backups en api/_backup/)"

# ----- Paso 6 · Instalar /api/state.js (automático desde staged) ------------
step 6 "Instalar /api/state.js (Supabase-backed kv + timeseries)"

if [ -f "api/state.js" ]; then
  warn "api/state.js ya existe — sobreescribiendo con versión staged (idempotente)"
fi
cp "$STAGED_DIR/state.js" "api/state.js"
ok "api/state.js instalado desde staged ($(wc -l < api/state.js | tr -d ' ') líneas)"

if ! node --check api/state.js >/dev/null 2>&1; then
  err "api/state.js NO pasa node --check. Aborto."
  exit 1
fi
ok "Sintaxis JS válida"

# ----- Paso 7 · Slot Vercel = 11 (post-Frente B fusión reactivation→webhook) --
step 7 "Validar slot Vercel /api/*.js = 11"

# Estado esperado post-Sprint 1:
# - Frente B (18 may) fusionó reactivation-check.js → webhook.js (12 → 11)
# - Sprint 1 Paso 5 fusionó auto-prompt + clean-message → text-utils (-1)
# - Sprint 1 Paso 6 agregó state.js (+1)
# Total: 11 - 1 + 1 = 11
COUNT=$(ls api/*.js 2>/dev/null | wc -l | tr -d ' ')
echo "  Archivos en /api/*.js: $COUNT"
if [ "$COUNT" -ne 11 ]; then
  err "Slot Vercel desbalanceado: hay $COUNT archivos, debería haber 11."
  err "Lista actual:"
  ls api/*.js
  err "Acción: revisar diff con git status. NO continuar."
  exit 1
fi
ok "Slot Vercel correcto (11/12 · libre 1 slot para conversation-intel.js futuro)"

# ----- Paso 8 · Deploy ------------------------------------------------------
step 8 "Deploy a producción"

ask "Listo para deploy a producción (vercel --prod --yes)"
vercel --prod --yes
ok "Deploy completado"

# ----- Paso 9 · Smoke tests -------------------------------------------------
step 9 "Smoke tests (curl)"

PROD_URL="${PROD_URL:-https://giolens.vercel.app}"
echo "  PROD_URL = $PROD_URL  (override con: export PROD_URL=...)"

echo ""
echo "  9.1 /api/text-utils?op=clean&text=hola##ESTADO:TEST##"
HTTP_CODE=$(curl -s -o /tmp/giolens_text_utils.out -w '%{http_code}' \
  --get --data-urlencode 'op=clean' --data-urlencode 'text=hola##ESTADO:TEST##' \
  "$PROD_URL/api/text-utils" || echo "000")
if [ "$HTTP_CODE" != "200" ]; then
  err "  text-utils respondió HTTP $HTTP_CODE (esperaba 200)"
  err "  Body: $(head -c 200 /tmp/giolens_text_utils.out)"
  err "  Revisa logs: vercel logs --prod"
  exit 1
fi
# Validar payload: debe tener { "clean": "hola" } (sin el tag)
CLEAN_VAL=$(jq -r '.clean // "MISSING"' /tmp/giolens_text_utils.out)
if [ "$CLEAN_VAL" = "hola" ]; then
  ok "  text-utils 200 OK con clean=\"hola\" (tag eliminado correctamente)"
else
  err "  text-utils 200 pero payload incorrecto. Esperaba clean=\"hola\", got: \"$CLEAN_VAL\""
  err "  Body completo: $(cat /tmp/giolens_text_utils.out)"
  exit 1
fi

echo ""
echo "  9.2 /api/state?op=kv-get&key=ai_context"
HTTP_CODE=$(curl -s -o /tmp/giolens_state.out -w '%{http_code}' \
  "$PROD_URL/api/state?op=kv-get&key=ai_context" || echo "000")
if [ "$HTTP_CODE" != "200" ]; then
  err "  state respondió HTTP $HTTP_CODE (esperaba 200)"
  err "  Body: $(head -c 200 /tmp/giolens_state.out)"
  exit 1
fi
# Validar payload: debe tener { "key": "ai_context", "found": true, "value": {} }
# (seeded como objeto vacío en el SQL schema sección 7)
KEY_VAL=$(jq -r '.key // "MISSING"' /tmp/giolens_state.out)
FOUND_VAL=$(jq -r '.found // false' /tmp/giolens_state.out)
if [ "$KEY_VAL" = "ai_context" ] && [ "$FOUND_VAL" = "true" ]; then
  ok "  state 200 OK con key=ai_context, found=true"
else
  err "  state 200 pero payload incorrecto. key=\"$KEY_VAL\" found=\"$FOUND_VAL\""
  err "  Body completo: $(cat /tmp/giolens_state.out)"
  err "  Verifica que el SQL schema (SECCIÓN 7) se aplicó correctamente"
  exit 1
fi

echo ""
echo "  9.3 /api/text-utils?op=prompt — health check sin POST (debe devolver 405)"
HTTP_CODE=$(curl -s -o /tmp/giolens_prompt_get.out -w '%{http_code}' \
  "$PROD_URL/api/text-utils?op=prompt" || echo "000")
if [ "$HTTP_CODE" = "405" ]; then
  ok "  text-utils?op=prompt rechaza GET correctamente (405)"
else
  warn "  text-utils?op=prompt respondió $HTTP_CODE (esperaba 405). Verificar."
fi

# ----- Paso 10 · Evals ------------------------------------------------------
step 10 "Ejecutar evals (motores deben seguir pasando)"

if [ ! -f "evals/run-all.js" ]; then
  warn "evals/run-all.js no existe. Skip."
else
  node evals/run-all.js
  ok "Evals ejecutados"
fi

echo ""
echo "============================================================================"
echo "  MIGRACIÓN FASE 1 SPRINT 1 COMPLETADA"
echo "============================================================================"
echo "  Próximo paso: actualizar memory/project_giolens_fases.md marcando"
echo "  Fase 1 Sprint 1 como cerrada y arrancar Sprint 2."
echo ""

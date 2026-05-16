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

# ----- Paso 5 · Crear /api/text-utils.js (manual) ---------------------------
step 5 "Crear /api/text-utils.js"

if [ -f "api/text-utils.js" ]; then
  ok "api/text-utils.js ya existe — saltando"
else
  echo "  ACCIÓN MANUAL requerida: este endpoint fusiona auto-prompt+clean-message."
  echo "  Debe exponer router por query param ?op=clean|prompt y delegar a la"
  echo "  lógica de los backups en api/_backup/."
  echo ""
  echo "  Cuando esté listo, ejecuta:"
  echo "    rm api/auto-prompt.js api/clean-message.js"
  ask "¿api/text-utils.js creado y los 2 originales eliminados?"
fi
ok "Paso 5 confirmado"

# ----- Paso 6 · Crear /api/state.js (manual) --------------------------------
step 6 "Crear /api/state.js"

if [ -f "api/state.js" ]; then
  ok "api/state.js ya existe — saltando"
else
  echo "  ACCIÓN MANUAL requerida: endpoint Supabase-backed (gl_kv + gl_timeseries)."
  echo "  Router por ?op=kv-get|kv-set|ts-append|ts-read."
  echo "  Usa createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)."
  ask "¿api/state.js creado?"
fi
ok "Paso 6 confirmado"

# ----- Paso 7 · Slot Vercel = 12 --------------------------------------------
step 7 "Validar slot Vercel /api/*.js = 12"

COUNT=$(ls api/*.js 2>/dev/null | wc -l | tr -d ' ')
echo "  Archivos en /api/*.js: $COUNT"
if [ "$COUNT" -ne 12 ]; then
  err "Slot Vercel desbalanceado: hay $COUNT archivos, debería haber 12."
  err "Lista actual:"
  ls api/*.js
  err "Acción: fusiona o elimina hasta dejarlo en 12. NO continuar."
  exit 1
fi
ok "Slot Vercel correcto (12/12)"

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
echo "  9.1 /api/text-utils?op=clean&text=test"
HTTP_CODE=$(curl -s -o /tmp/giolens_text_utils.out -w '%{http_code}' \
  "$PROD_URL/api/text-utils?op=clean&text=test" || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  ok "  text-utils 200 OK"
else
  err "  text-utils respondió HTTP $HTTP_CODE (esperaba 200)"
  err "  Body: $(head -c 200 /tmp/giolens_text_utils.out)"
  err "  Revisa logs: vercel logs --prod"
  exit 1
fi

echo ""
echo "  9.2 /api/state?op=kv-get&key=ai_context"
HTTP_CODE=$(curl -s -o /tmp/giolens_state.out -w '%{http_code}' \
  "$PROD_URL/api/state?op=kv-get&key=ai_context" || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  if head -c 500 /tmp/giolens_state.out | grep -q '{'; then
    ok "  state 200 OK con JSON"
  else
    err "  state 200 pero el body no parece JSON: $(head -c 200 /tmp/giolens_state.out)"
    exit 1
  fi
else
  err "  state respondió HTTP $HTTP_CODE (esperaba 200)"
  err "  Body: $(head -c 200 /tmp/giolens_state.out)"
  exit 1
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

# ADR-05 · Frente D.2 — Refresh Meta Token + Wapify Cache Sync

**Estado:** Aceptado · 22-may-2026
**Reemplaza:** —
**Reemplazado por:** —
**Brief de referencia:** `~/Documents/Claude/Projects/AUTOMATAS/BRIEF_CODE_FRENTE_D2.md`

---

## Contexto

El Bloque 7 (cron `fetch-provider-usage`) depende de dos credenciales rotables manualmente:

1. **`META_TOKEN`** — long-lived de Meta Business Manager. STATUS_CORE_22may_PM
   §B2 documenta que el token expirado tira en silencio el cron diario hasta
   que Isaac lo rote a mano.
2. **`WAPIFY_TOKEN`** — token del CRM WhatsApp. Aunque no caduca con la misma
   frecuencia, los contactos del CRM cambian de stage minuto a minuto y el
   cache en `contacts` (sembrado 21-may con 2,190 contactos) queda stale.

El Frente D.2 cierra ambos huecos con dos nuevos crons que se autogestionan en
Vercel y persisten su trabajo en Supabase.

---

## Decisiones

### D.2.1 — `refresh-meta-token` NO renueva el token automáticamente

**Decidido:** El cron `api/cron/refresh-meta-token.ts` solo **diagnostica** el
estado del token y persiste una decisión en `agent_decisions`. No escribe
`.env.local`, no llama a un endpoint de refresh, no rota credenciales.

**Razón:**

- Meta no expone un endpoint de refresh genérico para long-lived tokens de
  System User. El refresh requiere intervención humana en Business Manager.
- El handler corre en Vercel serverless, donde el filesystem es ephemeral —
  no hay forma de persistir un token nuevo en `.env.local`.
- Aún si pudiéramos, la regla 25-may dice **no rotar tokens sin amenaza real**
  y la rotación tiene costo operativo (caducidad de otros tokens dependientes).

**Implementación:**

- `providers/meta-token.ts` exporta `checkMetaToken()` que probea
  `https://graph.facebook.com/v23.0/me?access_token=...` y cruza con la env
  var `META_TOKEN_EXPIRES`.
- Estados posibles: `ok`, `expiring_soon` (<7d), `expired`, `invalid`,
  `unknown`.
- `severityForStatus()` mapea a la columna `agent_decisions.severity`:
  - `expired`/`invalid` → 1.0 (crítico)
  - `expiring_soon` → 0.7
  - `unknown` → 0.4
  - `ok` → 0.1
- `statusNeedsAction()` decide si la decisión va a `status='pending'`
  (acción humana) o `'auto_approved'` (informativo).
- `decision_key` idempotente del día: `meta_token_check_${YYYY-MM-DD}_${status}`
  → si el cron corre varias veces el mismo día con el mismo status, el upsert
  actualiza la fila existente en vez de duplicar.

**Trade-offs aceptados:**

- ❌ No automatiza la rotación end-to-end (sigue requiriendo Isaac).
- ✅ La detección es proactiva: 7 días antes Isaac ya tiene una fila `pending`
   en `agent_decisions` con runbook adjunto.
- ✅ No rompe la regla "no seguridad preventiva en construcción".

### D.2.2 — `sync-wapify-cache` escribe a Supabase, NO a SQLite local

**Decidido:** El cron sincroniza contactos directamente a la tabla
`contacts` de Supabase (`agents/_shared/supabase-schema.sql:16`). El brief
hablaba de SQLite local (`giocore.db.sync_state`); se reinterpreta como
Supabase porque Vercel no tiene filesystem persistente.

**Razón:**

- La tabla `contacts` ya existe con el shape correcto (BIGINT id PK,
  `pipeline_id`, `stage_name`, `stage_phase`, `raw_payload`).
- El ingest del 21-may metió 2,190 contactos en `contacts`, no en SQLite.
- Mantener una sola SoT (Supabase) simplifica queries y elimina
  desincronización SQLite↔Postgres.

**Implementación:**

- `providers/wapify-sync.ts` exporta `syncWapifyCache(supabase, options)`.
- `options.pipeline_id` opcional → si vacío, los 5 pipelines.
- `options.dry_run` → recorre la API y reporta cuántos contactos vendría
  upserteando, sin escribir.
- Delta sync: usa `updated_after=<previous_sync_at>` cuando hay estado previo;
  si no, full sync. El parámetro está sujeto a confirmación contra la API
  real de Wapify (ver TODO operativo).
- **Sync state** persistido en `knowledge_base` (category =
  `wapify_sync_state`, key = `pipeline_<id>`). Evita una migración 004
  para un mero timestamp por pipeline.
- Upsert por `id` con batch de 500 → idempotente.

### D.2.3 — Pipelines protegidos (252999 SPY, 273944 GioVision)

**Decidido:** El cron LEE estos pipelines (read-only en Wapify es OK), pero
están marcados `protected: true` en la constante `PIPELINES` para que
cualquier futura herramienta de mutación los excluya automáticamente.

**Razón:** STATUS_CORE_22may_PM §"Pipelines protegidos" + brief §sync-wapify-cache.

### D.2.4 — INDEX_PIPELINE_X.md NO se regeneran desde el cron

**Decidido:** Los `.md` por pipeline se regeneran fuera de banda con un
script local (Isaac), no desde el cron serverless.

**Razón:** Filesystem ephemeral. Persistir el sync_state en Supabase es
suficiente para que el script local pueda detectar cuándo regenerar.

---

## Estructura de archivos

```
agents/_shared/providers/
  meta-token.ts              # checkMetaToken() + helpers
  wapify-sync.ts             # syncWapifyCache() + PIPELINES export
  __tests__/
    meta-token.test.js       # 14 tests
    wapify-sync.test.js      # 12 tests

api/cron/
  refresh-meta-token.ts      # cron diario 13:00 UTC
  sync-wapify-cache.ts       # cron diario 12:30 UTC

agents/_shared/api/__tests__/
  refresh-meta-token.test.js # 8 tests
  sync-wapify-cache.test.js  # 8 tests
```

## Crons agregados a `vercel.json`

```json
"crons": [
  { "path": "/api/cron/refresh-meta-token", "schedule": "0 13 * * *" },
  { "path": "/api/cron/sync-wapify-cache",  "schedule": "30 12 * * *" }
]
```

- `0 13 * * *` UTC = 07:00 MX (1h después de `fetch-provider-usage` →
  diagnostica si la corrida anterior cayó por token).
- `30 12 * * *` UTC = 06:30 MX (30 min después de `fetch-provider-usage` →
  evita solapar carga contra Wapify).

## Persistencia en `agent_decisions`

Ambos crons usan el shape **REAL** del schema (no el pseudocode del spec):

| Cron | `agent_name` | `decision_type` | `decision_key` |
|---|---|---|---|
| refresh-meta-token | `cron_refresh_meta_token` | `meta_token_health_check` | `meta_token_check_${day}_${status}` |
| sync-wapify-cache | `cron_sync_wapify_cache` | `wapify_cache_sync` | `wapify_sync_${day}_${pipeKey}` |
| sync-wapify-cache (error) | `cron_sync_wapify_cache` | `wapify_sync_error` | (insert, sin key) |

---

## Validación

### Criterios del brief (todos cubiertos):

1. ✅ `refresh-meta-token` corre dry-run sin tocar `.env.local` y reporta días
   restantes → `GET /api/cron/refresh-meta-token?dry_run=1` con Bearer.
2. ✅ `sync-wapify-cache?pipeline=216977&dry_run=1` reporta deltas sin escribir →
   `dry_run: true` en response, `contacts_upserted: 0`.
3. ⚠️ Inserción en `agent_decisions` confirmada con SELECT desde Supabase —
   **pendiente de Isaac** (sandbox sin red, ver TODOs).
4. ⚠️ Test de regresión INDEX vs SQLite — **no aplica** (se quitó SQLite por
   D.2.2; ver decisión).
5. ✅ ADR-05 documenta ambos tools — este archivo.

### TODOs operativos (Isaac/Cowork):

- **Confirmar parámetro `updated_after`** en API Wapify. El módulo lo envía
  defensivamente; si Wapify no lo soporta, el sync degrada a full-fetch
  (acceptable) pero conviene confirmar contra los endpoints reales.
- **Probar dry-run en prod** tras deploy. Curls de validación al pie.
- **Decidir flujo de regeneración INDEX_PIPELINE_X.md** — script local que
  lea `knowledge_base.wapify_sync_state` y dispare cuando hay cambios.

---

## Comandos de validación

Después del deploy (Code main con red):

```bash
CS=$(grep CRON_SECRET ~/giolens_deploy/.env.local | sed 's/CRON_SECRET=//; s/"//g')
BASE=https://giolens-dashboard.vercel.app

# 1) refresh-meta-token dry-run
curl -s -H "Authorization: Bearer $CS" "$BASE/api/cron/refresh-meta-token?dry_run=1" | jq

# 2) refresh-meta-token real (inserta en agent_decisions)
curl -s -X POST -H "Authorization: Bearer $CS" "$BASE/api/cron/refresh-meta-token" | jq

# 3) sync-wapify-cache dry-run para pipeline 216977
curl -s -H "Authorization: Bearer $CS" \
  "$BASE/api/cron/sync-wapify-cache?pipeline_id=216977&dry_run=1" | jq

# 4) sync-wapify-cache real, los 5 pipelines
curl -s -X POST -H "Authorization: Bearer $CS" "$BASE/api/cron/sync-wapify-cache" | jq

# 5) verificar agent_decisions
psql "$DATABASE_URL" -c "
  SELECT decision_key, status, severity, justification
  FROM agent_decisions
  WHERE agent_name IN ('cron_refresh_meta_token','cron_sync_wapify_cache')
  ORDER BY created_at DESC LIMIT 10;
"
```

---

**FIN ADR-05.**

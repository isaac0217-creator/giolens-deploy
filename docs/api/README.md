---
title: GioLens API — Índice de Endpoints
file_path: /docs/api/README.md
last_updated: 2026-05-18
---

# GioLens API — Documentación de Endpoints

Documentación operativa de los endpoints serverless desplegados en Vercel para el ecosistema GioLens Vision Care (óptica, Tijuana MX).

- **URL base producción**: `https://giolens-dashboard.vercel.app`
- **Runtime**: Node.js 18 (módulos ES, `export default async function handler`)
- **Hosting**: **Vercel Pro** ($20/mes) — slot real **10/12** (2 libres). El upgrade Pro elimina el límite duro del plan Hobby; conservamos la disciplina de slot como buena práctica.
- **Timeout**: 60 s en 8 endpoints listados en `vercel.json`; los 2 restantes (`meta`, `token-status`) corren con default 10 s.
- **Cron Vercel activo**: `*/5 * * * *` en `/api/webhook?mode=cron` (red de seguridad para reactivación + auto-refresh META_TOKEN).
- **Observabilidad**: wrapper `withSentry(handler)` integrado en 3 endpoints críticos (webhook, copiloto, text-utils). No-op hasta entregar `SENTRY_DSN`.

> **Reglas inamovibles:** ningún cambio en `/api/` debe consumir un slot adicional sin justificación. Toda fusión preserva los nombres de etapas tal cual aparecen en Wapify (incluidos typos como `COTIZcion`, `NT3 · COMPARATIVA`, `NECESIDAD DETECTADA ` con espacio final).

---

## Tabla maestra de endpoints (10/12 slots ocupados)

| # | Endpoint | Métodos | Propósito | Auth | Timeout |
|---|----------|---------|-----------|------|---------|
| 1 | [`/api/webhook`](./webhook.md) | GET, POST, OPTIONS | Webhook principal de Wapify — despacha al motor Claude del pipeline (5 motores) + **cron unificado** (`?mode=cron`: reactivación leads 4-12 min + auto-refresh META_TOKEN) | `WAPIFY_TOKEN` + `ANTHROPIC_API_KEY` + `META_TOKEN` | 60 s |
| 2 | [`/api/copiloto`](./copiloto.md) | GET, POST, OPTIONS | Motor #5 — Genera script para vendedor según pipeline+etapa+conversación | `ANTHROPIC_API_KEY` server-side | 60 s |
| 3 | [`/api/predictor`](./predictor.md) | GET, POST | Motor #2 — Detecta alzas de CPC (>15%) y leads estancados (>48h) | `META_TOKEN` + `WAPIFY_TOKEN` + `ANTHROPIC_API_KEY` | 60 s |
| 4 | [`/api/microseg`](./microseg.md) | GET, POST | Motor #3 — Clasifica leads en 4 segmentos (caliente/activo/tibio/frío) — **CPRs dinámicos con fallback** (R-06) | `WAPIFY_TOKEN` + `ANTHROPIC_API_KEY` | 60 s |
| 5 | [`/api/arbitraje`](./arbitraje.md) | GET, POST | Motor #4 — Score por campaña Meta y recomendación de redistribución de presupuesto | `META_TOKEN` + `ANTHROPIC_API_KEY` | 60 s |
| 6 | [`/api/pipeline-summary`](./pipeline-summary.md) | GET, OPTIONS | CRM summary + journey + metrics (3 modos) — fusionado con `crm-metrics` | `WAPIFY_TOKEN` server-side | 60 s |
| 7 | `/api/text-utils` ⚡ | GET, POST, OPTIONS | **Fusión Sprint 1** — Router `?op=clean` (strip ##ESTADO##, ex `clean-message`) + `?op=prompt` (3 variantes, ex `auto-prompt`) | `ANTHROPIC_API_KEY` (solo `?op=prompt`) | 60 s |
| 8 | `/api/state` ⚡ | GET, POST | **Nuevo Sprint 1** — Supabase-backed kv + timeseries: `?op=kv-get`, `?op=kv-set`, `?op=ts-append`, `?op=ts-read`. Reemplaza localStorage | `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | 60 s |
| 9 | [`/api/meta`](./meta.md) | GET, OPTIONS | Datos Meta Ads (overview / campaign / daily) | `META_TOKEN` server-side | 10 s |
| 10 | [`/api/token-status`](./token-status.md) | GET, OPTIONS | Health check — fechas de expiración de tokens (no expone los tokens) | Pública | 10 s |

**Slots libres (2/12):** reservados para Capa 07 — `prompt-templates.js` y `conversation-intel.js` (pendientes de implementación).

### Endpoints eliminados / fusionados (no usar — documentación legacy en repo solo para referencia git)

| Endpoint legacy | Estado | Reemplazo | Commit |
|---|---|---|---|
| `/api/auto-prompt` | ❌ Fusionado | `/api/text-utils?op=prompt` | Sprint 1 (16 may) |
| `/api/clean-message` | ❌ Fusionado | `/api/text-utils?op=clean` | Sprint 1 (16 may) |
| `/api/reactivation-check` | ❌ Fusionado | `/api/webhook?mode=cron` | `1d6fbf1` (18 may) |
| `/api/proxy` | ❌ Eliminado | — (legacy v9 sin callers vivos) | `d7ddf9b` (18 may) |
| `/api/crm-metrics` | ❌ Fusionado | `/api/pipeline-summary` (modos) | pre-Sprint 1 |

> Los archivos `auto-prompt.md`, `clean-message.md`, `reactivation-check.md` en este directorio están **obsoletos** y pendientes de deprecation banner o eliminación (backlog Cowork posterior). Los nuevos endpoints `text-utils` y `state` requieren docs propios (también backlog).

---

## Auth — Reglas por categoría

### Endpoints con secretos server-side

Nunca filtran tokens al cliente. Las variables `WAPIFY_TOKEN`, `META_TOKEN`, `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` se leen vía `process.env` y se inyectan en cabeceras (`X-ACCESS-TOKEN`, `x-api-key`, `access_token` query, `Authorization`).

- `webhook`, `predictor`, `microseg`, `arbitraje`, `pipeline-summary`, `meta`, `copiloto`, `text-utils` (op=prompt), `state`

### Endpoints con Claude (Anthropic) — modelo Haiku 4.5

Todos usan `claude-haiku-4-5` vía `https://api.anthropic.com/v1/messages` con `anthropic-version: 2023-06-01`.

- `webhook` (5 motores + 5 tools de bot), `text-utils` (op=prompt), `copiloto`, `predictor`, `microseg`, `arbitraje`

Los endpoints que envían `system` con `cache_control: { type: 'ephemeral' }` (caching) son: `webhook`, `text-utils` (op=prompt), `copiloto`.

### Endpoints públicos

- `token-status` — solo devuelve flags y `daysLeft`, jamás los tokens
- `text-utils?op=clean` — utility sin secretos, llamada por Wapify HTTP Action

### Validación de origen

Ningún endpoint actual valida `origin`/`referer` contra whitelist. Todos envían `Access-Control-Allow-Origin: *`. (Validación había vivido en `/api/proxy`, eliminado 18 may PM por ser legacy sin callers vivos.)

### Observabilidad — wrapper `withSentry`

Endpoints envueltos con `withSentry(handler, { endpoint })` en su `export default`:
- `webhook` · `copiloto` · `text-utils`

El wrapper es no-op cuando `SENTRY_DSN` no está configurada (estado actual). Captura errores no manejados + crash + tags `endpoint`/`method`/`pipeline`. Activar: `vercel env add SENTRY_DSN production && vercel --prod`.

---

## Dependencias externas por endpoint

| Endpoint | Meta Graph | Wapify | Anthropic | Supabase | Llama a otro endpoint |
|----------|:----------:|:------:|:---------:|:--------:|------------------------|
| `webhook` | ✅ (`mode=cron` META refresh) | ✅ | ✅ | — | — |
| `copiloto` | — | — | ✅ | — | — |
| `predictor` | ✅ | ✅ | ✅ | — | — |
| `microseg` | — | ✅ | ✅ | — | — |
| `arbitraje` | ✅ | — | ✅ | — | — |
| `pipeline-summary` | — | ✅ | — | — | — |
| `text-utils` | — | — | ✅ (op=prompt) | — | — |
| `state` | — | — | — | ✅ | — |
| `meta` | ✅ | — | — | — | — |
| `token-status` | — | — | — | — | — |

**URLs externas:**
- **Meta Graph**: `https://graph.facebook.com/v19.0`
- **Wapify**: `https://ap.whapify.ai/api`
- **Anthropic**: `https://api.anthropic.com/v1/messages`
- **Supabase**: `${SUPABASE_URL}` (configurada en env vars, formato `https://<project>.supabase.co`)

---

## Variables de entorno

| Variable | Usada por | Notas |
|----------|-----------|-------|
| `WAPIFY_TOKEN` | webhook, predictor, microseg, pipeline-summary | Token API Wapify (`X-ACCESS-TOKEN: 1187373.…`) |
| `META_TOKEN` | meta, predictor, arbitraje, webhook (cron refresh) | **System User Token** (no expira mientras la app exista) + cron auto-refresh activo como red de seguridad |
| `META_TOKEN_EXPIRES` | token-status | Fecha ISO `YYYY-MM-DD` de vencimiento Meta token (legacy — System User Token no expira) |
| `ANTHROPIC_API_KEY` | webhook, text-utils, copiloto, predictor, microseg, arbitraje | Clave de Anthropic API |
| `SUPABASE_URL` | state | URL del proyecto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | state | Key formato `sb_secret_*` (NO JWT clásico `eyJ…`). Validar con regex `sb_(publishable\|secret)_[A-Za-z0-9_-]+` |
| `REACTIVATION_DRY_RUN` | webhook (mode=cron) | `'false'` para activar envíos reales; cualquier otro valor → solo log. **Actual: `'true'`** (no cambiar sin confirmación de Isaac) |
| `SENTRY_DSN` | webhook, copiloto, text-utils (vía `withSentry`) | ⏳ Pendiente entrega Isaac. Wrapper es no-op hasta entonces |
| `VERCEL_URL` | webhook (mode=cron) | Provista por Vercel para auto-discovery de URL absoluta |

---

## Pipelines reales (IDs Wapify)

| ID | Nombre | CPR fallback | Motor archivo |
|----|--------|--------------|---------------|
| `216977` | Justin · Holbrook · Litebeam | $8.64 MXN | `motorJustinHolbrook` |
| `755062` | GioSports · Deportivo | $10.29 MXN | `motorGioSports` |
| `252999` | SPY Z87 · Seguridad Industrial | $15.20 MXN | `motorSpyZ87` |
| `94103` | Dama · Luxury | $23.53 MXN | `motorDamaLuxury` |
| `273944` | GioVision · Entintados | $27.78 MXN | `motorGioVision` |

> **Nota CPRs (R-06):** Desde el commit `aa43fa6` los CPRs en `microseg.js` son **dinámicos con fallback**. El sistema calcula CPR real desde datos Meta y usa los valores arriba como fallback cuando faltan datos.

Ver [_glossary.md](./_glossary.md) para detalle de etapas, INT1/INT2/INT3, rutas y convenciones de nombres.

---

## Cuenta Meta Ads activa

- **Portafolio nuevo (activo)**: `act_299921604429631` — predictor, arbitraje, default de `meta`
- **Portafolio anterior**: `act_2241343302609141` — accesible via `meta?account=anterior`

---

## Verificación de salud

```bash
# Motores activos (GET = status)
curl https://giolens-dashboard.vercel.app/api/webhook
curl https://giolens-dashboard.vercel.app/api/predictor
curl https://giolens-dashboard.vercel.app/api/microseg
curl https://giolens-dashboard.vercel.app/api/arbitraje
curl https://giolens-dashboard.vercel.app/api/copiloto

# Fusiones Sprint 1
curl 'https://giolens-dashboard.vercel.app/api/text-utils?op=clean&text=hello%20%23%23ESTADO%3Atest%23%23'
curl 'https://giolens-dashboard.vercel.app/api/state?op=kv-get&key=app_version'

# Health de tokens
curl https://giolens-dashboard.vercel.app/api/token-status

# Pipeline summary (snake_case obligatorio en params)
curl 'https://giolens-dashboard.vercel.app/api/pipeline-summary?pipeline_id=216977' | jq '.total'

# Confirmar eliminación de proxy.js (debe ser 404)
curl -o /dev/null -w "%{http_code}\n" https://giolens-dashboard.vercel.app/api/proxy
```

---

## Cron Vercel

```cron
*/5 * * * *  →  /api/webhook?mode=cron
```

Ejecuta cada 5 minutos. Lógica unificada en `webhook.js`:
1. **Reactivación de leads** (silencio 4-12 min, ventana oportunidad 15 min, máx 5 sends/run). Respeta `REACTIVATION_DRY_RUN`.
2. **Auto-refresh META_TOKEN** (red de seguridad — el System User Token no expira por sí solo).

Antes esta lógica vivía en `/api/reactivation-check.js`; fusionado en `1d6fbf1` para liberar slot.

---

## Próximos cambios planificados (Frente C — bloqueado por D1 Chat)

- Wiring operativo LangGraph en `inngest/graph.js`
- Activar panel `public/agents-approvals.html` con feed Supabase Realtime
- Smoke shadow Analista (1 invocación con `shadow=true`)
- Activar `SENTRY_DSN` y verificar evento en dashboard Sentry (10 min — independiente de Frente C)

---

## Referencias

- Handoff maestro: `/Users/chunkuni/Documents/Claude/giolens/giolens_giocore_handoff_v15_multimodel.md`
- Risk register v3.0: `/Users/chunkuni/Documents/Claude/giolens/cowork/risk_register_sprint1.md`
- Schema Supabase: `/agents/_shared/supabase-schema.sql` (313 líneas + `pg_cron` activo)
- Briefing próxima Code: `/Users/chunkuni/Documents/Claude/giolens/cowork/briefing_code_proxima_sesion_v3.md`

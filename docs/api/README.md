---
title: GioLens API — Índice de Endpoints
file_path: /docs/api/README.md
last_updated: 2026-05-15
---

# GioLens API — Documentación de los 12 Endpoints

Documentación operativa de los endpoints serverless desplegados en Vercel para el ecosistema GioLens Vision Care (óptica, Tijuana MX).

- **URL base producción**: `https://giolens-dashboard.vercel.app`
- **Runtime**: Node.js 18 (módulos ES, `export default async function handler`)
- **Hosting**: Vercel Hobby — **slot limit 12/12 (lleno)**. Cualquier endpoint nuevo requiere fusionar con uno existente o pasar a plan Pro.
- **Timeout default**: 10 s; los 5 endpoints listados en `vercel.json` están configurados a **60 s**.

> Reglas inamovibles: ningún cambio en `/api/` debe consumir un slot adicional sin justificación. Toda fusión preserva los nombres de etapas tal cual aparecen en Wapify (incluidos typos como `COTIZcion`, `NT3 · COMPARATIVA`, `NECESIDAD DETECTADA ` con espacio final).

---

## Tabla maestra de endpoints

| # | Endpoint | Métodos | Propósito | Auth | Timeout |
|---|----------|---------|-----------|------|---------|
| 1 | [`/api/auto-prompt`](./auto-prompt.md) | GET, POST, OPTIONS | Motor #1 — Genera 3 variantes de mensaje (urgencia/valor/social proof) por pipeline+etapa | `ANTHROPIC_API_KEY` server-side | 10 s |
| 2 | [`/api/predictor`](./predictor.md) | GET, POST | Motor #2 — Detecta alzas de CPC (>15%) y leads estancados (>48h) | `META_TOKEN` + `WAPIFY_TOKEN` + `ANTHROPIC_API_KEY` | 60 s |
| 3 | [`/api/microseg`](./microseg.md) | GET, POST | Motor #3 — Clasifica leads en 4 segmentos (caliente/activo/tibio/frío) | `WAPIFY_TOKEN` + `ANTHROPIC_API_KEY` | 60 s |
| 4 | [`/api/arbitraje`](./arbitraje.md) | GET, POST | Motor #4 — Score por campaña Meta y recomendación de redistribución de presupuesto | `META_TOKEN` + `ANTHROPIC_API_KEY` | 60 s |
| 5 | [`/api/copiloto`](./copiloto.md) | GET, POST, OPTIONS | Motor #5 — Genera script para el vendedor según pipeline+etapa+conversación | `ANTHROPIC_API_KEY` server-side | 10 s |
| 6 | [`/api/webhook`](./webhook.md) | GET, POST, OPTIONS | Webhook principal de Wapify — despacha al motor Claude del pipeline (5 motores) | `WAPIFY_TOKEN` + `ANTHROPIC_API_KEY` | 10 s |
| 7 | [`/api/reactivation-check`](./reactivation-check.md) | GET, POST, OPTIONS | Cron de reactivación — leads sin responder entre 4-12 min | `WAPIFY_TOKEN` (llama internamente a `/api/copiloto`) | 60 s |
| 8 | [`/api/pipeline-summary`](./pipeline-summary.md) | GET, OPTIONS | CRM summary + journey + metrics (3 modos) — fusionado con `crm-metrics` | `WAPIFY_TOKEN` server-side | 60 s |
| 9 | [`/api/meta`](./meta.md) | GET, OPTIONS | Datos Meta Ads (overview / campaign / daily) | `META_TOKEN` server-side | 10 s |
| 10 | [`/api/token-status`](./token-status.md) | GET, OPTIONS | Health check — fechas de expiración de tokens (no expone los tokens) | Pública | 10 s |
| 11 | [`/api/clean-message`](./clean-message.md) | GET, POST | Utility — elimina tags `##ESTADO:...##` del output de GPT antes de enviar a Wapify | Pública | 10 s |

> ⚠️ **Este README requiere refresh post-Sprint 1 (Cowork backlog).** Cambios materiales no reflejados todavía:
> - `auto-prompt` + `clean-message` fusionados en `text-utils` (`?op=clean|prompt`)
> - `reactivation-check` fusionado en `webhook` (`?mode=cron`)
> - Nuevo endpoint `state` (Supabase-backed kv + ts via `app_config` + `audit_log`)
> - `proxy.js` eliminado 18 may PM (legacy v9 sin callers vivos) — slot libre
> - Plan actual: **Vercel Pro** (no Hobby), timeout real 60 s en 8 funciones
> - Slot actual: **10/12** (queda 2 libres)

---

## Auth — Reglas por categoría

### Endpoints con secretos server-side
Nunca filtran tokens al cliente. Las variables `WAPIFY_TOKEN`, `META_TOKEN`, `ANTHROPIC_API_KEY` se leen vía `process.env` y se inyectan en cabeceras (`X-ACCESS-TOKEN`, `x-api-key`, `access_token` query).

- `webhook`, `predictor`, `microseg`, `arbitraje`, `pipeline-summary`, `meta`, `reactivation-check`

### Endpoints con Claude (Anthropic) — modelo Haiku 4.5
Todos usan `claude-haiku-4-5` vía `https://api.anthropic.com/v1/messages` con `anthropic-version: 2023-06-01`.

- `webhook` (5 motores + 5 tools de bot), `auto-prompt`, `copiloto`, `predictor`, `microseg`, `arbitraje`

Los endpoints que envían `system` con `cache_control: { type: 'ephemeral' }` (caching) son: `webhook`, `auto-prompt`, `copiloto`.

### Endpoints públicos
- `token-status` — solo devuelve flags y `daysLeft`, jamás los tokens
- `clean-message` — utility sin secretos, llamado por Wapify HTTP Action

### Validación de origen
Ningún endpoint actual valida `origin`/`referer` contra whitelist. Todos envían `Access-Control-Allow-Origin: *`. (Validación había vivido en `/api/proxy`, eliminado 18 may PM por ser legacy sin callers.)

---

## Dependencias externas por endpoint

| Endpoint | Meta Graph | Wapify | Anthropic | Llama a otro endpoint |
|----------|:----------:|:------:|:---------:|------------------------|
| `auto-prompt` | — | — | ✅ | — |
| `predictor` | ✅ | ✅ | ✅ | — |
| `microseg` | — | ✅ | ✅ | — |
| `arbitraje` | ✅ | — | ✅ | — |
| `copiloto` | — | — | ✅ | — |
| `webhook` | — | ✅ | ✅ | — |
| `reactivation-check` | — | ✅ | — | `/api/copiloto` |
| `pipeline-summary` | — | ✅ | — | — |
| `meta` | ✅ | — | — | — |
| `token-status` | — | — | — | — |
| `clean-message` | — | — | — | — |

**Resúmenes URL externas**:
- **Meta Graph**: `https://graph.facebook.com/v19.0`
- **Wapify**: `https://ap.whapify.ai/api`
- **Anthropic**: `https://api.anthropic.com/v1/messages`

---

## Variables de entorno

| Variable | Usada por | Notas |
|----------|-----------|-------|
| `WAPIFY_TOKEN` | webhook, predictor, microseg, pipeline-summary, reactivation-check | Token API Wapify (X-ACCESS-TOKEN) |
| `META_TOKEN` | meta, predictor, arbitraje | Token Meta Graph (long-lived, ~60 días) |
| `META_TOKEN_EXPIRES` | token-status | Fecha ISO `YYYY-MM-DD` de vencimiento Meta token |
| `ANTHROPIC_API_KEY` | webhook, auto-prompt, copiloto, predictor, microseg, arbitraje | Clave de Anthropic API |
| `REACTIVATION_DRY_RUN` | reactivation-check | `'false'` para activar envíos reales; cualquier otro valor → solo log |
| `VERCEL_URL` | reactivation-check | Provista por Vercel para auto-discovery de URL absoluta |

---

## Pipelines reales (IDs Wapify)

| ID | Nombre | CPR | Motor archivo |
|----|--------|-----|---------------|
| `216977` | Justin · Holbrook · Litebeam | $8.64 MXN | `motorJustinHolbrook` |
| `755062` | GioSports · Deportivo | $10.29 MXN | `motorGioSports` |
| `252999` | SPY Z87 · Seguridad Industrial | $15.20 MXN | `motorSpyZ87` |
| `94103` | Dama · Luxury | $23.53 MXN | `motorDamaLuxury` |
| `273944` | GioVision · Entintados | $27.78 MXN | `motorGioVision` |

Ver [_glossary.md](./_glossary.md) para detalle de etapas, INT1/INT2/INT3, rutas y convenciones de nombres.

---

## Cuenta Meta Ads activa

- **Portafolio nuevo (activo)**: `act_299921604429631` — predictor, arbitraje, default de `meta`
- **Portafolio anterior**: `act_2241343302609141` — accesible via `meta?account=anterior`

---

## Verificación de salud

```bash
# Cada motor expone GET = status
curl https://giolens-dashboard.vercel.app/api/webhook
curl https://giolens-dashboard.vercel.app/api/auto-prompt
curl https://giolens-dashboard.vercel.app/api/predictor
curl https://giolens-dashboard.vercel.app/api/microseg
curl https://giolens-dashboard.vercel.app/api/arbitraje
curl https://giolens-dashboard.vercel.app/api/copiloto

# Health de tokens
curl https://giolens-dashboard.vercel.app/api/token-status
```

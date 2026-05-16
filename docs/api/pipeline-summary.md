---
title: /api/pipeline-summary — CRM Summary + Journey + Metrics
file_path: /docs/api/pipeline-summary.md
source: /api/pipeline-summary.js
last_updated: 2026-05-15
---

# `/api/pipeline-summary`

Endpoint multi-modo que cubre 3 vistas distintas de un pipeline Wapify:
1. **Modo estándar** — conteo de leads por etapa.
2. **Modo journey** — agrupa etapas en fases (INT1/INT2/INT3/Cierre/Won/Lost) y calcula tasas de avance.
3. **Modo métricas** — estancamiento >48h, won/lost/active, tasa de cierre, horas promedio por etapa.

> Resultado de una fusión deliberada de `crm-metrics.js` en este archivo para respetar el límite de 12/12 slots Vercel Hobby.

## URL

```
GET     https://giolens-dashboard.vercel.app/api/pipeline-summary?pipeline_id={pid}
GET     https://giolens-dashboard.vercel.app/api/pipeline-summary?pipeline_id={pid}&mode=journey
GET     https://giolens-dashboard.vercel.app/api/pipeline-summary?pipeline_id={pid}&mode=metrics
GET     https://giolens-dashboard.vercel.app/api/pipeline-summary?all=1&mode=metrics
OPTIONS (CORS preflight)
```

## Métodos

Solo `GET` (y `OPTIONS` para CORS). `POST` y otros métodos NO están bloqueados explícitamente pero retornan resultados raros porque no hay `req.body`.

## Query params

| Param | Tipo | Requerido | Notas |
|-------|------|-----------|-------|
| `pipeline_id` | string | ✅ (excepto en `all=1&mode=metrics`) | ID Wapify del pipeline |
| `mode` | `'journey'` \| `'metrics'` \| undefined | — | Vacío = modo estándar |
| `all` | `'1'` | — | Solo en `mode=metrics` — devuelve métricas de los 5 pipelines |

## Response 200 — Modo estándar

`GET /api/pipeline-summary?pipeline_id=216977`

```json
{
  "pipeline_id":   "216977",
  "total":         312,
  "pages_fetched": 4,
  "stageCounts": [
    { "id": 1,  "name": "NUEVO",                "count": 89 },
    { "id": 5,  "name": "INT2 · CATÁLOGO",      "count": 42 },
    { "id": 17, "name": "VENTA CONFIRMADA",     "count": 28 },
    { "id": 19, "name": "CLIENTE GANADO",       "count": 15 }
  ],
  "generated_at":  "2026-05-15T20:30:00.000Z"
}
```

## Response 200 — Modo journey

`GET /api/pipeline-summary?pipeline_id=216977&mode=journey`

Agrega `phase` por etapa + `by_phase` + `funnel_rates`.

```json
{
  "pipeline_id":   "216977",
  "total":         312,
  "pages_fetched": 4,
  "stageCounts":   [ { "id": 1, "name": "NUEVO", "count": 89, "phase": "int1" } ],
  "active_leads":  220,
  "by_phase": {
    "int1":    134,
    "int2":    52,
    "int3":    20,
    "closing": 14,
    "won":     43,
    "lost":    49
  },
  "funnel_rates": {
    "int1_to_int2_pct": 39,
    "int2_to_int3_pct": 28,
    "overall_won_pct":  14
  },
  "stage_detail": [
    { "id": 5, "name": "INT2 · CATÁLOGO", "phase": "int2", "count": 42 }
  ],
  "generated_at":  "2026-05-15T20:30:00.000Z"
}
```

**Phases** (función `classifyStage`):
- `won`: VISITA CONFIRMADA, VENTA CONFIRMADA, CLIENTE GANADO
- `lost`: FUERA DE CATÁLOGO, CATCH-ALL, LEAD PERDIDO
- `int3`: contiene `INT3` o `NT3`
- `int2`: contiene `INT2`
- `closing`: contiene `UBICACI` o matchea `METODO.*PAGO` (cubre `METODO PAGO` y `MÉTODO DE PAGO`)
- `int1`: cualquier otra (default)

Normalización: `.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g,'')` — quita acentos antes de matchear.

## Response 200 — Modo métricas

`GET /api/pipeline-summary?pipeline_id=216977&mode=metrics`

```json
{
  "pipeline_id":     "216977",
  "total":           312,
  "won":             43,
  "lost":            49,
  "active":          220,
  "stagnantTotal":   22,
  "stagnantRate":    10.0,
  "stagnantByStage": { "COTIZADO": 12, "INT2 · CATÁLOGO": 10 },
  "avgHoursByStage": { "NUEVO": 4.2, "COTIZADO": 38.1, "INT2 · CATÁLOGO": 56.3 },
  "convRate":        46.7,
  "generated_at":    "2026-05-15T20:30:00.000Z"
}
```

| Métrica | Cálculo |
|---------|---------|
| `won` | etapas en `WIN_STAGE_NAMES` |
| `lost` | etapas en `LOST_STAGE_NAMES` |
| `active` | total − won − lost |
| `stagnantTotal` | leads `active` con `updated_at` > 48h atrás |
| `stagnantRate` | `stagnantTotal / active * 100` (1 decimal) |
| `convRate` | `won / (won + lost) * 100` (1 decimal); `null` si no hay terminales |

## Response 200 — Modo métricas all=1

`GET /api/pipeline-summary?all=1&mode=metrics`

```json
{
  "data": [
    { "pipeline_id": "216977", "total": 312, "won": 43, "lost": 49, "...": "..." },
    { "pipeline_id": "755062", "total": 198, "won": 22, "lost": 31, "...": "..." },
    { "pipeline_id": "252999", "total": 144, "won": 18, "lost": 12, "...": "..." },
    { "pipeline_id": "94103",  "total": 267, "won": 14, "lost": 47, "...": "..." },
    { "pipeline_id": "273944", "total": 182, "won": 27, "lost": 22, "...": "..." }
  ]
}
```

Pipelines fallidos se reportan como `{ pipeline_id, error: '<mensaje>' }` (no rompe los exitosos — usa `Promise.allSettled`).

## Response 400

- `pipeline_id requerido` (modo estándar/journey)
- `pipeline_id o all=1 requerido` (modo métricas)

## Response 500

- `{ error: '<mensaje>' }` — error de red, parse, etc.

## Dependencies

- **Wapify** `https://ap.whapify.ai/api`
  - `GET pipelines/{pid}/stages` (solo modos estándar/journey)
  - `GET pipelines/{pid}/opportunities?limit=100&offset=N` (todos los modos)
- `wapGet()` tiene **retry con backoff** ante 429: 3 reintentos, backoff `1200ms × 1.5^n`.

## Side effects

- ❌ Solo lectura.

## Caller

- **Dashboard GIOCORE** — tarjetas de pipeline (modo estándar), embudo de conversiones (journey), tablero de salud (metrics).
- Posiblemente otros endpoints internos (no se observa caller actual desde el código).

## Env vars

| Var | Uso |
|-----|-----|
| `WAPIFY_TOKEN` | Auth Wapify |

## Notas operativas

- **Timeout**: 60 s (`vercel.json`). Necesario por `mode=metrics&all=1` que pagina 5 pipelines × hasta 50 páginas.
- **Sin cache HTTP**: cada llamada vuelve a paginar todo. El dashboard debe limitar la frecuencia o implementar cache en el cliente.
- **Normalización segura**: `classifyStage` y `normalizeStage` quitan acentos para matching, pero los nombres devueltos en `stageCounts[].name` preservan los acentos originales de Wapify.
- **Pipeline 94103** usa `MÉTODO DE PAGO`; 216977/755062 usan `METODO PAGO` — el regex `METODO.*PAGO` cubre ambos.
- **Pipeline 273944** (GioVision) no usa journey 3-interacciones; sus etapas caen mayormente en `int1` (default). No es bug, es intencional.
- **`pages_fetched`** = `Math.ceil(total / 100)`, útil para diagnosticar paginación lenta.
- **Etapas terminales**: definidas en 2 lugares — `WIN_STAGE_NAMES` / `LOST_STAGE_NAMES` (para métricas) y dentro de `classifyStage` (para journey). Mantener en sincronía.

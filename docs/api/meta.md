---
title: /api/meta — Datos Meta Ads
file_path: /docs/api/meta.md
source: /api/meta.js
last_updated: 2026-05-15
---

# `/api/meta`

Proxy autenticado a Meta Graph para insights de Ads. Soporta 3 modos:
- **Overview** (default) — totales semana actual + semana anterior.
- **Campaign** — desglose por campaña (incluye `prev` por campaña).
- **Daily** — series temporales diarias (últimos 30 días) con extracción de conversaciones WhatsApp.

## URL

```
GET     https://giolens-dashboard.vercel.app/api/meta
GET     https://giolens-dashboard.vercel.app/api/meta?account=anterior
GET     https://giolens-dashboard.vercel.app/api/meta?level=campaign
GET     https://giolens-dashboard.vercel.app/api/meta?level=daily&days=30
OPTIONS (CORS preflight)
```

## Métodos

Solo `GET` y `OPTIONS`. Otros métodos no están bloqueados pero no se documentan.

## Query params

| Param | Valores | Default | Notas |
|-------|---------|---------|-------|
| `account` | `'nuevo'` \| `'anterior'` | `'nuevo'` | `nuevo` = `act_299921604429631`, `anterior` = `act_2241343302609141` |
| `level` | `'campaign'` \| `'daily'` \| undefined | overview | |
| `days` | número | `30` | Solo en `level=daily` |

## Response 200 — Overview (default)

```json
{
  "curr": {
    "spend": "12150.30",
    "cpc": "5.10",
    "cpm": "92.45",
    "impressions": "131400",
    "clicks": "2382",
    "ctr": "1.81",
    "reach": "89421",
    "actions": [
      { "action_type": "onsite_conversion.messaging_conversation_started_7d", "value": "1404" }
    ]
  },
  "prev": {
    "spend": "11020.55",
    "cpc": "4.85",
    "cpm": "88.10",
    "impressions": "125100",
    "clicks": "2272",
    "ctr": "1.81",
    "reach": "85100",
    "actions": []
  }
}
```

## Response 200 — `level=campaign`

```json
{
  "data": [
    {
      "campaign_id":   "120243518605340263",
      "campaign_name": "Justin · Holbrook · Prospección",
      "spend": "4250.30",
      "cpc": "2.10",
      "ctr": "2.45",
      "clicks": "2024",
      "impressions": "82561",
      "actions": [ { "action_type": "onsite_conversion.messaging_conversation_started_7d", "value": "560" } ],
      "prev": {
        "campaign_id": "120243518605340263",
        "spend": "3900.00",
        "cpc": "2.30",
        "ctr": "2.18",
        "clicks": "1696"
      }
    }
  ]
}
```

## Response 200 — `level=daily`

```json
{
  "data": [
    { "date": "2026-04-15", "spend": 380.20, "impressions": 4321, "clicks": 78, "conv": 9 },
    { "date": "2026-04-16", "spend": 412.10, "impressions": 4711, "clicks": 85, "conv": 11 }
  ]
}
```

`conv` se extrae buscando en `actions` el primer `action_type` que matchea (en orden):
```
onsite_conversion.messaging_conversation_started_7d
messaging_conversation_started_7d
onsite_conversion.messaging_conversation_started_1d
messaging_conversation_started
```

## Response 500

`{ error: '<mensaje>' }`

## Dependencies

- **Meta Graph** `https://graph.facebook.com/v19.0`
  - `GET {account}/insights?fields=...&time_range={curr}` + `{prev}`
  - 2 requests en paralelo (overview y campaign); 1 request (daily con `time_increment=1`)

## Side effects

- ❌ Solo lectura.

## Caller

- **Dashboard GIOCORE** — todas las tarjetas Meta Ads (overview KPIs, ranking de campañas, sparklines diarias).
- `predictor` y `arbitraje` NO lo llaman — consultan Meta Graph directamente.

## Env vars

| Var | Uso |
|-----|-----|
| `META_TOKEN` | Auth Meta Graph (query param `access_token`) |

## Notas operativas

- **Timeout**: 10 s default. Meta responde en 1-3 s usualmente.
- **No cache**: cada llamada va a Meta. Hot reload del dashboard puede tocar rate limit Meta (200 req/hora por user-token). Considerar cache en cliente.
- **Time ranges**: `curr` = últimos 7 días terminados ayer; `prev` = los 7 anteriores. Implementación duplicada con `predictor.js` y `arbitraje.js` — TODO: extraer a módulo común (sin slot disponible).
- **Default account**: si `account` no está en `ACCOUNTS` → usa `nuevo`. NO devuelve error 400 — fallback silencioso.
- **Campos del overview vs campaign**: distintos (`overviewFields` no incluye `campaign_id`/`campaign_name`).

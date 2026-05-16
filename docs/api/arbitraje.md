---
title: /api/arbitraje — Motor #4 Arbitraje de Canal
file_path: /docs/api/arbitraje.md
source: /api/arbitraje.js
last_updated: 2026-05-15
---

# `/api/arbitraje`

Motor #4. Calcula un score 0-100 por campaña Meta Ads combinando eficiencia (clicks/peso, 70%) y CTR (30%). Devuelve un ranking + recomendaciones de Claude sobre cómo redistribuir el presupuesto entre las 5 campañas activas.

## URL

```
GET  https://giolens-dashboard.vercel.app/api/arbitraje
POST https://giolens-dashboard.vercel.app/api/arbitraje
```

## Propósito

Sustituir parte del trabajo manual del media buyer: decir cada semana qué escalar / mantener / reducir / pausar, con justificación + impacto esperado. **Las recomendaciones son advisory** — el equipo decide si las aplica en Meta Ads (este endpoint no toca Meta).

## Métodos

### `GET` — Status

```json
{
  "status": "ok",
  "motor": "Motor #4 — Arbitraje de Canal",
  "descripcion": "Analiza ROI por campaña Meta Ads y recomienda redistribución de presupuesto. POST para ejecutar."
}
```

### `POST` — Ejecuta análisis

Sin body.

**Response 200:**
```json
{
  "ok": true,
  "timestamp": "2026-05-15T20:30:00.000Z",
  "resumen": "Mantén el gasto en Justin/Holbrook (prospección líder) y mueve 30% del presupuesto de GioVision a SPY+GioSports.",
  "recomendaciones": [
    { "prioridad": 1, "accion": "escalar",  "campana": "Justin · Holbrook · Prospección", "detalle": "Subir presupuesto 25% — CPC bajó 8% y CTR subió 12% semana sobre semana.", "impacto": "+30 leads/sem a CPR estable" },
    { "prioridad": 2, "accion": "reducir",  "campana": "GioVision · Prospección",         "detalle": "Score 22/100 — CPC subió 40% y clicks cayeron. Pausar adset C y bajar daily 40%.", "impacto": "Liberar $3,000/sem para reasignar" },
    { "prioridad": 3, "accion": "mantener", "campana": "GioSports + SPY · Prospección",   "detalle": "Score 58 — rendimiento estable, no tocar.", "impacto": "Sostener pipeline 755062/252999" }
  ],
  "campanas": [
    {
      "id": "120243518605340263",
      "name": "Justin · Holbrook · Prospección",
      "pipeline": "Justin · Holbrook",
      "tipo": "prospección",
      "score": 89,
      "decision": "escalar",
      "spend": 4250.30,
      "cpc": 2.10,
      "ctr": 2.45,
      "clicks": 2024,
      "cpcDelta": -8.3,
      "ctrDelta": 12.1
    },
    { "id": "120243519211130263", "name": "Justin · Holbrook · Retargeting", "pipeline": "Justin · Holbrook", "tipo": "retargeting", "score": 71, "decision": "escalar", "spend": 1100, "cpc": 3.40, "ctr": 1.90, "clicks": 323, "cpcDelta": 4.1, "ctrDelta": -2.0 },
    { "id": "120244599911580263", "name": "Dama · Luxury · Prospección", "pipeline": "Dama · Luxury", "tipo": "prospección", "score": 65, "decision": "mantener", "spend": 2900, "cpc": 5.20, "ctr": 1.40, "clicks": 558, "cpcDelta": 9.0, "ctrDelta": -3.5 },
    { "id": "120244682313890263", "name": "GioSports + SPY · Prospección", "pipeline": "GioSports + SPY", "tipo": "prospección", "score": 58, "decision": "mantener", "spend": 2100, "cpc": 4.90, "ctr": 1.55, "clicks": 428, "cpcDelta": 1.2, "ctrDelta": 0.4 },
    { "id": "120244603173850263", "name": "GioVision · Prospección", "pipeline": "GioVision", "tipo": "prospección", "score": 22, "decision": "reducir", "spend": 1800, "cpc": 7.10, "ctr": 0.85, "clicks": 253, "cpcDelta": 40.2, "ctrDelta": -18.3 }
  ],
  "total_spend": 12150.30
}
```

**Response 405** — método ≠ POST (excepto el GET status).
**Response 500** — `{ error }`.

## Lógica de scoring

Para cada campaña (ventanas: `curr` = últimos 7d hasta ayer, `prev` = los 7d previos):

```js
efficiency = spend > 0 ? clicks / spend : 0;
rawScore   = efficiency * 0.7 + (ctr / 3) * 0.3;   // CTR normalizado a ~3% max
score      = round((rawScore / maxRawDelTop) * 100);
decision   = score >= 70 ? 'escalar' : score >= 40 ? 'mantener' : 'reducir';
```

Deltas vs semana anterior:
```js
cpcDelta = ((cpc - pCpc) / pCpc) * 100;
ctrDelta = ((ctr - pCtr) / pCtr) * 100;
```

`CAMPAIGN_PIPELINE` mapea cada `campaign_id` Meta a su pipeline + tipo (prospección | retargeting). Campañas no listadas aparecen como `{ pipeline: 'Otro', tipo: '—' }`.

## Dependencies

- **Meta Graph** `https://graph.facebook.com/v19.0`
  - `GET act_299921604429631/insights?fields=campaign_id,campaign_name,spend,cpc,cpm,impressions,clicks,ctr,actions&level=campaign&time_range=...`
  - 2 requests en paralelo (curr + prev).
- **Anthropic** — Claude Haiku 4.5, `max_tokens: 1000`, JSON puro.

## Side effects

- ❌ No envía recomendaciones a Meta. No pausa anuncios. No mueve presupuesto.
- ❌ No escribe a Wapify.

## Caller

- **Dashboard GIOCORE** — panel "Arbitraje de presupuesto" (botón Ejecutar).
- Posible cron semanal lunes 8am (no implementado).

## Env vars

| Var | Uso |
|-----|-----|
| `META_TOKEN` | Auth Meta Graph |
| `ANTHROPIC_API_KEY` | Análisis Claude |

## Notas operativas

- **Timeout**: 60 s (`vercel.json`).
- **Resilencia del JSON**: si Claude devuelve markdown alrededor, se extrae `raw.slice(start, end+1)` entre el primer `{` y último `}`. Si falla parse → `{ recomendaciones: [], resumen: 'Error al procesar respuesta de Claude.' }`.
- **Cuenta hardcoded**: solo analiza `act_299921604429631` (portafolio nuevo). El portafolio anterior `act_2241343302609141` NO se analiza aquí.
- **`maxRaw = Math.max(..., 0.001)`** evita división por cero si todas las campañas tienen 0 clicks.
- **Logs**: `[arbitraje] Claude raw: ...` queda en logs Vercel (primeros 300 chars de la respuesta del modelo) — útil para depurar respuestas malformadas.

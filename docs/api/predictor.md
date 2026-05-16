---
title: /api/predictor — Motor #2 Predictor de Quiebres
file_path: /docs/api/predictor.md
source: /api/predictor.js
last_updated: 2026-05-15
---

# `/api/predictor`

Motor #2. Detecta dos clases de "quiebre" en el funnel y los explica con Claude:
1. **Alza de CPC** (>15% semana sobre semana) en Meta Ads.
2. **Leads estancados** (>48h sin actualización) en cualquiera de los 5 pipelines.

## URL

```
GET  https://giolens-dashboard.vercel.app/api/predictor
POST https://giolens-dashboard.vercel.app/api/predictor
```

## Propósito

Sistema de "alertas tempranas" del ecosistema GioLens. Se ejecuta on-demand desde el dashboard (botón Diagnóstico) o por cron del equipo. Devuelve `nivel_riesgo`, `diagnostico` (2-3 líneas) y 3 `acciones` priorizadas.

## Métodos

### `GET` — Status

```json
{
  "status": "ok",
  "motor": "Motor #2 — Predictor de Quiebres",
  "descripcion": "Detecta alzas de CPC y leads estancados >48h. POST para ejecutar análisis."
}
```

### `POST` — Ejecuta análisis

No requiere body — el motor consulta los 5 pipelines + Meta Ads y genera el análisis.

**Response 200:**
```json
{
  "ok": true,
  "timestamp": "2026-05-15T20:30:00.000Z",
  "nivel_riesgo": "alto",
  "diagnostico": "CPC subió 22% vs semana anterior y Dama Luxury acumula 38 leads estancados — el costo se está duplicando para leads que ya no atendemos.",
  "acciones": [
    { "prioridad": 1, "accion": "Recuperar 38 leads de Dama Luxury con script de reactivación (Copiloto).", "pipeline": "Dama · Luxury" },
    { "prioridad": 2, "accion": "Pausar adset con mayor alza de CPC en Justin/Holbrook hasta resolver creatividades.", "pipeline": "Justin · Holbrook" },
    { "prioridad": 3, "accion": "Revisar segmentación de SPY Z87 — 28 leads estancados en NECESIDAD DETECTADA.", "pipeline": "SPY Z87" }
  ],
  "datos": {
    "cpc": { "curr": 5.40, "prev": 4.43, "changePct": 21.9, "alert": true },
    "pipelines": [
      { "id": "216977", "name": "Justin · Holbrook", "stagnant_total": 22, "stagnant_by_stage": { "COTIZADO": { "count": 12, "maxHours": 96 }, "INT2 · CATÁLOGO": { "count": 10, "maxHours": 72 } } },
      { "id": "755062", "name": "GioSports", "stagnant_total": 17, "stagnant_by_stage": { } },
      { "id": "252999", "name": "SPY Z87", "stagnant_total": 28, "stagnant_by_stage": { } },
      { "id": "94103",  "name": "Dama · Luxury", "stagnant_total": 38, "stagnant_by_stage": { } },
      { "id": "273944", "name": "GioVision", "stagnant_total": 11, "stagnant_by_stage": { } }
    ],
    "total_stagnant": 116
  }
}
```

**Response 405** — método ≠ GET/POST.
**Response 500** — `{ error: "<mensaje>" }`.

## Lógica de detección

### 1. Alza de CPC

```js
currCPC = parseFloat(curr.data?.[0]?.cpc || 0);
prevCPC = parseFloat(prev.data?.[0]?.cpc || 0);
changePct = ((currCPC - prevCPC) / prevCPC) * 100;
alert = changePct > 15;
```

Ventanas: `curr` = últimos 7 días terminados ayer; `prev` = los 7 días previos.

### 2. Estancamiento >48h

Pagina opportunities del pipeline (hasta 30 páginas × 100 items). Para cada opp:
- Skip si etapa ∈ `TERMINAL_STAGES` (VISITA CONFIRMADA, VENTA CONFIRMADA, CLIENTE GANADO, FUERA DE CATÁLOGO, FUERA DEL FLUJO, LEAD PERDIDO, CATCH-ALL).
- Calcula `silenceMs = now - updated_at`.
- Si `silenceMs > 48h` → cuenta como estancado en su `stage`.

**Optimización**: si el último lead del batch fue actualizado hace <48h, los siguientes (más recientes) tampoco lo estarán → corta paginación.

`parseWapifyDate(str)`: convierte `"2026-05-10 16:40:21"` → ms asumiendo CST (UTC-6).

## Dependencies

- **Wapify** `https://ap.whapify.ai/api`
  - `GET pipelines/{pid}/opportunities?limit=100&offset=N` (paginado)
- **Meta Graph** `https://graph.facebook.com/v19.0`
  - `GET {META_ACCOUNT}/insights?fields=cpc,spend,clicks&time_range=...`
  - Cuenta: `act_299921604429631` (portafolio nuevo)
- **Anthropic** `https://api.anthropic.com/v1/messages`
  - Modelo: `claude-haiku-4-5`
  - `max_tokens: 500`
  - `system: 'Responde SIEMPRE con JSON puro y válido...'`

## Side effects

- ❌ Solo lectura. No envía mensajes, no mueve etapas, no escribe en ningún lado.

## Caller

- **Dashboard GIOCORE** — botón "Diagnóstico de quiebres" en panel de monitoreo.
- Posible cron diario (no implementado aún).

## Env vars

| Var | Uso |
|-----|-----|
| `WAPIFY_TOKEN` | Listar opportunities |
| `META_TOKEN` | CPC de Meta |
| `ANTHROPIC_API_KEY` | Análisis Claude |

## Notas operativas

- **Timeout**: 60 s (configurado en `vercel.json`). Necesario porque pagina 5 pipelines × hasta 30 páginas + 2 calls a Meta + 1 a Anthropic.
- **Concurrency**: `Promise.all([getMetaCPC(), ...PIPELINES.map(getStagnantLeads)])` ejecuta los 6 fetches en paralelo.
- **Fallback Claude**: si Claude devuelve JSON malformado → `{ nivel_riesgo: 'medio', diagnostico: 'Error al procesar respuesta.', acciones: [] }`.
- **Datos sensibles al timezone**: `parseWapifyDate` asume CST UTC-6. Si Wapify cambiase a UTC pure, el cálculo de 48h se vería desplazado 6h.
- **Costo**: 5 pipelines × ~3000 opportunities promedio = hasta 15k items revisados. Sin BD esto se hace en cada llamada → no llamar en bucle desde el dashboard.

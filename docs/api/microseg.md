---
title: /api/microseg — Motor #3 Micro-Segmentación
file_path: /docs/api/microseg.md
source: /api/microseg.js
last_updated: 2026-05-15
---

# `/api/microseg`

Motor #3. Clasifica leads de los 5 pipelines en 4 segmentos (🔥 caliente / ⚡ activo / 🌡️ tibio / ❄️ frío) según 3 ejes (recencia, posición en funnel, actividad) y pide a Claude la táctica + frecuencia + urgencia recomendada por segmento.

## URL

```
GET  https://giolens-dashboard.vercel.app/api/microseg
POST https://giolens-dashboard.vercel.app/api/microseg
```

## Propósito

Responde "¿qué le hago a cada grupo de leads hoy?". Distinto al Motor #2 (Predictor), que es alertas; este es **planificación de acción** por segmento.

## Métodos

### `GET` — Status

```json
{
  "status": "ok",
  "motor": "Motor #3 — Micro-Segmentación",
  "descripcion": "Clasifica leads en 4 segmentos (caliente/activo/tibio/frío) y genera tácticas por perfil. POST para ejecutar."
}
```

### `POST` — Ejecuta segmentación

Sin body.

**Response 200:**
```json
{
  "ok": true,
  "timestamp": "2026-05-15T20:30:00.000Z",
  "insight": "Hora pico de leads hoy: noche. Dama Luxury concentra el 41% del segmento tibio — re-activar prioritario.",
  "tacticas": {
    "caliente": { "tactica": "Enviar mensaje de cierre con fecha + propuesta concreta", "frecuencia": "cada 4 horas", "urgencia": "alta" },
    "activo":   { "tactica": "Pregunta cerrada para avanzar a INT2",                    "frecuencia": "1 vez al día",      "urgencia": "media" },
    "tibio":    { "tactica": "Reactivación con nueva promo o información de catálogo",  "frecuencia": "cada 2 días",       "urgencia": "media" },
    "frio":     { "tactica": "Mensaje corto: ¿sigues buscando tus lentes? + link",       "frecuencia": "2 veces por semana", "urgencia": "baja" }
  },
  "pipelines": [
    {
      "id": "216977",
      "name": "Justin · Holbrook",
      "cpr": "$8.64",
      "total": 312,
      "horaPico": "tarde",
      "segments": {
        "caliente": { "count": 18, "etapa_top": "METODO PAGO" },
        "activo":   { "count": 44, "etapa_top": "COTIZADO" },
        "tibio":    { "count": 25, "etapa_top": "INT2 · CATÁLOGO" },
        "frio":     { "count": 225,"etapa_top": "NUEVO" }
      }
    },
    { "id": "755062", "name": "GioSports", "cpr": "$10.29", "total": 198, "horaPico": "noche", "segments": { } },
    { "id": "252999", "name": "SPY Z87", "cpr": "$9.10",  "total": 144, "horaPico": "mañana", "segments": { } },
    { "id": "94103",  "name": "Dama · Luxury", "cpr": "$12.50", "total": 267, "horaPico": "noche", "segments": { } },
    { "id": "273944", "name": "GioVision",  "cpr": "$11.20", "total": 182, "horaPico": "tarde", "segments": { } }
  ],
  "totales": { "caliente": 62, "activo": 178, "tibio": 89, "frio": 774 }
}
```

> Los CPR en el output reflejan los hardcoded del array `PIPELINES` interno del motor, NO los CPR finales del README. Diferencia conocida pendiente de unificar.

**Response 405** — método ≠ GET/POST.
**Response 500** — `{ error }`.

## Lógica de clasificación

Para cada opportunity:

```js
recencia  = ageMs < 7d  ? 'reciente' : ageMs < 14d ? 'semana_pasada' : 'antiguo'
posicion  = STAGE_POSITION[stage] || 'inicio'       // inicio | mitad | cierre
actividad = silenceMs < 48h ? 'activo' : 'estancado'
turno     = hora_creacion ∈ [6-12=mañana, 12-18=tarde, ≥18=noche, resto=madrugada]
```

Asignación a segmento (orden):
1. `caliente` ← actividad=activo **+** posicion=cierre
2. `activo` ← actividad=activo **+** recencia=reciente
3. `tibio` ← actividad=estancado **+** posicion=mitad
4. `frio` ← resto

**`STAGE_POSITION`** (extracto):
- `inicio`: NUEVO, BOT ACTIVO, COTIZADO, CTA VISITA, PRECIO ENTREGADO, RUTA MÉDICA, RUTA COMERCIAL
- `mitad`: INT2 · CATÁLOGO, INT2 · RE-ENTRADA
- `cierre`: INT3 · PROMO ACTIVA, NT3 · COMPARATIVA, UBICACIÓN ENVIADA, METODO PAGO, MÉTODO DE PAGO, VISITA CONFIRMADA, VENTA CONFIRMADA, CLIENTE GANADO, FUERA DE CATÁLOGO, FUERA DEL FLUJO, CATCH-ALL, LEAD PERDIDO

`parseWapDate` interpreta strings `"YYYY-MM-DD HH:mm:ss"` como CST (UTC-6).

## Fallbacks Claude

Si Claude devuelve campos vacíos o `urgencia` fuera del enum, se inyectan defaults:

```js
{
  caliente: { tactica: 'Enviar mensaje de cierre urgente con propuesta concreta.', frecuencia: 'cada 4 horas',       urgencia: 'alta'  },
  activo:   { tactica: 'Preguntar disponibilidad para visita o compra online.',    frecuencia: '1 vez al día',        urgencia: 'media' },
  tibio:    { tactica: 'Reactivar con nueva promo o información de producto.',     frecuencia: 'cada 2 días',         urgencia: 'media' },
  frio:     { tactica: 'Mensaje corto: ¿sigues buscando tus lentes?',              frecuencia: '2 veces por semana',  urgencia: 'baja'  },
}
```

## Dependencies

- **Wapify** `https://ap.whapify.ai/api`
  - `GET pipelines/{pid}/opportunities?limit=100&offset=N` (hasta 25 páginas = 2500 leads por pipeline)
- **Anthropic** — Claude Haiku 4.5, `max_tokens: 500`, JSON puro

## Side effects

- ❌ Solo lectura. No envía mensajes, no mueve etapas.

## Caller

- **Dashboard GIOCORE** — panel "Segmentación de la cartera".
- Posible: usado como input para `auto-prompt` / `copiloto` en futura automatización por segmento.

## Env vars

| Var | Uso |
|-----|-----|
| `WAPIFY_TOKEN` | Listar opportunities |
| `ANTHROPIC_API_KEY` | Análisis Claude |

## Notas operativas

- **Timeout**: 60 s (configurado en `vercel.json`).
- **Concurrency**: `Promise.all(PIPELINES.map(segmentPipeline))` → 5 pipelines en paralelo.
- **Cap de paginación**: 25 páginas × 100 = 2500 leads por pipeline. Para carteras más grandes hay que subir el cap o aceptar undercount.
- **`NOW = Date.now()` dentro de `segmentPipeline`**: evita que el módulo cache un valor stale en warm starts de Vercel.
- **`horaPico`**: se calcula en CST por `getUTCHours() - 6`. NO ajusta por DST (México B.C. usa Pacífico, sin DST en gran parte).
- **CPR hardcoded inconsistente**: los CPR en `PIPELINES` (microseg) NO se actualizan con el README/contexto. TODO: leer de fuente única.

---
title: /api/copiloto — Motor #5 Copiloto Sales
file_path: /docs/api/copiloto.md
source: /api/copiloto.js
last_updated: 2026-05-15
---

# `/api/copiloto`

Motor #5. El **vendedor** llama este endpoint con `pipeline_id + stage_name + contact_id + conversacion` y recibe el script óptimo a copiar/pegar al lead. NO responde al cliente directamente — es asistente del vendedor.

Es también la fuente del script que usa `/api/reactivation-check` cuando dispara la reactivación automática.

## URL

```
GET     https://giolens-dashboard.vercel.app/api/copiloto
POST    https://giolens-dashboard.vercel.app/api/copiloto
OPTIONS (CORS preflight)
```

## Propósito

Resolver "¿qué le digo a ESTE lead AHORA mismo dado su estado actual?". A diferencia de `/api/auto-prompt` (3 variantes A/B), aquí se devuelve **un único script** + alternativa para lead frío + nivel de urgencia + siguiente etapa sugerida.

## Métodos

### `GET` — Status

```json
{
  "status": "ok",
  "motor": "Motor #5 — Copiloto Sales",
  "descripcion": "Recibe pipeline_id + stage_name + contact_id y devuelve el script óptimo para el vendedor",
  "pipelines_disponibles": [
    { "id": "216977", "nombre": "Justin · Holbrook · Litebeam" },
    { "id": "755062", "nombre": "GioSports · Deportivo" },
    { "id": "252999", "nombre": "SPY · Seguridad Z87" },
    { "id": "94103",  "nombre": "Dama · Luxury" },
    { "id": "273944", "nombre": "GioVision · Entintados" }
  ]
}
```

### `POST` — Genera script

**Request body:**
```json
{
  "pipeline_id":  "94103",
  "stage_name":   "INT2 · CATÁLOGO",
  "contact_id":   "61240329",
  "conversacion": "Lead: Hola, vi sus armazones Michael Kors\nVendedora: Hola María, sí tenemos varios. ¿Te muestro el catálogo?\nLead: Sí porfa\n[Vendedora envió 5 fotos, sin respuesta hace 3 horas]",
  "context_str":  "Lead mencionó que es cumpleaños y se quiere regalar algo.",
  "interaccion":  2,
  "ruta":         "comercial"
}
```

| Campo | Tipo | Requerido | Notas |
|-------|------|-----------|-------|
| `pipeline_id` | string | ✅ | |
| `stage_name` | string | — (recomendado) | Default `NUEVO` |
| `contact_id` | string | — | Se devuelve en el response (passthrough) |
| `conversacion` | string | — | Historial libre — Wapify no expone REST de conversaciones, por eso el caller debe armarlo |
| `context_str` | string | — | Panel "Contexto IA" del dashboard |
| `interaccion` | number | — | 1, 2 o 3 |
| `ruta` | string | — | `comercial` o `medica` |

**Response 200:**
```json
{
  "ok": true,
  "pipeline": "Dama · Luxury",
  "etapa": "INT2 · CATÁLOGO",
  "contact_id": "61240329",
  "tuvo_historial": true,
  "script": "María, te llamó la atención el Michael Kors plateado o el dorado? Si me dices cuál te encantó te aparto y te confirmo precio final con tu graduación 🎀",
  "razon": "Lead vio catálogo pero no eligió; pregunta cerrada + ancla de 'apartar' empuja al cierre presencial.",
  "alternativa": "María, sigues por aquí? Te dejo un favor: cualquier duda del armazón o de tu graduación te respondo en chat antes de tu visita 😊",
  "urgencia": "alta",
  "siguiente_etapa": "CTA VISITA"
}
```

**Response 400:**
- `pipeline_id no reconocido` (incluye `disponibles: [...]`)
- `JSON inválido`

**Response 405** — método no permitido.

**Response 500:**
- `Claude error <status>`
- `{ error: '<mensaje>' }`

## Pipelines configurados

Mismo set de 5 que `auto-prompt`, pero con metadata extendida (`cpr`, `diferenciadores`, lista exacta de `etapas` por pipeline). Permite que el prompt sepa qué etapas son válidas para `siguiente_etapa`.

## Dependencies

- **Anthropic** `https://api.anthropic.com/v1/messages`
  - Modelo: `claude-haiku-4-5`
  - `max_tokens: 500`
  - `system` con `cache_control: ephemeral`
- ❌ No llama Wapify directamente. **Wapify no expone endpoint REST de conversaciones**, por eso `conversacion` viene del caller.

## Side effects

- ❌ No envía mensajes.
- ❌ No mueve etapas.
- Stateless.

## Caller

- **Dashboard GIOCORE** — panel "Copiloto" (botón "Dame el script").
- **`/api/reactivation-check`** — llama internamente para obtener el script de reactivación cuando un lead lleva 4-12 min sin responder al bot.

## Env vars

| Var | Uso |
|-----|-----|
| `ANTHROPIC_API_KEY` | Auth Anthropic |

## Notas operativas

- **Timeout**: 10 s default.
- **Cache prompt**: el `system` (1-2k tokens por pipeline) usa `cache_control: ephemeral` → tras primera llamada por pipeline, las siguientes en la ventana de 5 min son baratas.
- **Fallback de parse**: si el JSON de Claude no parsea, se devuelve `{ script: raw, razon: '', alternativa: '', urgencia: 'media', siguiente_etapa: '' }` — el dashboard siempre recibe un script utilizable, aunque sin estructura.
- **`tuvo_historial`**: flag booleano útil para que el dashboard sepa si el script se generó con o sin contexto conversacional.
- **`siguiente_etapa`**: el modelo elige entre las etapas listadas en `pipe.etapas`. NO se mueve automáticamente — es solo sugerencia para el vendedor.

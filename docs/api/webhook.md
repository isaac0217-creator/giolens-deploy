---
title: /api/webhook — Webhook Wapify + 5 Motores Claude
file_path: /docs/api/webhook.md
source: /api/webhook.js
last_updated: 2026-05-15
---

# `/api/webhook`

Webhook receptor de eventos Wapify. Despacha al motor Claude correspondiente según `pipeline_id` y permite al modelo enviar mensajes, mover etapas o escalar a humano vía 5 tools.

## URL

```
GET  https://giolens-dashboard.vercel.app/api/webhook
POST https://giolens-dashboard.vercel.app/api/webhook
OPTIONS (preflight CORS)
```

Registrar en Wapify bajo `claudeNOVA` (ID `278215`).

## Propósito

Punto de entrada único para todos los eventos de los 5 pipelines de WhatsApp marketing. Cada pipeline tiene un motor dedicado (`motorJustinHolbrook`, `motorGioSports`, `motorSpyZ87`, `motorDamaLuxury`, `motorGioVision`) con su propio system prompt, mapa de etapas y reglas de conversación.

El handler:
1. Loguea el payload crudo (campo a campo para evitar truncación).
2. Extrae IDs (contact, conversation, pipeline, stage, card, last_message).
3. Resuelve el motor en `MOTOR_MAP` por `pipeline_id`.
4. Si no hay motor → responde `200 { received: true, action: 'ignored' }`.
5. Si hay motor → invoca Claude Haiku 4.5 con el prompt del pipeline + tools, ejecuta la decisión, responde 200 con `result`.

## Métodos

### `GET` — Status

Devuelve catálogo de motores activos.

**Response 200:**
```json
{
  "status": "ok",
  "service": "GioLens 5 Motores — Claude Engine",
  "motors": {
    "216977": "Justin/Holbrook ✅",
    "755062": "GioSports ✅",
    "252999": "SPY Z87 ✅",
    "94103":  "Dama ✅",
    "273944": "GioVision ✅"
  },
  "timestamp": "2026-05-15T20:00:00.000Z"
}
```

### `POST` — Recibe evento Wapify

**Request body** (variantes aceptadas; `extractIds()` cubre múltiples schemas):
```json
{
  "event": "message.received",
  "user":  { "id": "61240329", "first_name": "Carlos" },
  "data":  {
    "id": "ABC123",
    "contact":     { "first_name": "Carlos" },
    "contact_id":  "61240329",
    "pipeline":    { "id": "216977" },
    "stage":       { "id": 5, "name": "INT2 · CATÁLOGO" },
    "message":     "Sí me interesa el Holbrook"
  }
}
```

**Response 200 — motor ejecutado:**
```json
{
  "received": true,
  "ts": 1747339200000,
  "result": {
    "action": "send_message",
    "input":  { "text": "Va Carlos, te espero..." },
    "sent":   true
  }
}
```

**Response 200 — pipeline sin motor:**
```json
{ "received": true, "action": "ignored", "pipeline": "999999" }
```

**Response 200 — error en motor (no propaga 5xx para no reintentar):**
```json
{ "received": true, "error": "fetch failed" }
```

**Response 400** — JSON inválido en body.
**Response 405** — Método distinto a GET/POST/OPTIONS.
**Response 500** — `ANTHROPIC_API_KEY` no configurada.

## Pipelines y motores

| `pipeline_id` | Motor | Pipeline | CPR |
|---------------|-------|----------|-----|
| `216977` | `motorJustinHolbrook` | Justin · Holbrook · Litebeam | $8.64 |
| `755062` | `motorGioSports` | GioSports · Deportivo | $10.29 |
| `252999` | `motorSpyZ87` | SPY Z87 · Seguridad Industrial | $15.20 |
| `94103`  | `motorDamaLuxury` | Dama · Luxury | $23.53 |
| `273944` | `motorGioVision` | GioVision · Entintados | $27.78 |

Cada motor tiene su propio `STAGES_<pid>` (map `stage_name → stage_id`) y system prompt con scripts por etapa, precios reales y reglas de conversación.

## Tools de Claude

El modelo recibe `tool_choice: { type: 'auto' }` con 5 tools:

```js
[
  {
    name: 'send_message',
    description: 'Envía un mensaje de WhatsApp al lead.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  },
  {
    name: 'move_stage',
    description: 'Mueve al lead a otra etapa del CRM.',
    input_schema: { type: 'object', properties: { stage_name: { type: 'string' } }, required: ['stage_name'] }
  },
  {
    name: 'send_and_move',
    description: 'Envía mensaje + mueve etapa en un solo paso.',
    input_schema: { type: 'object', properties: { text: { type: 'string' }, stage_name: { type: 'string' } }, required: ['text','stage_name'] }
  },
  {
    name: 'escalate_human',
    description: 'Marca al lead para atención humana.',
    input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] }
  },
  {
    name: 'no_action',
    description: 'No hacer nada.',
    input_schema: { type: 'object', properties: {} }
  }
]
```

`executeDecision()` ejecuta el tool elegido. `move_stage` requiere que `stage_name` exista en el `STAGES_<pid>` del motor, si no se descarta con `console.warn`.

## Dependencies

- **Wapify** `https://ap.whapify.ai/api`
  - `POST contacts/{id}/send` — envía mensaje
  - `DELETE pipelines/{pid}/opportunities/{cardId}` — quita de etapa anterior
  - `POST   pipelines/{pid}/opportunities` — crea en etapa destino
- **Anthropic** `https://api.anthropic.com/v1/messages`
  - Modelo: `claude-haiku-4-5`
  - `max_tokens: 512`, `system` con `cache_control: ephemeral`

## Side effects

- ✅ **Envía mensajes de WhatsApp** al lead.
- ✅ **Mueve cards entre etapas** de Wapify (delete + create).
- ✅ Logs verbosos en stdout (Vercel logs).
- ❌ NO escribe a base de datos (no hay BD).
- ❌ NO escala a humano automáticamente (solo log `[ESCALATE]`).
- ❌ NO publica en ntfy.sh (canal desactivado por seguridad — comentario en el código).

## Caller

- **Wapify** (push del webhook por evento `message.received`, `opportunity.created`, `opportunity.stage_changed`).
- Pruebas manuales con `curl` o Postman.
- NUNCA llamado por el dashboard ni por otros endpoints.

## Env vars

| Var | Uso |
|-----|-----|
| `WAPIFY_TOKEN` | Auth Wapify (header `X-ACCESS-TOKEN`) |
| `ANTHROPIC_API_KEY` | Auth Anthropic (header `x-api-key`) |

Si falta `ANTHROPIC_API_KEY` → responde 500. Si falta `WAPIFY_TOKEN` → `wapFetch` retorna `null` (catch silencioso, log warning).

## Notas operativas

- **Timeout**: 10 s (default Vercel Hobby — NO está extendido en `vercel.json`). Si Claude tarda >8 s el handler puede cortarse antes de ejecutar la tool. Considerar mover a 60 s si se ve `FUNCTION_INVOCATION_TIMEOUT` en logs.
- **Sin historial real**: Wapify no expone endpoint REST de conversaciones. El motor solo ve `last_message` del payload (1 mensaje) + un fallback contextual sintético si el evento no trajo mensaje. **Esto limita la calidad del bot** — fase 3 deberá resolverlo.
- **Idempotencia**: Wapify reintenta webhooks fallidos. Por eso el handler responde 200 incluso ante errores del motor (`try/catch` envuelve `motor(payload)` y devuelve `{ received: true, error }` en vez de 5xx).
- **Rate limit Anthropic**: con 5 pipelines y picos de tráfico se puede tocar el rate limit. Cache_control ephemeral reduce costo pero no rate.
- **Cache de prompt**: `system: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }]` aprovecha caching de Anthropic — el prompt grande (1-3k tokens por motor) se factura solo la primera vez en cada ventana de 5 min.
- **Normalización de mensajes**: si hay 2 mensajes consecutivos del mismo rol (lead manda 2 chats seguidos), se concatenan con `\n` antes de mandar a Claude.
- **Validación de tools**: si `move_stage` recibe un `stage_name` que no está en el map del pipeline, NO mueve y registra `[move_stage] unknown stage_name="..."`. Es responsabilidad del prompt incluir solo etapas válidas (los prompts las listan EXACTO al final).

---
title: /api/auto-prompt — Motor #1 Auto-Prompt
file_path: /docs/api/auto-prompt.md
source: /api/auto-prompt.js
last_updated: 2026-05-15
status: deprecated
---

> ⚠️ **DEPRECATED — fusionado en `/api/text-utils?op=prompt`** (Sprint 1, 16 may 2026).
> El handler vive ahora en [`text-utils.js`](../../api/text-utils.js) tras el router `?op=prompt`.
> Esta documentación se preserva **solo por historial git**. Para uso operativo ver [text-utils.md](./text-utils.md).
> Migración del caller: cambiar `POST /api/auto-prompt` por `POST /api/text-utils?op=prompt` (body idéntico).

# `/api/auto-prompt`

Motor #1 de la familia GIOCORE. Dado un `pipeline_id + stage_name + ruta + interacción`, devuelve 3 variantes de mensaje WhatsApp con ángulos distintos (urgencia / valor / prueba social), listas para que el vendedor copie/pegue.

## URL

```
GET     https://giolens-dashboard.vercel.app/api/auto-prompt
POST    https://giolens-dashboard.vercel.app/api/auto-prompt
OPTIONS (CORS preflight)
```

## Propósito

Resolver el "qué le digo a este lead ahora" en 3 ángulos contrapuestos para que el vendedor (o el dashboard) elija el que cuadra con el contexto. Con el tiempo, los click-throughs implícitos permiten detectar el ángulo ganador por etapa. Es el equivalente a "Hemingway editor" del copy de venta.

## Métodos

### `GET` — Health check + catálogo

**Response 200:**
```json
{
  "status": "ok",
  "motor": "Motor #1 — Auto-Prompt",
  "descripcion": "Genera 3 variantes de mensaje (urgencia / valor / social proof) para cualquier pipeline + etapa",
  "angulos": [
    { "id": "urgencia",     "label": "Urgencia / Escasez" },
    { "id": "valor",        "label": "Valor / Beneficio" },
    { "id": "social_proof", "label": "Prueba Social" }
  ],
  "pipelines": [
    { "id": "216977", "nombre": "Justin · Holbrook · Litebeam" },
    { "id": "755062", "nombre": "GioSports · Deportivo" },
    { "id": "252999", "nombre": "SPY · Seguridad Z87" },
    { "id": "94103",  "nombre": "Dama · Luxury" },
    { "id": "273944", "nombre": "GioVision · Entintados" }
  ]
}
```

### `POST` — Genera 3 variantes

**Request body:**
```json
{
  "pipeline_id":  "216977",
  "stage_name":   "INT2 · CATÁLOGO",
  "contexto":     "El lead pidió ver más modelos pero no confirmó visita",
  "context_str":  "Lead mencionó que trabaja en construcción.",
  "interaccion":  2,
  "ruta":         "comercial"
}
```

| Campo | Tipo | Requerido | Notas |
|-------|------|-----------|-------|
| `pipeline_id` | string | ✅ | Debe estar en `PIPELINES` |
| `stage_name` | string | ✅ | Nombre exacto (ver glosario) |
| `contexto` | string | — | Texto libre del vendedor |
| `context_str` | string | — | Bloque del panel "Contexto IA" del dashboard (localStorage) |
| `interaccion` | number | — | 1, 2 o 3 |
| `ruta` | string | — | `comercial` o `medica` |

**Response 200:**
```json
{
  "ok": true,
  "pipeline": "Justin · Holbrook · Litebeam",
  "pipeline_id": "216977",
  "etapa": "INT2 · CATÁLOGO",
  "generado_at": "2026-05-15T20:30:00.000Z",
  "variantes": [
    {
      "id": "216977_INT2 · CATÁLOGO_urgencia_1747339200000",
      "angulo": "urgencia",
      "angulo_label": "Urgencia / Escasez",
      "mensaje": "Carlos, el Holbrook clásico que viste solo nos quedan 3 unidades en tu graduación 👀 ¿Te aparto uno para esta semana?",
      "cuando_usar": "Cuando el lead vio catálogo pero no avanza",
      "tono": "urgente"
    },
    {
      "id": "216977_INT2 · CATÁLOGO_valor_1747339200000",
      "angulo": "valor",
      "angulo_label": "Valor / Beneficio",
      "mensaje": "Incluye examen de vista gratis + tratamiento antirreflejante 🎁 — ahorras casi $700 vs comprarlo por separado. ¿Pasas mañana en la tarde?",
      "cuando_usar": "Cuando objetó precio o no entendió el paquete",
      "tono": "confianza"
    },
    {
      "id": "216977_INT2 · CATÁLOGO_social_proof_1747339200000",
      "angulo": "social_proof",
      "angulo_label": "Prueba Social",
      "mensaje": "Justo ayer un cliente de construcción se llevó el mismo Holbrook — feliz con la garantía 🤝. ¿Te apartamos uno?",
      "cuando_usar": "Cuando el lead duda de la marca o la tienda",
      "tono": "amigable"
    }
  ],
  "recomendacion": "Empieza con VALOR — INT2 suele necesitar reafirmar lo que incluye antes de avanzar a cierre."
}
```

**Response 400:**
- `pipeline_id no reconocido` (incluye `disponibles: [...]`)
- `stage_name requerido`
- `JSON inválido`

**Response 405** — método no permitido.

**Response 500:**
- `ANTHROPIC_API_KEY no configurada en variables de entorno`
- `Claude error <status>`
- `Respuesta inesperada de Claude` (cuando el JSON no parsea — incluye `raw.slice(0,300)`)

## Dependencies

- **Anthropic** `https://api.anthropic.com/v1/messages`
  - Modelo: `claude-haiku-4-5`
  - `max_tokens: 800`
  - `system` con `cache_control: ephemeral` (el prompt es estable por pipeline+etapa).

## Side effects

- ❌ No envía mensajes — solo genera variantes.
- ❌ No mueve etapas.
- ❌ No persiste nada.
- Es **stateless** y seguro de llamar cuantas veces se quiera.

## Caller

- **Dashboard GIOCORE** (panel "Generar mensaje").
- Vendedores manuales vía herramientas como Postman.
- Posible integración futura: cron que pre-genera variantes para todos los leads en INT2/INT3.

## Env vars

| Var | Uso |
|-----|-----|
| `ANTHROPIC_API_KEY` | Auth Anthropic |

## Notas operativas

- **Timeout**: 10 s default. Claude Haiku responde en 2-4 s; margen suficiente.
- **Caching**: el `system` se marca ephemeral → el prompt por pipeline (~1.5k tokens) se factura solo la primera llamada en la ventana de 5 min. Llamadas siguientes para el mismo pipeline pagan solo los tokens variables.
- **Validación JSON**: la respuesta de Claude se parsea con regex `match(/\{[\s\S]*\}/)`. Si el modelo agrega markdown alrededor se ignora.
- **ID determinista**: cada variante recibe un `id` `{pipeline}_{stage}_{angulo}_{ts}` útil para tracking de elección del usuario.
- **`PIPELINES` no incluye `claudeNOVA`** — este endpoint es solo para los 5 pipelines productivos.

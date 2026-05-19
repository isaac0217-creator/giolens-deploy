---
title: /api/text-utils — Router de utilities de texto (fusión Sprint 1)
file_path: /docs/api/text-utils.md
source: /api/text-utils.js
last_updated: 2026-05-18
---

# `/api/text-utils`

Router de utilities de texto. **Fusión Sprint 1 (16 may 2026)** de los antiguos `/api/clean-message` + `/api/auto-prompt` en un solo slot Vercel para liberar capacidad y dar espacio a `/api/state` (Supabase-backed kv + timeseries).

Comportamiento idéntico a los 2 endpoints originales — la migración consistió únicamente en mover ambos handlers tras un router `?op=`. Los callers (Wapify HTTP Actions, dashboard frontend) deben llamar a la nueva URL con `?op=clean` o `?op=prompt`.

## URL

```
GET     https://giolens-dashboard.vercel.app/api/text-utils            (status + catálogo)
GET     https://giolens-dashboard.vercel.app/api/text-utils?op=clean   (clean vía query)
POST    https://giolens-dashboard.vercel.app/api/text-utils?op=clean   (clean vía body)
POST    https://giolens-dashboard.vercel.app/api/text-utils?op=prompt  (genera 3 variantes)
OPTIONS (CORS preflight)
```

El router despacha por `?op=`. Sin `?op=` y método `GET`, devuelve status + catálogo (operaciones disponibles, ángulos, pipelines). Sin `?op=` y método distinto, devuelve `400`.

## Operaciones

### `?op=clean` — Strip `##ESTADO##` tags

Strip de **todos** los tags `##ESTADO:...##` del texto. Reemplaza al endpoint legacy `/api/clean-message`.

**Métodos:** `GET` (con `?text=...`) y `POST` (con `{ "text": "..." }`).

**Request body (POST):**
```json
{ "text": "Hola, te paso el catálogo 👋\n##ESTADO:INT2_CATALOGO##" }
```

**Response 200:**
```json
{ "clean": "Hola, te paso el catálogo 👋" }
```

**Response 400:**
```json
{ "error": "Missing text param" }
```

#### Regex usado

```js
String(text)
  .replace(/\n?##ESTADO:[^#\n]+##[ \t]*/g, '')
  .trimEnd();
```

- `\n?` — opcionalmente come un newline previo
- `##ESTADO:` — literal
- `[^#\n]+` — contenido del tag (cualquier cosa menos `#` o newline)
- `##` — literal de cierre
- `[ \t]*` — come espacios/tabs después del tag
- `.trimEnd()` — quita trailing whitespace residual

Elimina **todos** los tags (no solo el del final). Cuando GPT genera 2 respuestas concatenadas, queda visible un tag intermedio que debe limpiarse también.

### `?op=prompt` — Genera 3 variantes WhatsApp

Genera 3 variantes de mensaje (urgencia / valor / social_proof) para un `pipeline_id + stage_name`. Reemplaza al endpoint legacy `/api/auto-prompt`.

**Método:** solo `POST` (otros métodos devuelven `405`).

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
| `context_str` | string | — | Bloque del panel "Contexto IA" del dashboard (localStorage o `/api/state?op=kv-get`) |
| `interaccion` | number | — | 1, 2 o 3 |
| `ruta` | string | — | `comercial` o `medica` |

**Response 200:**
```json
{
  "ok": true,
  "pipeline": "Justin · Holbrook · Litebeam",
  "pipeline_id": "216977",
  "etapa": "INT2 · CATÁLOGO",
  "generado_at": "2026-05-18T20:30:00.000Z",
  "variantes": [
    {
      "id": "216977_INT2 · CATÁLOGO_urgencia_1747339200000",
      "angulo": "urgencia",
      "angulo_label": "Urgencia / Escasez",
      "mensaje": "Carlos, el Holbrook clásico que viste solo nos quedan 3 unidades en tu graduación 👀 ¿Te aparto uno para esta semana?",
      "cuando_usar": "Cuando el lead vio catálogo pero no avanza",
      "tono": "urgente"
    },
    { "angulo": "valor", "...": "..." },
    { "angulo": "social_proof", "...": "..." }
  ],
  "recomendacion": "Empieza con VALOR — INT2 suele necesitar reafirmar lo que incluye antes de avanzar a cierre."
}
```

**Response 400:**
- `pipeline_id no reconocido` (incluye `disponibles: [...]`)
- `stage_name requerido`
- `JSON inválido`

**Response 405** — `op=prompt requiere POST`.

**Response 500:**
- `ANTHROPIC_API_KEY no configurada en variables de entorno`
- `Claude error <status>`
- `Respuesta inesperada de Claude` (cuando el JSON no parsea — incluye `raw.slice(0,300)`)

### `GET` sin `?op=` — Status + catálogo

**Response 200:**
```json
{
  "status": "ok",
  "endpoint": "/api/text-utils",
  "descripcion": "Fusión de /api/clean-message + /api/auto-prompt (Sprint 1 fusión)",
  "operations": [
    { "op": "clean",  "metodo": "POST/GET", "descripcion": "Strip TODOS los tags ##ESTADO:...##", "body": "{ text: '...' }" },
    { "op": "prompt", "metodo": "POST",     "descripcion": "Genera 3 variantes (urgencia/valor/social_proof)", "body": "{ pipeline_id, stage_name, contexto?, context_str?, interaccion?, ruta? }" }
  ],
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

## Dependencies

- **Anthropic** `https://api.anthropic.com/v1/messages` (solo `?op=prompt`)
  - Modelo: `claude-haiku-4-5`
  - `max_tokens: 800`
  - `system` con `cache_control: ephemeral` (el prompt es estable por pipeline+etapa).
- `?op=clean` — ❌ ninguna dependencia externa, pure function.

## Side effects

- ❌ No envía mensajes — solo genera variantes / limpia texto.
- ❌ No mueve etapas.
- ❌ No persiste nada.
- Es **stateless** y seguro de llamar cuantas veces se quiera.

## Caller

### `?op=clean`
- **Wapify Workflow** — HTTP Action `POST /api/text-utils?op=clean` configurada antes del nodo "Enviar mensaje #1". Guarda la respuesta en variable `mensaje_limpio`.

### `?op=prompt`
- **Dashboard GIOCORE** — panel "Generar mensaje".
- Vendedores manuales vía Postman.
- Posible integración futura: cron que pre-genera variantes para todos los leads en INT2/INT3.

## Env vars

| Var | Usada por | Notas |
|-----|-----------|-------|
| `ANTHROPIC_API_KEY` | solo `?op=prompt` | Auth Anthropic. `?op=clean` no requiere ninguna env var |

## Observabilidad

Envuelto en `withSentry(handler, { endpoint: 'text-utils' })`. Captura errores no manejados, crash y tags (`endpoint`, `method`, `op`). No-op cuando `SENTRY_DSN` no está configurada.

Estado wrapper: ✅ activo (Sentry DSN entregado y deployado 18 may 2026 noche).

## Notas operativas

- **Timeout**: 60 s configurado en `vercel.json`. `?op=clean` ejecuta <10 ms; `?op=prompt` con Claude Haiku responde en 2-4 s.
- **Caching ephemeral**: `?op=prompt` envía `system` con `cache_control: ephemeral`. El prompt por pipeline (~1.5k tokens) se factura solo la primera llamada en ventana de 5 min. Llamadas siguientes para el mismo pipeline pagan solo tokens variables.
- **Validación JSON**: la respuesta de Claude se parsea con regex `match(/\{[\s\S]*\}/)`. Si el modelo agrega markdown alrededor se ignora.
- **ID determinista**: cada variante recibe `id` con formato `{pipeline}_{stage}_{angulo}_{ts}` útil para tracking de elección.
- **`PIPELINES` no incluye `claudeNOVA`** — este endpoint es solo para los 5 pipelines productivos.
- **`?op=clean` endpoint público sin auth** — no maneja secretos.
- **Caso degenerado de `?op=clean`**: si el texto SOLO es el tag (`##ESTADO:X##`), devuelve `clean: ''` — el llamador (Wapify) debe verificar antes de enviar.
- **No valida que el tag sea conocido** — elimina cualquier `##ESTADO:loquesea##`. Esto es intencional: la lista de estados cambia con frecuencia y esta utility no debe acoplarse a ella.

## Migración desde endpoints legacy

| Caller | URL legacy | URL nueva |
|--------|-----------|-----------|
| Wapify HTTP Action "limpia mensaje" | `POST /api/clean-message` | `POST /api/text-utils?op=clean` |
| Dashboard "Generar mensaje" | `POST /api/auto-prompt` | `POST /api/text-utils?op=prompt` |
| Postman / scripts manuales | `GET /api/clean-message?text=...` | `GET /api/text-utils?op=clean&text=...` |

Los endpoints legacy fueron eliminados como parte del Sprint 1. Las docs `clean-message.md` y `auto-prompt.md` se conservan con deprecation banner solo por historial git.

## Por qué la fusión

- **Liberar 1 slot Vercel** (de 12/12 → 11/12 → 10/12 tras también fusionar `reactivation-check`) para dar espacio a `/api/state` (Supabase-backed).
- Ambos handlers son utilities de texto sin estado, ideales para coexistir tras un router `?op=`.
- Costo de migración bajo: solo cambiar la URL en Wapify y el dashboard.

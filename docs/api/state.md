---
title: /api/state — Supabase-backed kv + timeseries
file_path: /docs/api/state.md
source: /api/state.js
last_updated: 2026-05-18
---

# `/api/state`

Capa de persistencia Supabase-backed. Reemplaza a `localStorage` como mecanismo de estado compartido entre dashboard, agentes y endpoints. Resuelve la deuda crítica documentada en el Maestro v12 §07 ("localStorage como persistencia — fragilidad crítica") como parte del Sprint 1 (Fase 1, 16 may 2026).

Expone 2 abstracciones detrás de un router `?op=`:

1. **kv** — clave-valor JSONB con upsert (tabla `app_config`)
2. **ts** — append-only timeseries de eventos (tabla `audit_log`)

## URL

```
GET     https://giolens-dashboard.vercel.app/api/state                            (status + catálogo)
GET     https://giolens-dashboard.vercel.app/api/state?op=kv-get&key=...          (lee kv)
POST    https://giolens-dashboard.vercel.app/api/state?op=kv-set                  (upsert kv)
POST    https://giolens-dashboard.vercel.app/api/state?op=ts-append               (insert audit_log)
GET     https://giolens-dashboard.vercel.app/api/state?op=ts-read&actor_id=...    (lee audit_log)
OPTIONS (CORS preflight)
```

El router despacha por `?op=`. Sin `?op=` y método `GET`, devuelve status + catálogo. Sin `?op=` y método distinto, devuelve `400`.

## Operaciones

### `?op=kv-get` — Lee 1 row de `app_config`

**Método:** `GET`.

**Query params:**
| Param | Tipo | Requerido | Notas |
|-------|------|-----------|-------|
| `key` | string | ✅ | Primary key en `app_config` |

**Response 200 (key existe):**
```json
{
  "key": "ai_context",
  "value": { "tono": "amigable", "nivel": "intermedio" },
  "updated_by": "dashboard",
  "updated_at": "2026-05-18T14:22:00.000Z",
  "found": true
}
```

**Response 200 (key no existe):**
```json
{ "key": "ai_context", "value": null, "found": false }
```

**Response 400:**
```json
{ "error": "Missing key param" }
```

### `?op=kv-set` — Upsert en `app_config`

**Método:** solo `POST` (otros devuelven `405`).

**Request body:**
```json
{
  "key": "ai_context",
  "value": { "tono": "amigable", "nivel": "intermedio" },
  "updated_by": "dashboard"
}
```

| Campo | Tipo | Requerido | Notas |
|-------|------|-----------|-------|
| `key` | string | ✅ | PK |
| `value` | any JSON | ✅ | Puede ser `null`, `[]` o `{}`, **pero NO `undefined`** |
| `updated_by` | string | — | Default `"state-api"`. Útil para auditoría: `"dashboard"`, `"agent-analista"`, etc. |

**Response 200:**
```json
{
  "ok": true,
  "key": "ai_context",
  "updated_by": "dashboard",
  "updated_at": "2026-05-18T14:22:00.000Z"
}
```

**Response 400:**
- `Body JSON inválido`
- `Missing key in body`
- `Missing value (puede ser null, [] o {}, pero no undefined)`

**Response 405** — `op=kv-set requiere POST`.

#### Upsert behavior

Usa `upsert(..., { onConflict: 'key' })` nativo de Supabase. Si la `key` existe → `UPDATE`; si no → `INSERT`. Devuelve la fila resultante (`returning: 'representation'`).

### `?op=ts-append` — Insert en `audit_log`

**Método:** solo `POST`.

**Request body:**
```json
{
  "action": "lead_reactivado",
  "payload": { "lead_id": "abc123", "minutos_silencio": 8 },
  "actor_type": "agent",
  "actor_id": "agent-analista",
  "target_type": "lead",
  "target_id": "abc123"
}
```

| Campo | Tipo | Requerido | Default | Notas |
|-------|------|-----------|---------|-------|
| `action` | string | ✅ | — | Nombre del evento (`lead_reactivado`, `cpc_alerta`, etc.) |
| `payload` | object | — | `{}` | JSONB libre con metadata del evento |
| `actor_type` | string | — | `"system"` | Uno de: `human`, `agent`, `system` |
| `actor_id` | string | — | `"state-api"` | Identificador del actor (vendedor, agente, módulo) |
| `target_type` | string | — | `null` | Tipo del objeto afectado: `lead`, `pipeline`, `campaign`, etc. |
| `target_id` | string | — | `null` | ID del objeto afectado |

**Response 200:**
```json
{
  "ok": true,
  "id": 12345,
  "created_at": "2026-05-18T14:22:00.000Z",
  "action": "lead_reactivado",
  "actor_type": "agent",
  "actor_id": "agent-analista"
}
```

**Response 400:**
- `Body JSON inválido`
- `Missing action in body`
- `actor_type inválido: <valor>` (incluye `valid_actor_types: ['human', 'agent', 'system']`)

**Response 405** — `op=ts-append requiere POST`.

### `?op=ts-read` — Lee `audit_log` con filtros

**Método:** `GET`.

**Query params:**
| Param | Tipo | Default | Notas |
|-------|------|---------|-------|
| `actor_id` | string | — | Filtra por actor exacto |
| `actor_type` | string | — | Uno de: `human`, `agent`, `system` |
| `action` | string | — | Filtra por action exacto |
| `limit` | number | `100` | Máximo `500`, mínimo `1` |

**Response 200:**
```json
{
  "filters": { "actor_id": "agent-analista", "actor_type": null, "action": null },
  "count": 12,
  "limit": 100,
  "rows": [
    {
      "id": 12345,
      "actor_type": "agent",
      "actor_id": "agent-analista",
      "action": "lead_reactivado",
      "target_type": "lead",
      "target_id": "abc123",
      "payload": { "minutos_silencio": 8 },
      "created_at": "2026-05-18T14:22:00.000Z"
    }
  ]
}
```

Rows ordenadas por `created_at DESC`.

**Response 400:**
- `actor_type inválido: <valor>` si el query param es inválido.

### `GET` sin `?op=` — Status + catálogo

**Response 200:**
```json
{
  "status": "ok",
  "endpoint": "/api/state",
  "descripcion": "Supabase-backed kv (app_config) + timeseries (audit_log)",
  "operations": [
    { "op": "kv-get",    "metodo": "GET",  "ejemplo": "?op=kv-get&key=ai_context" },
    { "op": "kv-set",    "metodo": "POST", "body": "{ key, value, updated_by? }" },
    { "op": "ts-append", "metodo": "POST", "body": "{ action, payload, actor_type?, actor_id?, target_type?, target_id? }" },
    { "op": "ts-read",   "metodo": "GET",  "ejemplo": "?op=ts-read&actor_id=state-api&limit=50" }
  ],
  "valid_actor_types": ["human", "agent", "system"],
  "backing_tables": { "kv": "app_config", "ts": "audit_log" },
  "schema": "agents/_shared/supabase-schema.sql"
}
```

## Dependencies

- **Supabase** vía `@supabase/supabase-js` (`createClient`).
- URL del proyecto: `${SUPABASE_URL}` (formato `https://<project>.supabase.co`).
- Cliente reutilizado entre invocaciones (warm starts) — singleton `_client` lazy-inicializado al primer uso.
- Configuración del cliente: `auth.persistSession: false`, `auth.autoRefreshToken: false` (serverless stateless).

## Side effects

- ✅ `?op=kv-set` muta `app_config` (upsert).
- ✅ `?op=ts-append` muta `audit_log` (insert).
- ❌ `?op=kv-get` y `?op=ts-read` son read-only.
- ❌ No envía mensajes, no llama a Wapify/Anthropic/Meta.

## Caller

- **Dashboard GIOCORE** — bloques que antes vivían en `localStorage` (ej. panel "Contexto IA"): leen con `?op=kv-get`, escriben con `?op=kv-set`.
- **Agentes Cowork** (Analista, QA, Creativo, Optimización, Desarrollador, Orquestador) — registran sus acciones en `?op=ts-append` con `actor_type: "agent"`.
- **Cron `/api/webhook?mode=cron`** — escribe eventos de reactivación en `?op=ts-append` con `actor_type: "system"`.
- **Auditoría / debugging manual** vía `?op=ts-read` con filtros.

## Env vars

| Var | Notas |
|-----|-------|
| `SUPABASE_URL` | URL del proyecto Supabase. Formato `https://<project>.supabase.co`. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key formato `sb_secret_*` (no JWT clásico `eyJ...`). **Backend only — NO exponer al cliente.** Validar con regex `sb_(publishable|secret)_[A-Za-z0-9_-]+`. |

Si alguna falta, el primer llamado a `getClient()` lanza `'SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no configurados en Vercel env vars'` capturado por el wrapper `try/catch` del router (devuelve `500`).

## Schema Supabase

Tablas backing definidas en `agents/_shared/supabase-schema.sql` (313 líneas, 11 tablas Cowork del Sprint 1 + `pg_cron` activo):

### `app_config`
| Columna | Tipo | Notas |
|---------|------|-------|
| `key` | text | **PK** |
| `value` | jsonb | Cualquier JSON válido (incluido `null`, `[]`, `{}`) |
| `updated_by` | text | Quién hizo el último upsert |
| `updated_at` | timestamptz | Timestamp del último upsert |

### `audit_log`
| Columna | Tipo | Notas |
|---------|------|-------|
| `id` | bigserial | **PK** auto-increment |
| `actor_type` | text | Uno de `human`, `agent`, `system` |
| `actor_id` | text | Identificador libre |
| `action` | text | Nombre del evento |
| `target_type` | text | Nullable |
| `target_id` | text | Nullable |
| `payload` | jsonb | Default `{}` |
| `created_at` | timestamptz | Default `now()` |

## Notas operativas

- **Timeout**: 60 s configurado en `vercel.json`. Las queries típicas resuelven en <100 ms.
- **No auth público** — el endpoint es público pero la auth real es el `SUPABASE_SERVICE_ROLE_KEY` en backend. **Nunca enviar este key al frontend.**
- **Validación de `actor_type`** en `?op=ts-append` y filtros `?op=ts-read`: rechaza valores fuera de `['human', 'agent', 'system']`.
- **Cliente Supabase reutilizado** entre invocaciones (warm starts). Lazy init en primer `getClient()`.
- **`value` puede ser `null` / `[]` / `{}`** en `?op=kv-set` — `undefined` se rechaza explícitamente con 400.
- **No expone tokens**: la respuesta nunca incluye el service role key.
- **CORS**: `Access-Control-Allow-Origin: *` (mismo patrón que el resto de endpoints).

## Observabilidad

Envuelto en `withSentry(handler, { endpoint: 'state' })`. El catch general del router devuelve `500 { error: err.message }` + `console.error('[state]', err)`; cualquier excepción no atrapada por el try/catch interno la captura el wrapper Sentry. No-op silencioso cuando `SENTRY_DSN` no está configurada.

Estado wrapper: ✅ activo. `SENTRY_DSN` configurada en Vercel Production (18 may 2026 PM tardío).

## Migración desde `localStorage`

| Estado anterior | Estado actual |
|----------------|---------------|
| Dashboard guarda `ai_context` en `localStorage` | `POST /api/state?op=kv-set { key: 'ai_context', value: {...} }` |
| Dashboard lee `ai_context` desde `localStorage` | `GET /api/state?op=kv-get&key=ai_context` |
| Eventos perdidos al cerrar tab | Persistidos en `audit_log` vía `?op=ts-append` |
| Sin auditoría inter-dispositivo | `audit_log` consultable desde cualquier cliente con `?op=ts-read` |

Resuelve la deuda v12 §07 "localStorage como persistencia — fragilidad crítica".

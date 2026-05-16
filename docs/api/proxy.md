---
title: /api/proxy — CORS Proxy Wapify
file_path: /docs/api/proxy.md
source: /api/proxy.js
last_updated: 2026-05-15
---

# `/api/proxy`

Proxy server-side autenticado contra la API REST de Wapify. Permite al dashboard hacer GETs a Wapify sin exponer `WAPIFY_TOKEN` al navegador y sin pelear con CORS.

## URL

```
GET     https://giolens-dashboard.vercel.app/api/proxy?path={wapify_path}&{params}
OPTIONS (CORS preflight)
```

Ejemplo:
```
GET /api/proxy?path=pipelines/216977/opportunities&limit=20&offset=0
GET /api/proxy?path=contacts/61240329
GET /api/proxy?path=pipelines/216977/stages
GET /api/proxy?path=funnels
```

## Métodos

`GET` y `OPTIONS` solamente. NO acepta POST/PUT/DELETE — para mutaciones, los demás endpoints (webhook, reactivation-check) llaman a Wapify directamente.

## Propósito

Aislar el frontend de las credenciales de Wapify. Sin este endpoint, el dashboard tendría que exponer el token o aceptar las restricciones CORS de Wapify.

## Query params

| Param | Tipo | Requerido | Notas |
|-------|------|-----------|-------|
| `path` | string | ✅ | Ruta Wapify a hacer fetch. Debe empezar por una de las whitelisted prefixes |
| `<otros>` | — | — | Cualquier otro query param se pasa tal cual a Wapify |

**Whitelist de path prefixes:**
```
pipelines
contacts
opportunities
funnels
```

## Response

Pass-through del JSON de Wapify, con el mismo status code.

```json
{
  "data": [ /* ... lo que sea que Wapify devuelva ... */ ],
  "meta": { "total": 312, "page": 1 }
}
```

## Response 400

`{ "error": "Ruta no permitida: <path>" }` — si `path` está vacío o no empieza por una whitelisted prefix.

## Response 403

`{ "error": "Acceso no autorizado" }` — si `origin`/`referer` no está en la whitelist:
```
https://giolens-dashboard.vercel.app
http://localhost:3000
http://localhost:5000
```

**Excepción server-to-server**: si NO hay header `origin` ni `referer`, se permite (asume server-side call dentro de Vercel).

## Response 500

`{ "error": "<mensaje>" }` — error de fetch.

## Dependencies

- **Wapify** `https://ap.whapify.ai/api/{path}?{params}`

## Side effects

- ❌ Solo lectura (acepta solo GET).

## Caller

- **Dashboard GIOCORE** — todas las cargas iniciales de listas de pipelines, contactos, oportunidades, funnels.

## Env vars

| Var | Uso |
|-----|-----|
| `WAPIFY_TOKEN` | Header `X-ACCESS-TOKEN` hacia Wapify |

## Notas operativas

- **Timeout**: 10 s default.
- **No rate-limits propios** — depende del rate limit de Wapify (no documentado públicamente; en la práctica responde con 429 → ningún endpoint actual lo reintenta excepto `pipeline-summary` que tiene su propio retry).
- **Seguridad**: la whitelist de orígenes es defensiva pero NO criptográfica. Un actor malicioso puede falsificar el header `Origin` desde curl. El control real está en que la lambda exige `X-ACCESS-TOKEN` que solo está en Vercel env.
- **`Access-Control-Allow-Origin`** se setea a `origin` si está permitido, a `'null'` si no — esto bloquea CORS en el navegador pero no en server-to-server.
- **No expone POST/PUT/DELETE** intencionalmente — escribir a Wapify se hace desde endpoints específicos (webhook, reactivation-check) que validan más estrictamente.

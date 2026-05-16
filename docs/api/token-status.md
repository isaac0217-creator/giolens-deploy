---
title: /api/token-status — Health check de tokens
file_path: /docs/api/token-status.md
source: /api/token-status.js
last_updated: 2026-05-15
---

# `/api/token-status`

Health check público de los tokens configurados en el deploy. NO expone los tokens — solo flags booleanos + días restantes para el token de Meta.

## URL

```
GET     https://giolens-dashboard.vercel.app/api/token-status
OPTIONS (CORS preflight)
```

## Métodos

`GET` y `OPTIONS` solamente.

## Propósito

Permitir al dashboard mostrar alertas tipo "tu Meta token vence en 7 días" sin tener acceso a los tokens reales. Útil para evitar que el deploy se quede sin auth a Meta o Wapify por descuido.

## Response 200

```json
{
  "meta": {
    "configured": true,
    "expires": "2026-07-01",
    "daysLeft": 47
  },
  "wapify": {
    "configured": true
  }
}
```

| Campo | Significado |
|-------|-------------|
| `meta.configured` | `true` si `META_TOKEN` existe en env |
| `meta.expires` | Valor de `META_TOKEN_EXPIRES` (string ISO date `YYYY-MM-DD`) o `null` |
| `meta.daysLeft` | `Math.ceil((new Date(expires) - now) / 86_400_000)` o `null` si `expires` no está configurado |
| `wapify.configured` | `true` si `WAPIFY_TOKEN` existe en env. **No hay `expires` para Wapify** — el token es de larga duración |

## Dependencies

- ❌ Ninguna externa. Pure local check de env vars.

## Side effects

- ❌ Ninguno.

## Caller

- **Dashboard GIOCORE** — banner superior de alertas operacionales.
- Posible: integraciones de monitoreo (Better Uptime, Vercel observability).

## Env vars

| Var | Uso |
|-----|-----|
| `META_TOKEN` | Solo se verifica existencia |
| `META_TOKEN_EXPIRES` | String ISO `YYYY-MM-DD` (manual — debe actualizarse cuando se renueve el token) |
| `WAPIFY_TOKEN` | Solo se verifica existencia |

## Notas operativas

- **Timeout**: 10 s default. Ejecución en <50 ms.
- **`META_TOKEN_EXPIRES` es manual** — Meta NO devuelve esta info en su API de tokens long-lived. Hay que actualizarla a mano cuando se renueva el token (cada ~60 días). Considerar añadir cron que pegue a `/me?fields=token_for_business` para auto-actualizar (no implementado).
- **No expone los tokens** — solo `configured: bool`. Seguro para hacer público.
- **`daysLeft` puede ser negativo** si `META_TOKEN_EXPIRES` ya pasó — útil para mostrar "vencido hace X días".
- **Endpoint público sin auth**: no incluye CORS allow-origin restrictivo. Devuelve `*`.

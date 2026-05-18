# GioLens · Inngest Orchestration Layer

**Estado:** STUB no operativo (Fase 2 Sprint 4, GIOCORE v10).
Esta carpeta contiene la estructura de archivos que se activará cuando tengamos cuenta Inngest y env vars.

Nada aquí se importa todavía desde `/api` ni `/public`. El cliente (`client.js`) es un stub local que solo loggea — los emisores se pueden cablear hoy sin romper producción.

---

## Estructura

```
/inngest/
  client.js              ← cliente Inngest (stub hoy)
  events.js              ← 8 eventos canónicos + 1 experimental
  api-handler-stub.js    ← plantilla de /api/inngest.js
  README.md              ← este archivo
  /functions/
    scan-reactivations.js     cron */5m  → scanea 5 pipelines, emite silence_detected
    send-reactivation.js      event      → copiloto + jitter + wapify send
    run-microseg.js           cron 8am + event → microseg por pipeline + Claude
    run-arbitraje.js          cron */6h + event → Meta insights + Claude recos
    distill-conversation.js   event      → batched 50 contactos + Claude Haiku
    sync-wapify-cache.js      cron */15m → mirror Wapify → Supabase
    refresh-meta-token.js     cron 3am   → long-lived token refresh
    batch-auto-prompt.js      event      → fan-out N variantes Claude
```

---

## Cómo activar (Fase 2C)

1. **Cuenta Inngest:** crear en https://app.inngest.com → app `giolens`.
2. **Env vars en Vercel** (Production + Preview):
   - `INNGEST_EVENT_KEY` — para `inngest.send(...)` desde código (incluido webhook.js)
   - `INNGEST_SIGNING_KEY` — verifica peticiones entrantes en `/api/inngest`
3. **Instalar SDK:**
   ```bash
   npm i inngest
   ```
4. **Reemplazar stub** en `inngest/client.js`:
   ```js
   import { Inngest } from 'inngest';
   export const inngest = new Inngest({
     id: 'giolens',
     eventKey: process.env.INNGEST_EVENT_KEY,
   });
   ```
5. **Crear `/api/inngest.js`** copiando contenido de `inngest/api-handler-stub.js`
   y descomentando el `import { serve } from 'inngest/next'` + `export default serve({...})`.
6. **Deploy:** `vercel --prod`. Inngest descubre el endpoint vía URL pública.
7. **Verificar en dashboard Inngest** que las 8 funciones aparecen registradas.
8. **Smoke test:** desde dashboard Inngest, disparar manualmente `giolens/segmentation.requested`.

---

## Catálogo de eventos

| Evento | Emisor | Consumidor(es) |
|---|---|---|
| `giolens/lead.message_received` | `webhook.js` | scan-reactivations (resetea timers), distill-conversation |
| `giolens/lead.silence_detected` | scan-reactivations | send-reactivation |
| `giolens/lead.reactivation_sent` | send-reactivation | analytics/dashboard (futuro) |
| `giolens/campaign.fatigue_detected` | run-arbitraje | batch-auto-prompt (futuro), notif admin |
| `giolens/segmentation.requested` | cron 8am + manual | run-microseg |
| `giolens/arbitrage.requested` | cron */6h + manual | run-arbitraje |
| `giolens/conversation.distill_requested` | webhook.js (lead cerrado) | distill-conversation |
| `giolens/sync.wapify_pull` | cron */15m + manual | sync-wapify-cache |
| `giolens/campaign.batch_variant_requested` *(exp.)* | dashboard + post-fatigue | batch-auto-prompt |

Shapes detallados en `events.js` (JSDoc por evento).

---

## Dependencias entre funciones

```
cron */5m ──► scan-reactivations ──► silence_detected ──► send-reactivation ──► reactivation_sent
                                                                                     │
                                                                                     ▼
                                                                              analytics (futuro)

cron */6h ──► run-arbitraje ──► fatigue_detected ──► batch-auto-prompt
                                       │
                                       ▼
                                upsert Supabase

cron 8am  ──► run-microseg ──► upsert Supabase

cron */15m ─► sync-wapify-cache ──► upsert Supabase (espejo)

cron 3am  ──► refresh-meta-token ──► upsert secrets

webhook ────► lead.message_received ──► (reset timers de scan-reactivations)
       │
       └───► conversation.distill_requested ──► distill-conversation
```

---

## Migración desde APIs actuales

| API actual (`/api/*.js`) | Estado tras Fase 2C | Notas |
|---|---|---|
| `webhook.js` | **COEXISTE** — emite eventos Inngest además de su flujo síncrono | Único entrypoint de Wapify, no se puede tocar sin coordinar |
| `reactivation-check.js` | **DEPRECA** — reemplazado por `scan-reactivations` + `send-reactivation` | Mantener 2 sprints como fallback, luego retirar el cron de Vercel |
| `microseg.js` | **DEPRECA POST GET** — POST migra a Inngest, GET status sigue para dashboard | Dashboard llama POST `/api/inngest/trigger` con `segmentation.requested` |
| `arbitraje.js` | **DEPRECA POST GET** — idem microseg | |
| `auto-prompt.js` | **COEXISTE** — para single-variant llamada síncrona desde dashboard. `batch-auto-prompt` para lotes. | |
| `copiloto.js` | **COEXISTE** — llamada interna de `send-reactivation` (paso 1) | Refactor futuro: convertir en módulo importable |
| `meta.js`, `token-status.js` | **COEXISTE** — endpoints de lectura para dashboard | |
| `predictor.js`, `pipeline-summary.js` | **COEXISTE** — read-only API | |
| `clean-message.js` | **FUSIONADO** en `text-utils.js?op=clean` (Sprint 1) — utility pública | `proxy.js` eliminado 18 may PM (legacy v9 sin callers) |

---

## Convenciones

- ESM, sin TypeScript.
- Cada función tiene `id: 'giolens-{nombre}'` (namespace para evitar colisiones).
- `correlation_id` obligatorio en todos los payloads (rastrear cascadas).
- Stubs **siempre** retornan algo y loggean (`console.log('[fn-name] ...')`) — nunca silencio.
- `// TODO Fase 2:` con contexto específico de qué hay que reemplazar.

---

## Reglas inamovibles respetadas

- No se modifica `/api/` ni `/public/` en este checkpoint.
- No se introducen dependencias en `package.json` (Inngest se instalará en Fase 2C).
- Stubs son auto-contenidos: `node --check` pasa sin imports rotos.

---
title: /api/reactivation-check — Motor de Reactivación
file_path: /docs/api/reactivation-check.md
source: /api/reactivation-check.js
last_updated: 2026-05-15
status: deprecated
---

> ⚠️ **DEPRECATED — fusionado en `/api/webhook?mode=cron`** (commit `1d6fbf1`, 18 may 2026).
> La lógica de reactivación vive ahora en `webhook.js` bajo el modo cron, junto con el auto-refresh de `META_TOKEN`.
> Esta documentación se preserva **solo por historial git**. Para uso operativo ver [webhook.md](./webhook.md) sección "modo cron".
> El cron Vercel ya apunta a la nueva URL: `*/5 * * * * → /api/webhook?mode=cron`.

# `/api/reactivation-check`

Cron-friendly. Detecta leads que recibieron mensaje del bot pero no han respondido en 4-12 min, y envía un nudge generado por `/api/copiloto`. Diseñado para correr cada 5 min en Vercel Cron (requiere plan Pro).

## URL

```
GET     https://giolens-dashboard.vercel.app/api/reactivation-check
POST    https://giolens-dashboard.vercel.app/api/reactivation-check
OPTIONS (CORS preflight)
```

## Propósito

Recuperar conversiones perdidas por silencio del lead justo después de la primera respuesta del bot. La ventana 4-12 min se eligió porque:
- <4 min: aún puede estar escribiendo / leyendo.
- >12 min: cron próximo lo verá → evita doble envío.

## Métodos

### `GET` / `POST` — Ejecuta el cron

Sin body requerido (acepta ambos verbos para flexibilidad de cron).

**Response 200:**
```json
{
  "started_at":  "2026-05-15T20:30:00.000Z",
  "dry_run":     true,
  "pipelines":   {
    "216977": { "recent_leads": 12 },
    "755062": { "recent_leads": 5 },
    "252999": { "recent_leads": 3 },
    "94103":  { "recent_leads": 8 },
    "273944": { "recent_leads": 4 }
  },
  "candidates": [
    {
      "contact_id": "61240329",
      "stage": "INT2 · CATÁLOGO",
      "pipeline": "94103",
      "silence_min": 7.2,
      "script_preview": "María, te llamó la atención el plateado o el dorado? Si me dices cuál te aparto"
    }
  ],
  "sent": [
    {
      "contact_id": "61240329",
      "stage": "INT2 · CATÁLOGO",
      "pipeline": "94103",
      "silence_min": 7.2,
      "urgencia": "alta",
      "send_result": { "dry_run": true }
    }
  ],
  "skipped": [
    { "contact_id": "61240800", "stage": "NUEVO", "pipeline": "216977", "reason": "too_soon", "silence_min": 2.1 },
    { "contact_id": "61240801", "stage": "BOT ACTIVO", "pipeline": "216977", "reason": "lead_message_is_newest", "silence_min": 0.4 }
  ],
  "errors": [],
  "total_sent": 1,
  "duration_ms": 4321,
  "finished_at": "2026-05-15T20:30:04.321Z"
}
```

**Reasons en `skipped`:**
- `too_soon` — silencio < 4 min
- `window_expired` — silencio > 12 min
- `lead_message_is_newest` — lead respondió, bot pendiente
- `no_last_interaction` — contacto sin `last_interaction`
- `contact_fetch_failed` — error al obtener contact de Wapify

**Response 405** — método ≠ GET/POST/OPTIONS.

## Lógica

```
for each pipeline en [216977, 755062, 252999, 94103, 273944]:
    if totalSent >= MAX_SENDS_PER_RUN (5): break

    leads = GET pipelines/{pid}/opportunities (paginado)
            filter updated_at en últimos 15 min
            filter stage ∉ TERMINAL_STAGES

    for each lead:
        contact = GET contacts/{contact_id}
        last_interaction = contact.last_interaction   (lead → bot, Unix ms)
        last_sent        = contact.last_sent          (bot → lead, Unix ms)
        silenceMs        = now - last_interaction

        needs = (last_sent > last_interaction)  // bot ya respondió
              && (4min <= silenceMs <= 12min)

        if needs:
            copiloto = POST /api/copiloto { pipeline_id, stage_name, contact_id }
            script = copiloto.script || copiloto.alternativa
            send_message(contact_id, script.replace('[nombre]', contact.first_name))
            sleep(500ms)
```

**`TERMINAL_STAGES`** (skip): `VISITA CONFIRMADA`, `visita confirmada`, `FUERA DE CATÁLOGO`, `fuera del flujo`, `FUERA DEL FLUJO`, `CATCH-ALL`.

**`MAX_SENDS_PER_RUN = 5`** — cap de seguridad. Evita mass-messaging si algo falla y el motor envía a decenas de leads.

**`OPPORTUNITY_WINDOW_MS = 15 min`** — pre-filtro barato para no fetchear contactos cuyo opportunity no ha cambiado recientemente.

## Dependencies

- **Wapify**
  - `GET pipelines/{pid}/opportunities?limit=100&offset=N`
  - `GET contacts/{id}` (devuelve `last_interaction`, `last_sent`, `first_name`)
  - `POST contacts/{id}/send` (solo si `DRY_RUN=false`)
- **`/api/copiloto`** (auto-fetch interno) — usa `process.env.VERCEL_URL` para construir la URL absoluta.

## Side effects

- ✅ **Envía mensajes de WhatsApp** (solo si `REACTIVATION_DRY_RUN=false`).
- ❌ No mueve etapas.
- Cap rígido: máximo 5 envíos por ejecución.

## Caller

- **Vercel Cron** (cada 5 min) — requiere plan Pro. En Hobby se ejecuta manualmente o vía cron externo (cron-job.org).
- Disparo manual desde dashboard para debug.

## Env vars

| Var | Uso |
|-----|-----|
| `WAPIFY_TOKEN` | Auth Wapify |
| `REACTIVATION_DRY_RUN` | `'false'` activa envíos reales. **Default (cualquier otro valor) = DRY** — log only |
| `VERCEL_URL` | Base URL para llamar a `/api/copiloto` (Vercel la setea automáticamente) |

## Notas operativas

- **Timeout**: 60 s (`vercel.json`). En extremos puede tocar el límite si los 5 pipelines + 5 contactos + 5 copiloto + 5 sends ocurren — el cap `MAX_SENDS_PER_RUN=5` y el `sleep(500ms)` entre envíos están calibrados para no exceder.
- **`parseWapifyDate` aquí asume UTC** (`replace(' ','T') + 'Z'`), distinto a `microseg` y `predictor` que asumen CST. Discrepancia pendiente — para cálculos de "ventana relativa" UTC vs CST no importa (ambos lados usan la misma base), pero si se compara con `updated_at` desde otra fuente puede haber 6h de drift.
- **Logging extenso**: `[REACTIVATION] Inicio. dry_run=X`, por pipeline, por envío. Útil para auditoría.
- **Replace `[nombre]`**: si Claude devolvió un script con marcador `[nombre]`, se sustituye por `contact.first_name` antes de enviar.
- **Sin BD = sin memoria entre runs**: la deduplicación se basa exclusivamente en la ventana de 4-12 min. Si dos crons se solapan o el cron tarda >5 min, podría haber doble envío para un mismo lead. Mitigación: cap MAX_SENDS_PER_RUN.
- **DRY_RUN flag invertido**: `DRY_RUN = process.env.REACTIVATION_DRY_RUN !== 'false'`. **Es DRY por defecto** — para activar envíos hay que setear explícitamente `REACTIVATION_DRY_RUN=false`.

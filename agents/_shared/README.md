# GioLens — `agents/_shared/`

Capa compartida que consumen los 6 agentes IA de Fase 3 (Analista, Optimizacion, Creativo, Desarrollador, QA, Orquestador). Referencia: HTML maestro GIOCORE v10 §15.

Convencion: ESM, JS puro, sin dependencias npm nuevas.

## Archivos

| Archivo | Rol | Estado |
|---|---|---|
| `anthropic.js`        | Wrapper sobre `api.anthropic.com/v1/messages`. Aplica `cache_control: ephemeral` al system si supera 1k chars. Modelo default `claude-haiku-4-5`. | OPERATIVO (requiere `ANTHROPIC_API_KEY`). |
| `supabase.js`         | `getServiceClient()` y `getAnonClient()` placeholders. | STUB — devuelven `null` + warn. Reemplazar cuando Supabase este provisionado. |
| `bus.js`              | `publish(msg)` / `subscribe(agentName, handler)` sobre `EventEmitter` local. Schema exacto §15 (`from_agent`, `to_agent`, `type`, `payload`, `context_refs`, `requires_ack`, `created_at`). | IN-MEMORY operativo. TODO: portar a `agent_messages` + Postgres realtime. |
| `cost-tracker.js`     | `calcUSD`, `track`, `callTracked`, `getDailyCost`, `getDailyStats`, `checkCap`. Tarifas Haiku 4.5: input $1/MTok, output $5/MTok. | OPERATIVO in-memory. TODO: persistir en `agent_runs`. |
| `approval.js`         | `requestApproval({ decision_id, agent, action, rationale, evidence, amount_usd })`. | STUB Fase 1 — auto-aprueba todo y loguea. |
| `rollback.js`         | Registry `kind -> handler`. Pre-registra `ad_published`, `lead_stage_moved`, `budget_changed`. `register`, `has`, `executeRollback`. | Registry OPERATIVO; handlers son PLACEHOLDERS. |
| `tools/read-kpis.js`            | Tool Anthropic + handler. `GET /api/pipeline-summary?mode=metrics`. Para Analista/Optimizacion/Creativo/QA. | OPERATIVO. |
| `tools/read-pipeline.js`        | Tool + handler. `GET /api/pipeline-summary` (standard o journey). Para Analista/Optimizacion/Creativo/QA. | OPERATIVO. |
| `tools/propose-budget-change.js`| Tool + handler. Solo Optimizacion. | STUB — log + mock success. |
| `index.js`            | Barrel export. Tambien `toolDefsFor([...])` y `runTool(name, input, ctx)`. | OPERATIVO. |
| `__tests__/*.test.js` | Suite Vitest (sintaxis estandar `describe/it/expect`). | Listos para correr cuando se instale `vitest`. |

## Uso minimo desde un agente

```js
import {
  callTracked, publish, subscribe, requestApproval,
  toolDefsFor, runTool,
} from '../_shared/index.js';

const tools = toolDefsFor(['read_kpis', 'read_pipeline']);
const r = await callTracked('analista', {
  systemPrompt: SYSTEM_ANALISTA,
  messages: [{ role: 'user', content: 'Resume KPIs del pipeline 216977' }],
  tools,
});
console.log(`gasto: $${r.usd.toFixed(4)}`);
```

## Migracion futura

- Cuando Supabase exista, solo se actualiza `supabase.js`; `bus.js` y `cost-tracker.js` cambian impl pero mantienen firmas.
- Cuando el dashboard widget exista, `approval.js` deja de auto-aprobar y bloquea hasta respuesta humana.

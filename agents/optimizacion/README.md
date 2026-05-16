# Agente Optimizacion — GioLens (Fase 3 · GIOCORE)

Tercer agente de Fase 3. Riesgo: ALTO. Propone cambios de presupuesto Meta, segmentacion, copy y angulos de venta. NUNCA ejecuta sin gate de aprobacion humana cuando el impacto economico supera $50 USD.

## Que hace

1. Lee KPIs de los 5 pipelines (`read_kpis`) y estado CRM (`read_pipeline`).
2. Pasa el contexto a Claude (Opus 4 para >=3 pipelines, Sonnet 4 para casos puntuales).
3. Recibe un JSON `{ proposals: [...] }` con cambios concretos.
4. Valida cada proposal con `guards.js` (schema + reglas de negocio + irreversibilidad).
5. Emite proposals validadas al bus (`budget_proposal` / `optimization_proposal`).
6. Si hay proposals de prioridad high/critical, emite un `alert` agregado.

## Politica de aprobaciones

| Caso | Behavior |
|---|---|
| `estimated_delta_usd <= $50` | Ejecucion directa (auto-approval implicita). |
| `estimated_delta_usd > $50` | `requestApproval()` obligatorio; ejecucion bloqueada hasta `approved=true`. |
| Cambio `> 100%` sobre el daily_budget actual | `validateProposal()` lo RECHAZA antes de emitir. Hacer en pasos. |
| Daily budget propuesto `< $100 MXN/dia` | `validateProposal()` lo RECHAZA. |
| Accion mutante sin rollback handler registrado | `isIrreversible()` la BLOQUEA. |

Threshold y reglas en `guards.js` (constantes exportadas).

## Archivos

| Archivo | Rol |
|---|---|
| `prompt.js` | `SYSTEM_PROMPT` (identidad, formato JSON, reglas duras del output) |
| `tools.js` | Definiciones Anthropic Tool Use + handlers (`read_*`, `propose_*`, `apply_*`, `pause_*`) |
| `guards.js` | `checkDeltaUsd`, `isIrreversible`, `validateProposal` |
| `graph.js` | `analyzeAndPropose()`, `executeApprovedProposal()` |
| `rollback-handlers.js` | Handlers `budget_changed`, `adset_paused` registrados al import |
| `index.js` | `executeOptimizacionDailyRun()`, `applyApprovedProposal()` |
| `__tests__/optimizacion.test.js` | Tests Vitest con mocks completos |

## Como agregar una nueva tool

1. Si es lectura, agregala primero a `agents/_shared/tools/` (handler default-export).
2. Importala en `tools.js` y agrega su `TOOL_DEFINITIONS` entry (Anthropic schema).
3. Agregala al mapa `TOOL_HANDLERS`.
4. Si es invocable por el LLM, agregala a `LLM_INVOCABLE_TOOLS` (filter). Si es mutante (ejecucion real), NO la agregues al filter — debe disparrla `executeApprovedProposal` con approval.
5. Documenta su uso (y restriccion) en `SYSTEM_PROMPT` en `prompt.js`.
6. Anade tests en `__tests__/optimizacion.test.js`.

## Como registrar un rollback handler

1. Edita `rollback-handlers.js`.
2. Implementa una funcion `rollbackXxx(payload)` que retorne `{ok, detail?, error?}`.
3. Llama `registerRollback('mi_kind', rollbackXxx)` en el side-effect del modulo.
4. Anade el mapping accion -> kind en `guards.js` (`ACTION_TO_ROLLBACK_KIND`).
5. Anade la accion a `MUTATING_ACTIONS` para que `isIrreversible()` la chequee.
6. Anade test verificando que `isIrreversible('mi_accion')` retorna `blocked:false` cuando el handler esta registrado y `blocked:true` cuando no.

## Como invocar (local)

```bash
node -e "import('./index.js').then(m=>m.default())"
```

## Tests

```bash
npx vitest run agents/optimizacion
```

## TODO Fase 2

- Reemplazar STUBs de `apply_budget_change` y `pause_adset` con llamadas reales a Meta Graph API.
- Cablear `requestApproval` al dashboard widget (espera bloqueante).
- Persistir proposals y executions en Supabase (`agent_runs`, `agent_decisions`).
- Heuristica real para `pickModel()` (Opus solo cuando hay critical o presupuesto agregado > $X).
- Leer `MXN_PER_USD` de tipo de cambio en vivo, no constante hardcoded.
- Envolver `executeOptimizacionDailyRun` en `inngest.createFunction(...)`.

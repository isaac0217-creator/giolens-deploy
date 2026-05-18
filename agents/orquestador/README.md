# Agente Orquestador — GioLens (Fase 3 · GIOCORE)

Quinto agente de la Fase 3. **Riesgo bajo**: coordina a los otros 5 agentes (Analista, QA, Creativo, Optimización, Desarrollador). Prioriza tareas. Evita conflictos sobre el mismo recurso. Comparte contexto entre agentes. **NUNCA ejecuta acciones de negocio directamente** — solo emite eventos al bus para que otros sistemas (Fase 2 Inngest) consuman.

## Qué hace

3 flujos bajo demanda, todos producen eventos al bus:

| Flujo | Función | Input | Output JSON / bus event |
|---|---|---|---|
| (1) | `scheduleAgentRun` | `{ targetAgent, task, params, priority, dependsOn, reason }` | `{ scheduled_id, target_agent, priority, estimated_start_at, justification, status:'queued' }` → bus `task_scheduled` |
| (2) | `resolveConflict` | `{ resourceId, resourceType, proposals[] }` | `{ decision, winner_proposal_id, rationale, blocked_proposals[] }` → bus `conflict_resolved` |
| (3) | `shareContext` | `{ sourceAgent, insight, targetAgents \| 'auto' }` | `{ context_msg_ids[], delivered_to[], skipped[] }` → bus `context_shared` (uno por destinatario) |

## Modelo

`claude-opus-4-5` — coordinación es decisión crítica que afecta a todo el ecosistema. Mismo que Desarrollador.

## Reglas de priorización (P1 → P5)

| Prio | Etiqueta | Descripción | SLA |
|---|---|---|---|
| P1 | `blocker_prod` | Blocker producción (rollback, kill switch) | inmediato |
| P2 | `human_pending` | Decisión humana sin atender >30min | +5 min |
| P3 | `approved_execution` | Ejecución de propuestas aprobadas | +15 min |
| P4 | `scheduled_analysis` | Análisis programados (cron Analista) | +60 min |
| P5 | `exploration` | Exploración / eval (sin urgencia) | +6 h |

`estimateStartAt(priority)` aplica estos offsets sobre `Date.now()` cuando el modelo no propone uno.

## Heurísticas de conflicto (orden estricto)

`policies.computeWinner()` aplica en orden y NO invierte pasos:

1. **Cualquier acción irreversible** (`delete`, `deactivate`, `archive`, `force_close`, `drop_table`, `permanent_pause`) → `escalate_human`.
2. **|estimated_delta_usd| > $50** en alguna propuesta → `escalate_human`.
3. **Todas las acciones son merge-compatibles** (`generate_creative_variant`, `export_asset`, `snapshot_kpis`, `enqueue_analysis`) → `merge` (aprobar todas).
4. **Empate**: menor `priority` gana; si empata, menor riesgo de agente gana según ranking `analista(1) < qa(2) < creativo(3) < optimizacion(4) < desarrollador(5)`.
5. **Lista vacía** → `reject_all`.

Este pre-filtro determinista corre **antes** del LLM. Si resuelve solo (escalate, merge, single, empty), `resolveConflict` evita la llamada al modelo (ahorro de costo + reglas duras imposibles de relajar).

## Heurísticas de share_context con `target_agents='auto'`

`policies.inferTargetsForInsight(insight)` recorre `insight.type` (lowercase):

| Patrón en `insight.type` | Destinatarios |
|---|---|
| `fatiga` / `fatigue` / `creative_fatigue` | `creativo` + `optimizacion` |
| `cpr` / `budget` / `spend` / `cpa` | `optimizacion` |
| `bug` / `error` / `failure` / `regression` | `desarrollador` |
| empieza con `qa_` / `test_` | `desarrollador` + `qa` |
| contiene `critical` o `payload.severity === 'critical'` | siempre incluye `analista` |
| nada matchea | broadcast informativo a `analista` |

Filtros adicionales en `graph.shareContext`: `source_agent` se excluye (un agente no recibe lo que él mismo emitió), `orquestador` nunca aparece, y los duplicados se deduplican.

## Restricciones inamovibles

1. **No ejecuta acciones de negocio.** No invoca `apply_budget_change`, `pause_adset`, `propose_patch` ni ninguna mutación de los otros agentes.
2. **No llama a otros agentes** (no importa `executeAnalistaDailyRun` etc.). Solo emite eventos al bus.
3. **No consume el bus directamente** (no hace `subscribe()`). graph.js publica por él; otros consumen.
4. **No inventa agentes.** Universo cerrado: `{ analista, qa, creativo, optimizacion, desarrollador }`.
5. **No inventa resource_ids ni proposal_ids.** Lo que no viene en el input no existe.
6. **Si duda → `escalate_human`** con rationale claro. Mejor pausar que romper.

## Archivos

| Archivo | Rol |
|---|---|
| `prompt.js` | `SYSTEM_PROMPT` (identidad, 3 tasks con formato JSON, reglas P1-P5, heurísticas conflicto, restricciones) |
| `policies.js` | Constantes `PRIORITIES`, `RISK_RANKING`, `CONFLICT_RULES` + función pura `computeWinner` + heurísticas `inferTargetsForInsight`, `isIrreversibleAction`, `areMergeCompatible`, `exceedsHumanEscalationThreshold` |
| `tools.js` | Tools Anthropic (`read_agent_queue`, `read_pending_messages`, `check_resource_locks`, `propose_schedule`, `escalate_to_human`) + helpers de publicación al bus (`publishTaskScheduled`, `publishConflictResolved`, `publishContextShared`) |
| `graph.js` | Orquestación de los 3 flujos. Pre-filtro determinista + LLM opcional + publish + tracking |
| `index.js` | `executeOrquestadorOnDemand({ task, params })` — handler exportable |
| `__tests__/orquestador.test.js` | Tests Vitest con mocks (3 flujos + atajos deterministas + escalación + dispatcher) |
| `__tests__/policies.test.js` | Tests unitarios puros de `policies.js` (sin mocks, deterministas) |

## Cómo invocar (local)

```bash
# (1) Encolar la corrida diaria del Analista
node -e "import('./index.js').then(m=>m.default({
  task: 'schedule_run',
  params: {
    targetAgent: 'analista',
    task: 'daily_run',
    params: { period: 'last_24h' },
    priority: 'P4',
    reason: 'cron 09:00 — análisis matutino'
  }
}))"

# (2) Resolver conflicto sobre el mismo adset
node -e "import('./index.js').then(m=>m.default({
  task: 'resolve_conflict',
  params: {
    resourceId: 'adset-9988',
    resourceType: 'campaign',
    proposals: [
      { agent: 'optimizacion', proposal_id: 'p1', action: 'apply_budget_change',
        priority: 2, estimated_delta_usd: 120 },
      { agent: 'creativo', proposal_id: 'p2', action: 'generate_creative_variant',
        priority: 3, estimated_delta_usd: 0 }
    ]
  }
}))"

# (3) Compartir un insight con destinatarios automáticos
node -e "import('./index.js').then(m=>m.default({
  task: 'share_context',
  params: {
    sourceAgent: 'analista',
    insight: {
      type: 'creative_fatigue_detected',
      payload: { ad_id: '23859', fatigue_score: 0.82 }
    },
    targetAgents: 'auto'
  }
}))"
```

## Dependencias / stubs requeridos

Este agente NO crea código en `/agents/_shared/`. Asume estos exports:

- `_shared/anthropic.js` → `callClaude({ model, system, tools, messages, max_tokens })`
- `_shared/bus.js` → `publish({ from_agent, to_agent, type, payload, requires_ack, context_refs })`
- `_shared/cost-tracker.js` → `track(agent, usage, model)`
- `_shared/approval.js` → `requestApproval({ decision_id, agent, action, rationale, evidence })`

## Pendientes

- `// TODO Fase 2`: envolver `executeOrquestadorOnDemand` en `inngest.createFunction`.
- `// TODO Fase 2`: migrar `graph.js` a LangGraph `StateGraph`.
- `// TODO Fase 2`: `read_agent_queue` lee de Supabase (`agent_runs WHERE status IN ('pending','running')`).
- `// TODO Fase 2`: `read_pending_messages` lee de Supabase (`agent_messages WHERE to_agent=$1 AND acked_at IS NULL`).
- `// TODO Fase 2`: `check_resource_locks` consulta tabla `resource_locks` con lease.
- `// TODO Fase 2`: cron que detecta P2 (humano sin atender >30min) y reescala automáticamente.
- `// TODO Fase 2`: reemplazar `requestApproval` stub por dashboard widget que bloquee hasta input humano real.
- `// TODO Fase 2`: persistir todas las decisiones en Supabase (`agent_decisions`).

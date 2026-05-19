# Anexos B y C — Reporte maestro Cowork (Parte 3)

Fecha de extracción: 2026-05-18
Fuente: lectura estática de `/agents/_shared/bus.js`, `agents/{6 agentes}/{graph.js,tools.js,prompt.js}`, `agents/_shared/tools/*.js`.
No se modificó código durante la extracción.

---

## §B — Contrato del bus interno

**Implementación actual:** `agents/_shared/bus.js` · `publish/subscribe` in-memory (Node `EventEmitter`, canal único `agent_message`, max 100 listeners). Cada `publish({from_agent, to_agent, type, payload, requires_ack?})` valida los 3 primeros campos (`throw new Error('[bus.publish] from_agent, to_agent and type are required')` si falta alguno). `subscribe(agentName, handler)` entrega mensajes donde `to_agent === agentName` o `to_agent === '*'`. Persistencia Supabase pendiente (`TODO` documentado en bus.js:21-23, 59).

**Schema canónico de mensaje** (bus.js:8-17):
```
{ from_agent, to_agent, type, payload, context_refs?, requires_ack?, created_at }
```

| Tipo de evento | Shape JSON (payload + meta) | Emisor(es) | Consumidor(es) esperado(s) | Notas |
|---|---|---|---|---|
| `agent_message` | **shape EMITIDO (BUGGY)**: `{type:'agent_message', from:'analista', severity, payload:insight, ts}` — falta `from_agent` y `to_agent`. **shape DECLARADO en prompt**: `{severity, metric, pipeline_id, observation, recommendation, evidence}` | Analista (`graph.js:96-103`) | Orquestador (`share_context` planeado) · dashboard (planned, sin endpoint) | **BUG runtime P0**: `publish({from:'analista', type:'agent_message', …})` no cumple contrato — `bus.publish` lanza `Error: from_agent, to_agent and type are required`. La publicación nunca llega; el `await` propaga la excepción. **Discrepancia adicional**: el tipo declarado en el prompt sería `analista.insight.critical`/`medium`, pero el código emite `'agent_message'` genérico. |
| `qa_report` (vía `qa/graph.js`) | **shape EMITIDO (BUGGY)**: `{type:'qa_report', from:'qa', severity, payload:report, ts}` — falta `from_agent` y `to_agent`. payload = `{summary:{total,passed,failed,blockers}, findings[], mode, targets[], ts}` | QA (`graph.js:279-285`, envuelto en `try/catch` → loguea pero no propaga) | Orquestador (share/escalation), Desarrollador (vía `qa_failure_diagnosis`), dashboard (planned) | **BUG runtime P0** mismo patrón. El `try/catch` silencia el throw → reporte se pierde silenciosamente. |
| `qa_report` (vía `qa/tools.js::publish_report`) | **shape EMITIDO (BUGGY)**: `{type:'qa_report', from:'qa', payload:report, ts}` — falta `from_agent` y `to_agent` | QA tool `publish_report` (`tools.js:193-198`) — invocable por el LLM | Orquestador, Desarrollador (planeado) | **BUG runtime P0** sin try/catch envolvente → si el LLM llama esta tool, el handler lanza y la respuesta de tool se devuelve como error. |
| `draft.script` | `{task:'script', pipeline_id, stage, status:'draft', requires_approval:true, variants:[{angle, body, rationale}]}` — emitido con `from_agent:'creativo'`, `to_agent:'*'`, `requires_ack:true`, `context_refs:['pipeline:<id>','stage:<x>']` | Creativo `saveDraftScript` (`tools.js:88-101`) | Orquestador (approval gate), dashboard `/agents-approvals.html` (planned wiring) | ✓ Contrato OK. Único agente que respeta `from_agent`/`to_agent`. |
| `draft.ad` | `{task:'ad', pipeline_id, period, status:'draft', requires_approval:true, angles:[{angle, headline≤40, body≤125, cta, rationale}]}` — `from_agent:'creativo'`, `to_agent:'*'`, `requires_ack:true` | Creativo `saveDraftAd` (`tools.js:104-117`) | Orquestador, dashboard approvals (planned) | ✓ Contrato OK. |
| `draft.reactivation` | `{task:'reactivation', pipeline_id, stage_in, days_inactive, status:'draft', primary, alternatives[]}` — `from_agent:'creativo'`, `to_agent:'*'`, `requires_ack:true` | Creativo `saveDraftReactivation` (`tools.js:120-133`) | Orquestador, dashboard approvals (planned) | ✓ Contrato OK. |
| `budget_proposal` | `{proposal_id, pipeline_id, adset_id, current_budget, proposed_budget, rationale, decision_id}` — `from_agent:'optimizacion'`, `to_agent:'*'`, `requires_ack:true` | Optimizacion: `tools.js:121-135` (vía tool `propose_budget_change`) **y** `graph.js:99-108` (vía `publishProposal` cuando `proposal.target==='budget'`) | Orquestador (`resolve_conflict` si hay choque), Aprobador humano (vía `/agents-approvals.html`) | ✓ Contrato OK. Doble emisor (tool del LLM + flow programático). |
| `optimization_proposal` | `{…proposal, proposal_id}` — `from_agent:'optimizacion'`, `to_agent:'*'`, `requires_ack` según `proposal.requires_approval` | Optimizacion (`graph.js:99-108`, `publishProposal` cuando `proposal.target !== 'budget'`) | Orquestador, dashboard approvals | ✓ Contrato OK. Cubre targets `segmentation`/`copy`/`angle` (recomendaciones, no ejecutables). |
| `alert` | `{kind:'high_priority_proposals', count, period, ids[]}` — `from_agent:'optimizacion'`, `to_agent:'*'`, `requires_ack:true` | Optimizacion (`graph.js:201-213`) | Orquestador (priorización), dashboard | ✓ Contrato OK. Se emite agregado tras detectar ≥1 proposal `high`/`critical`. |
| `optimization_executed` | `{proposal_id, action:'apply_budget_change', payload, decision_id, rollback_kind, rollback_payload}` — `from_agent:'optimizacion'`, `to_agent:'*'`, `requires_ack:false` | Optimizacion (`graph.js:319-333`, tras `executeApprovedProposal` exitoso) | Orquestador (audit), dashboard, rollback registry | ✓ Contrato OK. Sólo se emite tras approval gate validado. |
| `qa_failure_diagnosis` | `{task:'analyze_qa_failure', diagnosis, root_cause, suggested_files[], suggested_patches[], confidence, requires_human}` — `from_agent:'desarrollador'`, `to_agent:'qa'`, `requires_ack:requires_human`, `context_refs:['test:<n>','file:<f>'…]` | Desarrollador (`graph.js:170-178`, dentro de `analyzeQAFailure`) | QA (consume diagnóstico) — sin `subscribe` registrado actualmente | ✓ Contrato OK. Único evento dirigido (`to_agent:'qa'`, no broadcast). |
| `draft.fix` | `{task:'generate_fix', file_path, patch:{old,new}, tests_to_add[], rollback_plan, status:'draft', requires_approval:true, sensitive}` — `from_agent:'desarrollador'`, `to_agent:'*'`, `requires_ack:true`, `context_refs:['file:<path>']` | Desarrollador `saveDraftFix` (`tools.js:139-147`) | Orquestador, dashboard approvals | ✓ Contrato OK. |
| `draft.pull_request` | `{task:'create_pull_request', pr_url:'stub://…', title, body_markdown, files_changed[], status:'open', reviewers:['isaac']}` — `from_agent:'desarrollador'`, `to_agent:'*'`, `requires_ack:true` | Desarrollador `saveDraftPR` (`tools.js:164-172`) | Orquestador, dashboard approvals (Fase 4 → GitHub API real) | ✓ Contrato OK. `pr_url` siempre `stub://…` en Fase 1. |
| `task_scheduled` | `{scheduled_id, task, priority(1-5), estimated_start_at, params, depends_on[], justification, status:'queued'}` — `from_agent:'orquestador'`, `to_agent:<targetAgent>`, `requires_ack:true` | Orquestador `publishTaskScheduled` (`tools.js:173-193`) | Agente destino (analista/qa/creativo/optimizacion/desarrollador), Inngest (planned Fase 2) | ✓ Contrato OK. Único evento orquestador→agente específico. |
| `conflict_resolved` | `{resource_id, resource_type, decision:'approve_one'\|'merge'\|'escalate_human'\|'reject_all', winner_proposal_id, rationale, blocked_proposals[], escalation}` — `from_agent:'orquestador'`, `to_agent:'*'`, `requires_ack` si `decision==='escalate_human'` | Orquestador `publishConflictResolved` (`tools.js:216-235`) | Optimizacion (despliegue post-decisión), dashboard, requestApproval (si escalate) | ✓ Contrato OK. |
| `context_shared` | `{context_msg_id, source_agent, insight:{type, payload}}` — `from_agent:'orquestador'`, `to_agent:<targetAgent>`, `requires_ack:false`, `context_refs:[context_msg_id]` | Orquestador `publishContextShared` (`tools.js:257-268`) | Agente destino según heurística (`policies.inferTargetsForInsight`) | ✓ Contrato OK. Loop: una emisión por destinatario. Excluye `orquestador` y `source_agent`. |

**Reglas de discrepancia detectadas:**
- 3 emisores no respetan el shape: **Analista** (`graph.js:96`), **QA `runQA`** (`graph.js:279`), **QA tool `publish_report`** (`tools.js:193`). Todos usan `from` en lugar de `from_agent` y omiten `to_agent`. Resultado: `bus.publish` lanza siempre.
- Ningún consumidor `subscribe()` registrado en código. El bus emite, nadie escucha aún (Fase 1 documentada — Supabase realtime es el plan).
- No existen endpoints `/api/agents-*.js` ni archivos en `public/` que se conecten al bus. `public/agents-approvals.html` existe pero su wiring al bus es trabajo de Fase 2.

---

## §C — Tools declaradas vs implementadas

| Agente | Tool declarada en prompt | Estado | Path archivo | Notas |
|---|---|---|---|---|
| Analista | `read_kpis` | ⚠️ Stub | `agents/_shared/tools/read-kpis.js` + `agents/analista/tools.js:11,53` | Bug P0-2 latente: `analista/graph.js:22,42,49` importa `readKpis` y `readPipeline` como `default` (objeto `{toolDefinition, handler}`) y los llama como función → `TypeError: readKpis is not a function` en runtime. El `try/catch` en `collectPipelineContext` lo silencia y deja `kpis: { error: '…' }`. La tool en sí es OPERATIVA (fetch real a `/api/pipeline-summary`); el bug es en el call site. |
| Analista | `read_pipeline` | ⚠️ Stub | `agents/_shared/tools/read-pipeline.js` + `agents/analista/tools.js:12,54` | Idem `read_kpis` — implementación correcta, call site roto. |
| QA | `load_eval_suite` | ✅ Implementada | `agents/qa/tools.js:136-145` | Lee `/evals/golden/<name>.json` con `existsSync` + `loadGolden` del harness. |
| QA | `run_eval` | ✅ Implementada | `agents/qa/tools.js:151-158` | Resuelve adapter (motor o agente vía `getMotorAdapter`/`getAnalistaAdapter`) y ejecuta `runEval` del harness. Usada por `graph.js::runTarget`. |
| QA | `sandbox_call` | ⚠️ Stub | `agents/qa/tools.js:167-177` | Retorna `{api, mode:'dry_run', payload:{…, dry_run:true}, note, ts}`. No toca red. TODO Fase 2 documentado in-file. |
| QA | `read_snapshot` | ✅ Implementada | `agents/qa/tools.js:182-184` (delega a `runners/regression.js::readSnapshot`) | Devuelve null si snapshot no existe (primer run). |
| QA | `publish_report` | ⚠️ Buggy | `agents/qa/tools.js:189-200` | **BUG runtime P0**: `publish({type:'qa_report', from:'qa', …})` sin `from_agent`/`to_agent` — `bus.publish` lanza. Si el LLM la invoca, la tool revienta. |
| Creativo | `read_top_ads` | ✅ Implementada | `agents/creativo/tools.js:29-55` | Fetch a `/api/meta?level=campaign`. Maneja error sin abortar (devuelve `campaigns:[]` + `error`). |
| Creativo | `read_recent_conversations` | ⚠️ Stub | `agents/creativo/tools.js:67-78` | Mock fijo: 1 conversación placeholder. Marca `stub:true`. TODO Fase 2 → Supabase `conversations`. |
| Creativo | `save_draft_script` | 🔒 Aprobación-only | `agents/creativo/tools.js:88-101` | Implementada y funcional, pero **NO expuesta al LLM** (no aparece en `LLM_INVOCABLE_TOOLS`; el prompt instruye explícitamente "no la llames"). La invoca `graph.js::generateScriptVariants` tras parsear JSON. Emite `draft.script` al bus con `requires_approval:true`. |
| Creativo | `save_draft_ad` | 🔒 Aprobación-only | `agents/creativo/tools.js:104-117` | Idem `save_draft_script`. Emite `draft.ad`. |
| Creativo | `save_draft_reactivation` | 🔒 Aprobación-only | `agents/creativo/tools.js:120-133` | Idem. Emite `draft.reactivation`. |
| Optimizacion | `read_kpis` | ⚠️ Stub | `agents/_shared/tools/read-kpis.js` + `agents/optimizacion/tools.js:13` | Mismo bug P0-2 latente: `optimizacion/graph.js:27,56,62` llama `readKpis`/`readPipeline` (default-imported como objeto) como función → TypeError silenciado por `try/catch` en `collectPipelineContext`. |
| Optimizacion | `read_pipeline` | ⚠️ Stub | `agents/_shared/tools/read-pipeline.js` + `agents/optimizacion/tools.js:14` | Idem. |
| Optimizacion | `propose_budget_change` | ⚠️ Stub | `agents/optimizacion/tools.js:116-138` + `agents/_shared/tools/propose-budget-change.js` | Delega al stub compartido (loguea + devuelve `mock:true, decision_id:'budget-<ts>'`). Publica `budget_proposal` al bus correctamente. No ejecuta cambio real en Meta — sólo emite propuesta. |
| Optimizacion | `apply_budget_change` | 🔒 Aprobación-only | `agents/optimizacion/tools.js:150-174` | **NO expuesta al LLM** (filtrada de `LLM_INVOCABLE_TOOLS`). Sólo invocable desde `graph.js::executeApprovedProposal` con `ctx.approval.approved===true`. Es STUB Fase 1 (console.log + `mock:true`, sin PATCH real a Meta). |
| Optimizacion | `pause_adset` | 🔒 Aprobación-only | `agents/optimizacion/tools.js:179-198` | **NO expuesta al LLM**. Idem `apply_budget_change`: requiere approval y es STUB (no toca Meta). |
| Desarrollador | `read_repo_file` | ✅ Implementada | `agents/desarrollador/tools.js:68-91` | `readFileSync` con validación anti-path-traversal (rechaza paths fuera de `REPO_ROOT`). Marca `sensitive:true` si toca `agents/_shared/`, `api/webhook.js`, `.env`, `package.json`, `vercel.json`. |
| Desarrollador | `propose_patch` | ✅ Implementada | `agents/desarrollador/tools.js:103-112` | Persiste `{file, old, new, at}` en buffer in-memory `_draftPatchBuffer`. `drainProposedPatches()` lo limpia y devuelve copia. No escribe a disco. |
| Desarrollador | `save_draft_fix` | 🔒 Aprobación-only | `agents/desarrollador/tools.js:131-147` | **NO expuesta al LLM** (declarada en `TOOL_DEFINITIONS` para razonamiento, filtrada de `LLM_INVOCABLE_TOOLS`). La invoca `graph.js::generateFix`. Emite `draft.fix` al bus. |
| Desarrollador | `save_draft_pr` | 🔒 Aprobación-only | `agents/desarrollador/tools.js:156-172` | **NO expuesta al LLM**. La invoca `graph.js::createPullRequestStub`. Valida `pr_url` empieza con `'stub://'`. Emite `draft.pull_request`. |
| Orquestador | `read_agent_queue` | ⚠️ Stub | `agents/orquestador/tools.js:57-60` | Mock Fase 1: devuelve `[]`. TODO Fase 2: query `agent_runs WHERE status IN ('pending','running')`. |
| Orquestador | `read_pending_messages` | ⚠️ Stub | `agents/orquestador/tools.js:72-78` | Mock Fase 1: devuelve `[]`. TODO Fase 2: query `agent_messages WHERE to_agent=$1 AND acked_at IS NULL`. |
| Orquestador | `check_resource_locks` | ⚠️ Stub | `agents/orquestador/tools.js:90-94` | Mock Fase 1: devuelve `{locked:false, holders:[]}`. TODO Fase 2: query `resource_locks`. |
| Orquestador | `propose_schedule` | ⚠️ Stub | `agents/orquestador/tools.js:106-118` | Sólo loguea + devuelve `{ok:true, draft_id:'draft-sched-<agent>-<ts>'}`. La emisión real al bus la hace `graph.js::scheduleAgentRun` vía `publishTaskScheduled` tras parsear el JSON del LLM. |
| Orquestador | `escalate_to_human` | ✅ Implementada | `agents/orquestador/tools.js:131-144` | Wrapper limpio sobre `requestApproval` con `action:'orquestador_escalation'`. |

**Estados permitidos (leyenda):**
- ✅ Implementada — función real funcional contra producción o sandbox local.
- ⚠️ Stub — devuelve mock/constante o tiene bug latente que la rompe en runtime.
- ❌ Pendiente — declarada en prompt pero archivo/función no existe (ninguna en el inventario actual).
- 🔒 Aprobación-only — implementada pero **no expuesta al LLM** (filtrada de `LLM_INVOCABLE_TOOLS`); sólo invocable desde `graph.js` tras approval gate.

---

## Bugs runtime detectados durante extracción

### P0-1 — `publish()` sin `from_agent`/`to_agent` (3 call sites)
`bus.publish` exige `from_agent`, `to_agent` y `type` (bus.js:47-49) o lanza `Error: [bus.publish] from_agent, to_agent and type are required`. Tres emisores no cumplen:

1. **`agents/analista/graph.js:96-103`** — `publish({type, from:'analista', severity, payload, ts})`. **Sin try/catch en `publishHighSeverityInsights`** → toda invocación de `runAnalista` con insights `medium+` propaga la excepción y aborta el run en `Step 5`.
2. **`agents/qa/graph.js:279-285`** — `publish({type:'qa_report', from:'qa', severity, payload:report, ts})`. **Envuelto en try/catch** (graph.js:286-288) → el throw se silencia con `console.error`; el reporte QA nunca llega al bus pero el run completa "exitoso".
3. **`agents/qa/tools.js:193-198`** — handler de la tool `publish_report` que el LLM puede invocar. **Sin try/catch en el handler** → si el modelo elige llamar `publish_report`, la respuesta de tool se devuelve como error al LLM.

**Fix sugerido** (no aplicado, fuera de scope de este doc): usar shape canónico `{from_agent:'analista', to_agent:'*', type:'analista.insight', payload:{severity, …insight}}`. Idem para los otros dos.

### P0-2 — Default import de tools tratado como función (call sites en Analista y Optimización)
`agents/_shared/tools/read-kpis.js` y `read-pipeline.js` exportan `default { toolDefinition, handler }` (objeto). Los call sites importan como `import readKpis from '…'` y llaman `await readKpis({…})` (función).

- **`agents/analista/graph.js:22-23,42,49`** — `await readKpis(…)` sobre un objeto → `TypeError: readKpis is not a function`. Silenciado por `try/catch` (graph.js:43-46, 50-53), grabado en `errors[]`, deja `context[pid].kpis = { error: '…' }`. El Analista nunca recibe datos reales de pipeline en producción.
- **`agents/optimizacion/graph.js:27-28,56,62`** — Mismo patrón, mismo silenciamiento. La Optimización opera sobre contexto vacío (`{error:'…'}`) y aún así pide proposals al LLM.

**Fix sugerido**: cambiar a `import { handler as readKpis } from '…'` o llamar `readKpis.handler({…})` en los dos graph.js. Alternativa: que el módulo compartido exporte el handler como default directo (`export default handler`). Cualquiera funciona; la inconsistencia actual es la única causa raíz.

### Observación adicional — Bus sin consumidores
Ningún archivo del repo llama `bus.subscribe()`. Los 15 tipos de evento del §B se emiten al vacío. Los consumidores documentados (Orquestador `share_context`, dashboard approvals) son trabajo de Fase 2 (cuando llegue Supabase realtime o Inngest). Esto NO es un bug — es Fase 1 documentada — pero significa que ningún test E2E puede validar end-to-end del bus hoy.

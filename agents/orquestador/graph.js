/**
 * GioLens — Agente Orquestador · graph.js
 * Rol: Orquesta los 3 flujos del Orquestador. JS plano; cuando LangGraph esté
 *      instalado migra a StateGraph.
 *
 * Flujos públicos:
 *   - scheduleAgentRun({ targetAgent, task, params, priority, dependsOn, reason })
 *   - resolveConflict({ resourceId, resourceType, proposals })
 *   - shareContext({ sourceAgent, insight, targetAgents })
 *
 * Cada flujo:
 *   1. callClaude (modelo Opus 4.5 — coordinación es decisión crítica).
 *   2. Parsea JSON estricto.
 *   3. Aplica guardas duras (policies.js) por encima del modelo.
 *   4. Publica el evento correcto al bus (task_scheduled / conflict_resolved
 *      / context_shared).
 *   5. Trackea costo (track).
 *
 * RESTRICCIONES DURAS (no romper):
 *   - NO ejecuta acciones de negocio. Solo emite eventos al bus.
 *   - NO invoca agentes reales (no llama executeAnalistaDailyRun, etc.).
 *   - Si conflict triggerea escalate_human → llama requestApproval con
 *     justification clara.
 *
 * TODO Fase 2: migrar a LangGraph StateGraph.
 * TODO Fase 2: cuando exista Inngest, envolver cada flujo en inngest.createFunction.
 * TODO Fase 2: persistir runs/decisiones en Supabase (agent_runs, agent_decisions).
 */

import { callClaude } from '../_shared/anthropic.js';
import { publish } from '../_shared/bus.js';
import { track } from '../_shared/cost-tracker.js';
import { requestApproval } from '../_shared/approval.js';
import { SYSTEM_PROMPT } from './prompt.js';
import {
  LLM_INVOCABLE_TOOLS,
  VALID_TARGET_AGENTS,
  isValidTargetAgent,
  publishTaskScheduled,
  publishConflictResolved,
  publishContextShared,
} from './tools.js';
import {
  PRIORITIES,
  normalizePriority,
  computeWinner,
  inferTargetsForInsight,
  isIrreversibleAction,
  exceedsHumanEscalationThreshold,
} from './policies.js';

const MODEL = 'claude-opus-4-5'; // §15: Opus 4.5 — coordinación crítica
const AGENT = 'orquestador';

const VALID_DECISIONS = new Set(['approve_one', 'merge', 'escalate_human', 'reject_all']);

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parsea JSON tolerante a wrappers de texto. Mismo patrón que creativo /
 * optimizacion / desarrollador.
 */
function parseModelJson(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  try {
    return JSON.parse(rawText);
  } catch (_) { /* sigue */ }
  const match = rawText.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (_) { /* sigue */ }
  }
  return null;
}

/**
 * Extrae text block de una respuesta de callClaude (soporta ambos shapes).
 */
function extractText(response) {
  if (!response) return '';
  if (typeof response.text === 'string') return response.text;
  if (Array.isArray(response.content)) {
    const t = response.content.find((b) => b.type === 'text');
    if (t?.text) return t.text;
  }
  return '';
}

/**
 * Calcula costo en USD para Opus 4.5 (fallback heurístico si la respuesta no lo trae).
 * Opus 4.5: $15/MTok input, $75/MTok output.
 */
function calcUsd(response) {
  if (typeof response?.cost_usd === 'number') return response.cost_usd;
  if (typeof response?.usd === 'number') return response.usd;
  const usage = response?.usage;
  if (!usage) return 0;
  return (Number(usage.input_tokens || 0) * 15 + Number(usage.output_tokens || 0) * 75) / 1_000_000;
}

/**
 * Calcula estimated_start_at según prioridad normalizada.
 */
function estimateStartAt(priority, nowMs = Date.now()) {
  const p = normalizePriority(priority);
  const minsByPrio = { 1: 0, 2: 5, 3: 15, 4: 60, 5: 360 };
  const mins = minsByPrio[p] ?? 60;
  return new Date(nowMs + mins * 60 * 1000).toISOString();
}

/**
 * Genera scheduled_id determinístico-ish para un target+timestamp.
 */
function scheduledIdFor(targetAgent, nowMs = Date.now()) {
  return `sched-${targetAgent}-${nowMs}`;
}

/**
 * Genera context_msg_id para un destinatario.
 */
function contextMsgIdFor(targetAgent, nowMs = Date.now(), seq = 0) {
  return `ctx-${targetAgent}-${nowMs}-${seq}`;
}

// ─── Flujo (1): scheduleAgentRun ────────────────────────────────────────────
/**
 * Encola una ejecución para otro agente.
 *
 * @param {object} args
 * @param {string} args.targetAgent  - uno de VALID_TARGET_AGENTS
 * @param {string} args.task         - nombre del task en el agente destino
 * @param {object} [args.params]     - params del task
 * @param {number|string} [args.priority=4]
 * @param {string[]} [args.dependsOn]
 * @param {string} args.reason       - por qué encolar ahora
 * @returns {Promise<{schedule:object|null, cost_usd:number, latency_ms:number, error:string|null, bus_msg?:object}>}
 */
export async function scheduleAgentRun({
  targetAgent,
  task,
  params = {},
  priority,
  dependsOn,
  reason,
} = {}) {
  const t0 = Date.now();
  if (!isValidTargetAgent(targetAgent)) {
    throw new Error(
      `scheduleAgentRun: targetAgent inválido "${targetAgent}". Debe ser uno de: ${VALID_TARGET_AGENTS.join(', ')}`,
    );
  }
  if (!task || typeof task !== 'string') {
    throw new Error('scheduleAgentRun: task requerido (string)');
  }
  if (!reason || typeof reason !== 'string') {
    throw new Error('scheduleAgentRun: reason requerido (string)');
  }

  const userMessage = [
    `Task: schedule_run`,
    `target_agent: ${targetAgent}`,
    `task: ${task}`,
    `priority (input, normalizar a 1..5): ${priority ?? 'unspecified'}`,
    `depends_on: ${Array.isArray(dependsOn) ? dependsOn.join(', ') : 'none'}`,
    `reason: ${reason}`,
    '',
    `params:`,
    JSON.stringify(params, null, 2),
    '',
    'Emite el JSON estricto (task="schedule_run") siguiendo el formato del system prompt.',
  ].join('\n');

  const response = await callClaude({
    model: MODEL,
    systemPrompt: SYSTEM_PROMPT,
    tools: LLM_INVOCABLE_TOOLS,
    messages: [{ role: 'user', content: userMessage }],
    max_tokens: 1024,
  });

  const parsed = parseModelJson(extractText(response));
  let schedule = null;
  let error = null;
  let bus_msg;

  if (
    parsed &&
    parsed.task === 'schedule_run' &&
    typeof parsed.target_agent === 'string'
  ) {
    // Overrides defensivos: el orquestador NO puede cambiar de agente destino
    // ni inventar agentes; forzamos el input original.
    const finalTarget = isValidTargetAgent(parsed.target_agent)
      ? parsed.target_agent.toLowerCase()
      : targetAgent;

    const finalPriority = normalizePriority(parsed.priority ?? priority);
    const nowMs = Date.now();
    const finalScheduledId = parsed.scheduled_id || scheduledIdFor(finalTarget, nowMs);
    const finalStartAt =
      parsed.estimated_start_at || estimateStartAt(finalPriority, nowMs);

    schedule = {
      task: 'schedule_run',
      scheduled_id: finalScheduledId,
      target_agent: finalTarget,
      priority: finalPriority,
      estimated_start_at: finalStartAt,
      justification: String(parsed.justification || reason).slice(0, 280),
      status: 'queued',
      depends_on: Array.isArray(dependsOn) ? dependsOn : [],
    };

    // Publicar al bus
    bus_msg = publishTaskScheduled({
      target_agent: finalTarget,
      scheduled_id: finalScheduledId,
      task,
      priority: finalPriority,
      estimated_start_at: finalStartAt,
      params,
      depends_on: dependsOn,
      justification: schedule.justification,
    });
  } else {
    error = 'parse_failed_or_invalid_shape';
  }

  const cost_usd = calcUsd(response);
  track(AGENT, response?.usage || null, MODEL);

  return {
    schedule,
    cost_usd,
    latency_ms: Date.now() - t0,
    error,
    bus_msg,
  };
}

// ─── Flujo (2): resolveConflict ─────────────────────────────────────────────
/**
 * Resuelve un conflicto entre N propuestas sobre el mismo recurso.
 *
 * Estrategia: aplicar policies.computeWinner() COMO PRE-FILTRO determinista.
 * Si el resultado es 'escalate_human' o el conflicto es trivial (1 propuesta /
 * vacío / merge claro), no se invoca al modelo (ahorro de costo + reglas
 * deterministas).
 *
 * Si el caso es complejo (varias propuestas con priorities mezcladas, alguna
 * con evidencia ambigua), el modelo emite la decisión final dentro de las
 * mismas reglas — graph.js valida que la decisión esté en VALID_DECISIONS.
 *
 * @param {object} args
 * @param {string} args.resourceId
 * @param {string} args.resourceType - campaign|pipeline|lead|creative
 * @param {Array<object>} args.proposals
 * @returns {Promise<{resolution:object|null, cost_usd:number, latency_ms:number, error:string|null, escalation?:object, bus_msg?:object}>}
 */
export async function resolveConflict({ resourceId, resourceType, proposals } = {}) {
  const t0 = Date.now();
  if (!resourceId || typeof resourceId !== 'string') {
    throw new Error('resolveConflict: resourceId requerido (string)');
  }
  if (!Array.isArray(proposals)) {
    throw new Error('resolveConflict: proposals requerido (array)');
  }

  // 1) Pre-filtro determinista (sin LLM)
  const preFilter = computeWinner(proposals);

  // 2) Atajo: si la lista es vacía / 1 proposal / escalate por reglas duras
  //    / merge claro → resolvemos sin llamar al modelo.
  const trivialDecisions = new Set([
    'reject_all',
    'escalate_human',
    'merge',
  ]);
  const isSingleApprove = preFilter.decision === 'approve_one' && proposals.length <= 1;
  const skipLLM = trivialDecisions.has(preFilter.decision) || isSingleApprove;

  let resolution;
  let cost_usd = 0;
  let error = null;

  if (skipLLM) {
    resolution = {
      task: 'resolve_conflict',
      resource_id: resourceId,
      resource_type: resourceType || null,
      decision: preFilter.decision,
      winner_proposal_id: preFilter.winner_proposal_id,
      rationale: preFilter.rationale,
      blocked_proposals: preFilter.blocked_proposals,
    };
  } else {
    // 3) Caso complejo: el modelo emite la decisión final dentro de las reglas.
    const userMessage = [
      `Task: resolve_conflict`,
      `resource_id: ${resourceId}`,
      `resource_type: ${resourceType || 'unspecified'}`,
      '',
      `pre_filter_hint (resultado determinista; tu decisión debe coincidir o justificar la divergencia):`,
      JSON.stringify(preFilter, null, 2),
      '',
      `proposals:`,
      JSON.stringify(proposals, null, 2),
      '',
      'Emite el JSON estricto (task="resolve_conflict") según las reglas del system prompt.',
    ].join('\n');

    const response = await callClaude({
      model: MODEL,
      systemPrompt: SYSTEM_PROMPT,
      tools: LLM_INVOCABLE_TOOLS,
      messages: [{ role: 'user', content: userMessage }],
      max_tokens: 1024,
    });

    const parsed = parseModelJson(extractText(response));
    cost_usd = calcUsd(response);
    track(AGENT, response?.usage || null, MODEL);

    if (
      parsed &&
      parsed.task === 'resolve_conflict' &&
      VALID_DECISIONS.has(parsed.decision)
    ) {
      // Override defensivo: si computeWinner ya dijo 'escalate_human' por
      // reglas duras, el modelo NO puede sobre-aprobar.
      const decision =
        preFilter.decision === 'escalate_human' ? 'escalate_human' : parsed.decision;

      resolution = {
        task: 'resolve_conflict',
        resource_id: resourceId,
        resource_type: resourceType || null,
        decision,
        winner_proposal_id:
          decision === 'approve_one'
            ? parsed.winner_proposal_id || preFilter.winner_proposal_id
            : null,
        rationale: String(parsed.rationale || preFilter.rationale).slice(0, 500),
        blocked_proposals: Array.isArray(parsed.blocked_proposals)
          ? parsed.blocked_proposals
          : preFilter.blocked_proposals,
      };
    } else {
      // Fallback duro: el modelo emitió basura → quedamos con el determinista.
      error = 'parse_failed_or_invalid_shape';
      resolution = {
        task: 'resolve_conflict',
        resource_id: resourceId,
        resource_type: resourceType || null,
        decision: preFilter.decision,
        winner_proposal_id: preFilter.winner_proposal_id,
        rationale: `fallback determinista: ${preFilter.rationale}`,
        blocked_proposals: preFilter.blocked_proposals,
      };
    }
  }

  // 4) Si escalate_human → llamar requestApproval. Bloqueamos las proposals
  //    hasta tener decisión.
  let escalation = null;
  if (resolution.decision === 'escalate_human') {
    escalation = await requestApproval({
      decision_id: `orq-conflict-${resourceId}-${Date.now()}`,
      agent: AGENT,
      action: 'orquestador_escalation',
      rationale: resolution.rationale,
      evidence: {
        resource_id: resourceId,
        resource_type: resourceType || null,
        proposals_count: proposals.length,
        proposals_summary: proposals.map((p) => ({
          proposal_id: p.proposal_id,
          agent: p.agent,
          action: p.action,
          estimated_delta_usd: p.estimated_delta_usd ?? null,
        })),
      },
    });
  }

  // 5) Publicar evento al bus
  const bus_msg = publishConflictResolved({
    resource_id: resourceId,
    resource_type: resourceType,
    decision: resolution.decision,
    winner_proposal_id: resolution.winner_proposal_id,
    rationale: resolution.rationale,
    blocked_proposals: resolution.blocked_proposals,
    escalation,
  });

  return {
    resolution,
    cost_usd,
    latency_ms: Date.now() - t0,
    error,
    escalation,
    bus_msg,
  };
}

// ─── Flujo (3): shareContext ────────────────────────────────────────────────
/**
 * Reparte un insight de un agente a otros relevantes.
 *
 * @param {object} args
 * @param {string} args.sourceAgent
 * @param {{type:string, payload?:object}} args.insight
 * @param {string[]|'auto'} args.targetAgents
 * @returns {Promise<{share:object|null, cost_usd:number, latency_ms:number, error:string|null, bus_msgs?:object[]}>}
 */
export async function shareContext({ sourceAgent, insight, targetAgents } = {}) {
  const t0 = Date.now();
  if (!sourceAgent || typeof sourceAgent !== 'string') {
    throw new Error('shareContext: sourceAgent requerido (string)');
  }
  if (!insight || typeof insight !== 'object' || !insight.type) {
    throw new Error('shareContext: insight con campo "type" requerido');
  }

  // 1) Resolver target_agents
  let resolvedTargets;
  let skipped = [];

  if (targetAgents === 'auto' || targetAgents === undefined) {
    resolvedTargets = inferTargetsForInsight(insight);
  } else if (Array.isArray(targetAgents)) {
    resolvedTargets = [];
    for (const t of targetAgents) {
      if (!isValidTargetAgent(t)) {
        skipped.push({ agent: String(t), reason: 'not in VALID_TARGET_AGENTS' });
        continue;
      }
      resolvedTargets.push(t.toLowerCase());
    }
  } else {
    throw new Error('shareContext: targetAgents debe ser array o "auto"');
  }

  // 2) Filtrar source_agent (no enviarse a sí mismo) + dedupe + sin orquestador.
  const deduped = [];
  const seen = new Set();
  for (const t of resolvedTargets) {
    if (t === sourceAgent.toLowerCase()) {
      skipped.push({ agent: t, reason: 'source_agent === target' });
      continue;
    }
    if (t === 'orquestador') {
      skipped.push({ agent: t, reason: 'no enviar al propio orquestador' });
      continue;
    }
    if (seen.has(t)) continue;
    seen.add(t);
    deduped.push(t);
  }

  // 3) Decidir si llamamos al modelo. Si target='auto', usamos el heurístico
  //    determinista (más barato, más predecible). Si vienen targets explícitos,
  //    igual usamos el determinista — share_context no requiere razonamiento
  //    del LLM si los destinatarios ya están dados. Esto evita gasto innecesario.
  //
  // PERO: si el caller pidió 'auto' con un insight ambiguo (sin matches en la
  // heurística → fallback a 'analista'), igual confirmamos con el modelo para
  // no perder señal. Threshold: si deduped.length === 0, error.
  let cost_usd = 0;
  let error = null;

  if (deduped.length === 0) {
    error = 'no_valid_targets';
    return {
      share: {
        task: 'share_context',
        context_msg_ids: [],
        delivered_to: [],
        skipped,
      },
      cost_usd,
      latency_ms: Date.now() - t0,
      error,
      bus_msgs: [],
    };
  }

  // Llamada opcional al modelo SOLO si target=='auto' y se quiere validación.
  // Para mantener el flujo barato y determinista, ponemos un flag interno:
  // si AUTO_LLM_VALIDATION === true, llamamos. Por defecto false (Fase 1).
  const AUTO_LLM_VALIDATION = false;
  if (targetAgents === 'auto' && AUTO_LLM_VALIDATION) {
    const userMessage = [
      `Task: share_context`,
      `source_agent: ${sourceAgent}`,
      `insight: ${JSON.stringify(insight, null, 2)}`,
      `target_agents: ${JSON.stringify(deduped)}`,
      '',
      'Confirma o ajusta target_agents. Emite el JSON estricto (task="share_context").',
    ].join('\n');

    const response = await callClaude({
      model: MODEL,
      systemPrompt: SYSTEM_PROMPT,
      tools: LLM_INVOCABLE_TOOLS,
      messages: [{ role: 'user', content: userMessage }],
      max_tokens: 512,
    });
    cost_usd = calcUsd(response);
    track(AGENT, response?.usage || null, MODEL);
    // No usamos la respuesta del modelo aquí — la heurística determinista
    // ya filtró. El modelo es solo evidencia de razonamiento.
  }

  // 4) Publicar context_shared al bus, una vez por destinatario.
  const nowMs = Date.now();
  const context_msg_ids = [];
  const bus_msgs = [];

  deduped.forEach((target, idx) => {
    const ctxId = contextMsgIdFor(target, nowMs, idx);
    context_msg_ids.push(ctxId);
    const msg = publishContextShared({
      target_agent: target,
      source_agent: sourceAgent,
      insight,
      context_msg_id: ctxId,
    });
    bus_msgs.push(msg);
  });

  const share = {
    task: 'share_context',
    context_msg_ids,
    delivered_to: deduped,
    skipped,
  };

  return {
    share,
    cost_usd,
    latency_ms: Date.now() - t0,
    error,
    bus_msgs,
  };
}

// ─── Re-export por conveniencia ─────────────────────────────────────────────
export { publish }; // exportado solo para tests/observabilidad
export const __test__ = {
  parseModelJson,
  extractText,
  calcUsd,
  estimateStartAt,
  scheduledIdFor,
  contextMsgIdFor,
};

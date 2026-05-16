/**
 * GioLens — Agente Optimizacion · graph.js
 * Rol: Orquesta el flujo de Optimizacion. JS plano (igual que Analista).
 *      Cuando LangGraph este instalado, migra a StateGraph.
 *
 * Flujo analyzeAndPropose({ pipelineIds, period }):
 *   1. read_kpis + read_pipeline por pipeline
 *   2. callClaude(prompt + datos) → obtener proposals
 *   3. validar cada proposal con guards
 *   4. emitir proposals validadas al bus (budget_proposal | optimization_proposal)
 *   5. track cost
 *
 * Flujo executeApprovedProposal({ proposalId, approval, proposal }):
 *   1. verifica approval
 *   2. snapshot del estado actual ANTES de ejecutar
 *   3. invoca tool correspondiente
 *   4. emite 'optimization_executed'
 *
 * TODO Fase 2: migrar a LangGraph StateGraph cuando este instalado.
 * TODO: persistir proposals/executions en Supabase (tablas agent_runs, agent_decisions).
 */

import { callClaude } from '../_shared/anthropic.js';
import { publish } from '../_shared/bus.js';
import { track } from '../_shared/cost-tracker.js';
import { requestApproval } from '../_shared/approval.js';
import readKpis from '../_shared/tools/read-kpis.js';
import readPipeline from '../_shared/tools/read-pipeline.js';
import { SYSTEM_PROMPT } from './prompt.js';
import {
  LLM_INVOCABLE_TOOLS,
  TOOL_HANDLERS,
  applyBudgetChangeHandler,
  pauseAdsetHandler,
} from './tools.js';
import { checkDeltaUsd, isIrreversible, validateProposal } from './guards.js';
// Side-effect: registra los handlers de rollback en el registry compartido.
import './rollback-handlers.js';

const MODEL_STRATEGIC = 'claude-opus-4';   // decisiones estrategicas
const MODEL_STANDARD  = 'claude-sonnet-4'; // propuestas estandar (default)

const HIGH_PRIORITY = new Set(['high', 'critical']);

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

async function collectPipelineContext(pipelineIds, period) {
  const context = {};
  const errors = [];

  for (const pid of pipelineIds) {
    context[pid] = { pipeline_id: pid, kpis: null, pipeline_state: null };
    try {
      context[pid].kpis = await readKpis({ pipeline_id: pid, period });
    } catch (err) {
      errors.push({ pipeline_id: pid, tool: 'read_kpis', error: err.message });
      context[pid].kpis = { error: err.message };
    }
    try {
      context[pid].pipeline_state = await readPipeline({ pipeline_id: pid });
    } catch (err) {
      errors.push({ pipeline_id: pid, tool: 'read_pipeline', error: err.message });
      context[pid].pipeline_state = { error: err.message };
    }
  }
  return { context, errors };
}

function parseProposals(rawText) {
  if (!rawText || typeof rawText !== 'string') return { proposals: [] };
  try {
    const parsed = JSON.parse(rawText);
    if (Array.isArray(parsed.proposals)) return parsed;
  } catch (_) { /* fallthrough */ }
  const match = rawText.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed.proposals)) return parsed;
    } catch (_) { /* default */ }
  }
  return { proposals: [] };
}

function pickModel(pipelineIds) {
  // TODO Fase 2: heuristica real (ej. critical detectado, presupuesto agregado >$X)
  // Por ahora: si se analizan >=3 pipelines a la vez, usar Opus (estrategico).
  return (pipelineIds?.length || 0) >= 3 ? MODEL_STRATEGIC : MODEL_STANDARD;
}

function proposalIdFor(p, idx) {
  const t = Date.now();
  return `${p?.target || 'prop'}-${p?.pipeline_id || 'global'}-${idx}-${t}`;
}

async function publishProposal(proposal, proposalId) {
  const type = proposal.target === 'budget' ? 'budget_proposal' : 'optimization_proposal';
  publish({
    from_agent: 'optimizacion',
    to_agent:   '*',
    type,
    payload: { ...proposal, proposal_id: proposalId },
    context_refs: [proposalId],
    requires_ack: proposal.requires_approval === true,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// API publica
// ────────────────────────────────────────────────────────────────────────────

/**
 * Analiza pipelines, pide propuestas al modelo, valida y emite al bus.
 * @param {{ pipelineIds: string[], period?: string }} args
 * @returns {Promise<{
 *   proposals: object[],
 *   validated: object[],
 *   blocked: object[],
 *   cost_usd: number,
 *   latency_ms: number,
 *   errors: object[],
 * }>}
 */
export async function analyzeAndPropose({ pipelineIds, period = 'last_24h' } = {}) {
  const t0 = Date.now();
  if (!Array.isArray(pipelineIds) || pipelineIds.length === 0) {
    throw new Error('analyzeAndPropose: pipelineIds debe ser un array no vacio');
  }

  // 1) recolectar contexto
  const { context, errors } = await collectPipelineContext(pipelineIds, period);

  // 2) llamar a Claude
  const model = pickModel(pipelineIds);
  const userMessage = [
    `Periodo: ${period}`,
    `Pipelines: ${pipelineIds.join(', ')}`,
    '',
    'Contexto (JSON):',
    JSON.stringify(context, null, 2),
    '',
    errors.length > 0
      ? `Errores de herramienta (informativo, no abortar): ${JSON.stringify(errors)}`
      : 'Sin errores de herramienta.',
    '',
    'Emite el JSON de proposals segun las reglas del system prompt.',
  ].join('\n');

  const response = await callClaude({
    model,
    system:   SYSTEM_PROMPT,
    tools:    LLM_INVOCABLE_TOOLS,
    messages: [{ role: 'user', content: userMessage }],
    max_tokens: 4096,
  });

  // 3) parsear + validar
  const rawText =
    response?.text ??
    (Array.isArray(response?.content)
      ? response.content.find((b) => b.type === 'text')?.text
      : null) ??
    '';

  const { proposals } = parseProposals(rawText);

  const validated = [];
  const blocked = [];

  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i];
    const v = validateProposal(p);
    if (!v.ok) {
      blocked.push({ proposal: p, reason: v.errors.join('; '), warnings: v.warnings });
      continue;
    }
    // Verificacion adicional: si la propuesta implicita es ejecutable y es irreversible
    // sin handler, bloquearla aqui (defense-in-depth, aunque guards.validateProposal
    // no la chequea explicitamente).
    if (p.target === 'budget') {
      const irr = isIrreversible('apply_budget_change');
      if (irr.blocked) {
        blocked.push({ proposal: p, reason: `irreversible bloqueada: ${irr.reason}` });
        continue;
      }
    }
    const proposalId = proposalIdFor(p, i);
    validated.push({ ...p, proposal_id: proposalId });
  }

  // 4) emitir validadas al bus
  for (const p of validated) {
    await publishProposal(p, p.proposal_id);
  }

  // Tambien publica un alert agregado si hay proposals de alta prioridad
  const highPrio = validated.filter((p) => HIGH_PRIORITY.has(p.priority));
  if (highPrio.length > 0) {
    publish({
      from_agent: 'optimizacion',
      to_agent:   '*',
      type:       'alert',
      payload: {
        kind:    'high_priority_proposals',
        count:   highPrio.length,
        period,
        ids:     highPrio.map((p) => p.proposal_id),
      },
      context_refs: highPrio.map((p) => p.proposal_id),
      requires_ack: true,
    });
  }

  // 5) trackear costo
  const cost_usd =
    typeof response?.cost_usd === 'number'
      ? response.cost_usd
      : (response?.usage?.input_tokens ?? 0) * 0.000015 + // Opus aprox
        (response?.usage?.output_tokens ?? 0) * 0.000075;

  try {
    track('optimizacion', response?.usage || {}, model);
  } catch (_) {
    // si la firma de track difiere, no abortamos el run
  }

  const latency_ms = Date.now() - t0;

  return { proposals, validated, blocked, cost_usd, latency_ms, errors };
}

/**
 * Ejecuta una proposal previamente aprobada (o solicita approval si supera el threshold).
 *
 * @param {{
 *   proposalId: string,
 *   proposal: object,
 *   approval?: { approved:boolean, by:string, at:string, decision_id:string },
 * }} args
 * @returns {Promise<{
 *   ok: boolean,
 *   executed?: object,
 *   approval?: object,
 *   error?: string,
 * }>}
 */
export async function executeApprovedProposal({ proposalId, proposal, approval } = {}) {
  if (!proposalId || !proposal) {
    return { ok: false, error: 'proposalId y proposal requeridos' };
  }

  // 1) Determinar accion concreta segun target
  let action;
  let payload;
  if (proposal.target === 'budget') {
    action = 'apply_budget_change';
    const current = Number(proposal.evidence?.current_value);
    const newBudget = Number(
      proposal.evidence?.proposed_value ?? current + Number(proposal.estimated_delta_usd || 0),
    );
    payload = {
      adset_id:        proposal.evidence?.adset_id || proposal.adset_id,
      previous_budget: current,
      new_budget:      newBudget,
      decision_id:     proposalId,
    };
  } else {
    // por ahora solo budget es ejecutable; segmentation/copy/angle son recomendaciones
    return {
      ok: false,
      error: `target='${proposal.target}' no ejecutable automaticamente; revisar manual`,
    };
  }

  // 2) Bloquear si la accion es irreversible sin handler
  const irr = isIrreversible(action);
  if (irr.blocked) return { ok: false, error: `irreversible: ${irr.reason}` };

  // 3) Approval gate
  const gate = checkDeltaUsd(proposal.estimated_delta_usd);
  let effectiveApproval = approval;
  if (gate.requires_approval) {
    if (!effectiveApproval) {
      effectiveApproval = await requestApproval({
        decision_id: proposalId,
        agent:       'optimizacion',
        action,
        rationale:   proposal.proposed_change,
        evidence:    proposal.evidence,
        amount_usd:  proposal.estimated_delta_usd,
      });
    }
    if (!effectiveApproval?.approved) {
      return { ok: false, error: 'approval no concedida', approval: effectiveApproval };
    }
  } else {
    // delta < threshold: ejecucion directa con auto-approval implicita
    effectiveApproval = effectiveApproval || {
      approved:    true,
      by:          'auto-below-threshold',
      at:          new Date().toISOString(),
      decision_id: proposalId,
    };
  }

  // 4) Ejecutar (snapshot ya esta en payload.previous_budget)
  const handler = TOOL_HANDLERS[action];
  if (typeof handler !== 'function') {
    return { ok: false, error: `handler no encontrado para action=${action}` };
  }
  const execResult = await handler(payload, { approval: effectiveApproval });
  if (!execResult?.ok) {
    return { ok: false, error: execResult?.error || 'ejecucion fallida', approval: effectiveApproval };
  }

  // 5) Emitir evento optimization_executed
  publish({
    from_agent: 'optimizacion',
    to_agent:   '*',
    type:       'optimization_executed',
    payload: {
      proposal_id:      proposalId,
      action,
      payload,
      decision_id:      execResult.decision_id,
      rollback_kind:    execResult.rollback_kind,
      rollback_payload: execResult.rollback_payload,
    },
    context_refs: [proposalId],
    requires_ack: false,
  });

  return { ok: true, executed: execResult, approval: effectiveApproval };
}

// Export interno para tests
export const __test__ = { parseProposals, pickModel, MODEL_STRATEGIC, MODEL_STANDARD };

export default { analyzeAndPropose, executeApprovedProposal };

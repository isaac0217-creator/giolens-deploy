/**
 * GioLens — Agente Creativo · graph.js
 * Rol: Orquestación de los 3 flujos creativos (script / ad / reactivation).
 *      Por ahora es JS plano; cuando LangGraph esté instalado migra a StateGraph.
 *
 * Flujos:
 *   - generateScriptVariants({ pipelineId, stage, insightContext })
 *   - generateAdAngles({ pipelineId, period })
 *   - generateReactivationTemplate({ pipelineId, stageIn, daysInactive })
 *
 * Cada flujo:
 *   1. Llama callClaude con SYSTEM_PROMPT + user message contextual.
 *   2. Parsea el JSON estricto del modelo.
 *   3. Llama save_draft_* (publica al bus con status='draft').
 *   4. Solicita aprobación humana (requestApproval) — stub auto-approve por ahora.
 *   5. Trackea costo (track).
 *
 * TODO Fase 2: migrar a LangGraph StateGraph.
 * TODO Fase 2: cuando exista Inngest, envolver cada generate* en inngest.createFunction.
 * TODO: persistir runs en Supabase (tabla agent_runs).
 */

import { callClaude } from '../_shared/anthropic.js';
import { publish } from '../_shared/bus.js';
import { track } from '../_shared/cost-tracker.js';
import { requestApproval } from '../_shared/approval.js';
import { SYSTEM_PROMPT } from './prompt.js';
import {
  TOOL_DEFINITIONS,
  saveDraftScript,
  saveDraftAd,
  saveDraftReactivation,
} from './tools.js';

const MODEL = 'claude-sonnet-4-5'; // §15: Sonnet 4 para Creativo
const AGENT = 'creativo';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extrae la primera señal de fatiga útil de un array de insights del Analista.
 * Devuelve null si no encuentra nada accionable para creatividad.
 */
export function pickInsight(insights) {
  if (!Array.isArray(insights) || insights.length === 0) return null;
  const fatigueMetrics = ['CTR', 'CPR', 'CPM', 'frequency', 'fatiga_creativa'];
  const ordered = ['critical', 'high', 'medium', 'low'];

  for (const sev of ordered) {
    const hit = insights.find(
      (i) =>
        i?.severity === sev &&
        typeof i?.metric === 'string' &&
        fatigueMetrics.some((m) => i.metric.toLowerCase().includes(m.toLowerCase())),
    );
    if (hit) return hit;
  }
  // fallback: primer insight medium+
  return insights.find((i) => ['medium', 'high', 'critical'].includes(i?.severity)) || null;
}

/**
 * Parsea JSON tolerante a wrappers de texto.
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
 * Calcula costo en USD (fallback heurístico si la respuesta no lo trae).
 */
function calcUsd(response) {
  if (typeof response?.cost_usd === 'number') return response.cost_usd;
  if (typeof response?.usd === 'number') return response.usd;
  const usage = response?.usage;
  if (!usage) return 0;
  // Sonnet 4.5: $3/MTok input, $15/MTok output
  return (Number(usage.input_tokens || 0) * 3 + Number(usage.output_tokens || 0) * 15) / 1_000_000;
}

// ─── Flujo (a): script variants ─────────────────────────────────────────────
/**
 * Genera 3 variantes de script WhatsApp para un pipeline + etapa.
 * @param {object} args
 * @param {string} args.pipelineId
 * @param {string} args.stage
 * @param {object|null} [args.insightContext] - insight del Analista (opcional)
 * @returns {Promise<{draft: object|null, approval: object, cost_usd: number, latency_ms: number, error: string|null}>}
 */
export async function generateScriptVariants({ pipelineId, stage, insightContext = null } = {}) {
  const t0 = Date.now();
  if (!pipelineId || !stage) throw new Error('generateScriptVariants: pipelineId y stage requeridos');

  const userMessage = [
    `Task: script`,
    `Pipeline: ${pipelineId}`,
    `Etapa: ${stage}`,
    insightContext
      ? `Insight de fatiga (del Analista): ${JSON.stringify(insightContext)}`
      : 'Insight de fatiga: none — generar variantes preventivas con ángulos distintos.',
    '',
    'Emite el JSON con exactamente 3 variantes según el formato del system prompt (task="script").',
  ].join('\n');

  const response = await callClaude({
    model: MODEL,
    system: SYSTEM_PROMPT,
    tools: TOOL_DEFINITIONS,
    messages: [{ role: 'user', content: userMessage }],
    max_tokens: 2048,
  });

  const parsed = parseModelJson(extractText(response));
  let draft = null;
  let error = null;

  if (parsed && parsed.task === 'script' && Array.isArray(parsed.variants)) {
    // Enforce defaults
    parsed.pipeline_id = String(pipelineId);
    parsed.stage = String(stage);
    parsed.status = 'draft';
    parsed.requires_approval = true;
    saveDraftScript(parsed);
    draft = parsed;
  } else {
    error = 'parse_failed_or_invalid_shape';
  }

  const cost_usd = calcUsd(response);
  track(AGENT, response?.usage || null, MODEL);

  // Aprobación humana (stub auto-approve Fase 1)
  const approval = draft
    ? await requestApproval({
        decision_id: `creativo-script-${pipelineId}-${Date.now()}`,
        agent: AGENT,
        action: 'create_script_variants',
        rationale: `3 variantes para pipeline ${pipelineId} etapa ${stage}`,
        evidence: { variants_count: draft.variants.length, insight: insightContext },
      })
    : { approved: false, by: 'system', at: new Date().toISOString(), note: 'draft inválido, sin aprobación' };

  return { draft, approval, cost_usd, latency_ms: Date.now() - t0, error };
}

// ─── Flujo (b): ad angles ───────────────────────────────────────────────────
/**
 * Genera 3 ángulos de anuncio Meta Ads para un pipeline.
 * @param {object} args
 * @param {string} args.pipelineId
 * @param {string} [args.period='last_7d']
 * @param {object|null} [args.performanceContext]
 */
export async function generateAdAngles({ pipelineId, period = 'last_7d', performanceContext = null } = {}) {
  const t0 = Date.now();
  if (!pipelineId) throw new Error('generateAdAngles: pipelineId requerido');

  const userMessage = [
    `Task: ad`,
    `Pipeline: ${pipelineId}`,
    `Período: ${period}`,
    performanceContext
      ? `Performance histórica: ${JSON.stringify(performanceContext)}`
      : 'Performance histórica: no provista — usa CPR baseline conocido del pipeline.',
    '',
    'Emite el JSON con exactamente 3 ángulos según el formato del system prompt (task="ad"). Respeta límites: headline ≤40 chars, body ≤125 chars.',
  ].join('\n');

  const response = await callClaude({
    model: MODEL,
    system: SYSTEM_PROMPT,
    tools: TOOL_DEFINITIONS,
    messages: [{ role: 'user', content: userMessage }],
    max_tokens: 2048,
  });

  const parsed = parseModelJson(extractText(response));
  let draft = null;
  let error = null;

  if (parsed && parsed.task === 'ad' && Array.isArray(parsed.angles)) {
    parsed.pipeline_id = String(pipelineId);
    parsed.period = String(period);
    parsed.status = 'draft';
    parsed.requires_approval = true;
    saveDraftAd(parsed);
    draft = parsed;
  } else {
    error = 'parse_failed_or_invalid_shape';
  }

  const cost_usd = calcUsd(response);
  track(AGENT, response?.usage || null, MODEL);

  const approval = draft
    ? await requestApproval({
        decision_id: `creativo-ad-${pipelineId}-${Date.now()}`,
        agent: AGENT,
        action: 'create_ad_angles',
        rationale: `3 ángulos para pipeline ${pipelineId} período ${period}`,
        evidence: { angles_count: draft.angles.length },
      })
    : { approved: false, by: 'system', at: new Date().toISOString(), note: 'draft inválido' };

  return { draft, approval, cost_usd, latency_ms: Date.now() - t0, error };
}

// ─── Flujo (c): reactivation template ───────────────────────────────────────
/**
 * Genera plantilla de reactivación + 2 alternativas para un pipeline.
 * @param {object} args
 * @param {string} args.pipelineId
 * @param {string} args.stageIn
 * @param {number} args.daysInactive
 */
export async function generateReactivationTemplate({ pipelineId, stageIn, daysInactive } = {}) {
  const t0 = Date.now();
  if (!pipelineId || !stageIn || !Number.isFinite(Number(daysInactive))) {
    throw new Error('generateReactivationTemplate: pipelineId, stageIn, daysInactive requeridos');
  }

  const userMessage = [
    `Task: reactivation`,
    `Pipeline: ${pipelineId}`,
    `Etapa estancada: ${stageIn}`,
    `Días inactivo: ${daysInactive}`,
    '',
    'Emite el JSON con 1 plantilla principal + 2 alternativas según el formato del system prompt (task="reactivation"). Incluye [NOMBRE] y [DIAS_INACTIVO] como parámetros.',
  ].join('\n');

  const response = await callClaude({
    model: MODEL,
    system: SYSTEM_PROMPT,
    tools: TOOL_DEFINITIONS,
    messages: [{ role: 'user', content: userMessage }],
    max_tokens: 2048,
  });

  const parsed = parseModelJson(extractText(response));
  let draft = null;
  let error = null;

  if (
    parsed &&
    parsed.task === 'reactivation' &&
    parsed.primary &&
    Array.isArray(parsed.alternatives)
  ) {
    parsed.pipeline_id = String(pipelineId);
    parsed.stage_in = String(stageIn);
    parsed.days_inactive = Number(daysInactive);
    parsed.status = 'draft';
    parsed.requires_approval = true;
    saveDraftReactivation(parsed);
    draft = parsed;
  } else {
    error = 'parse_failed_or_invalid_shape';
  }

  const cost_usd = calcUsd(response);
  track(AGENT, response?.usage || null, MODEL);

  const approval = draft
    ? await requestApproval({
        decision_id: `creativo-react-${pipelineId}-${Date.now()}`,
        agent: AGENT,
        action: 'create_reactivation_template',
        rationale: `Plantilla reactivación pipeline ${pipelineId} etapa ${stageIn} (${daysInactive}d)`,
        evidence: { alternatives_count: draft.alternatives.length },
      })
    : { approved: false, by: 'system', at: new Date().toISOString(), note: 'draft inválido' };

  return { draft, approval, cost_usd, latency_ms: Date.now() - t0, error };
}

// ─── Re-export por conveniencia ─────────────────────────────────────────────
export { publish }; // exportado solo para tests/observabilidad

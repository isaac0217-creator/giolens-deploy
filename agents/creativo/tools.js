/**
 * GioLens — Agente Creativo · tools.js
 * Rol: Declara tools permitidas al Creativo (formato Anthropic Tool Use) y
 *      expone los handlers JS que graph.js usa para guardar drafts en el bus.
 *
 * Política de drafts (Fase 3 §15):
 *   - Todo save_draft_* publica al bus con status='draft' y requires_approval=true.
 *   - Nada se publica como aprobado. El humano (o el dashboard widget Fase 2)
 *     decide la promoción a /templates.
 *
 * TODO Fase 2: read_recent_conversations es STUB. Cuando exista Supabase
 * `conversations`, leer últimos N mensajes filtrados por pipeline_id.
 */

import { publish } from '../_shared/bus.js';
import getCprTable from '../_shared/tools/get-cpr-table.js';

const AGENT_NAME = 'creativo';

// ─── Tool: read_top_ads ─────────────────────────────────────────────────────
/**
 * Lee performance de campañas Meta para un pipeline en un período dado.
 * Reutiliza /api/meta?level=campaign (mismo endpoint que dashboard).
 *
 * @param {object} args
 * @param {string} args.pipeline_id
 * @param {string} args.period  - 'last_7d' | 'last_30d' | 'lifetime'
 * @returns {Promise<{campaigns: Array, period: string, source: string}>}
 */
export async function readTopAds({ pipeline_id, period = 'last_7d' } = {}) {
  if (!pipeline_id) throw new Error('[readTopAds] pipeline_id required');

  // Base URL: en Vercel deploy llega vía VERCEL_URL; en local cae a localhost.
  const base =
    process.env.GIOLENS_API_BASE ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

  const url = `${base}/api/meta?level=campaign&pipeline_id=${encodeURIComponent(pipeline_id)}&period=${encodeURIComponent(period)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`meta ${res.status}: ${body.slice(0, 160)}`);
    }
    const json = await res.json();
    return {
      campaigns: Array.isArray(json?.campaigns) ? json.campaigns : (json?.data || []),
      period,
      source: 'meta_ads',
    };
  } catch (err) {
    // No abortamos al Creativo si Meta falla — devolvemos contexto vacío con el error.
    return { campaigns: [], period, source: 'meta_ads', error: err.message };
  }
}

// ─── Tool: read_recent_conversations (STUB) ─────────────────────────────────
/**
 * STUB Fase 1: devuelve mock con últimas N conversaciones del pipeline.
 * TODO Fase 2: leer de Supabase `conversations` ordenado por updated_at desc.
 *
 * @param {object} args
 * @param {string} args.pipeline_id
 * @param {number} [args.limit=10]
 * @returns {Promise<{conversations: Array, source: string, stub: true}>}
 */
export async function readRecentConversations({ pipeline_id, limit = 10 } = {}) {
  if (!pipeline_id) throw new Error('[readRecentConversations] pipeline_id required');
  // TODO Fase 2: query real a Supabase
  return {
    conversations: [
      // Placeholder mock — reemplazar cuando exista persistencia.
      { lead_id: 'mock-1', pipeline_id, stage: 'COTIZADO', last_msg: '[stub] conversación de ejemplo', updated_at: new Date().toISOString() },
    ].slice(0, limit),
    source: 'crm_wapify',
    stub: true,
  };
}

// ─── Tool: save_draft_script ────────────────────────────────────────────────
/**
 * Persiste variantes de script WhatsApp como draft en el bus.
 * Toda variante queda con status='draft' y requires_approval=true.
 *
 * @param {object} payload  - JSON validado del modelo (task='script')
 * @returns {object} mensaje publicado
 */
export function saveDraftScript(payload) {
  if (!payload || payload.task !== 'script') {
    throw new Error('[saveDraftScript] payload.task must be "script"');
  }
  const enforced = { ...payload, status: 'draft', requires_approval: true };
  return publish({
    from_agent: AGENT_NAME,
    to_agent:   '*',
    type:       'draft.script',
    payload:    enforced,
    requires_ack: true,
    context_refs: [`pipeline:${payload.pipeline_id}`, `stage:${payload.stage || 'unknown'}`],
  });
}

// ─── Tool: save_draft_ad ────────────────────────────────────────────────────
export function saveDraftAd(payload) {
  if (!payload || payload.task !== 'ad') {
    throw new Error('[saveDraftAd] payload.task must be "ad"');
  }
  const enforced = { ...payload, status: 'draft', requires_approval: true };
  return publish({
    from_agent: AGENT_NAME,
    to_agent:   '*',
    type:       'draft.ad',
    payload:    enforced,
    requires_ack: true,
    context_refs: [`pipeline:${payload.pipeline_id}`, `period:${payload.period || 'unknown'}`],
  });
}

// ─── Tool: save_draft_reactivation ──────────────────────────────────────────
export function saveDraftReactivation(payload) {
  if (!payload || payload.task !== 'reactivation') {
    throw new Error('[saveDraftReactivation] payload.task must be "reactivation"');
  }
  const enforced = { ...payload, status: 'draft', requires_approval: true };
  return publish({
    from_agent: AGENT_NAME,
    to_agent:   '*',
    type:       'draft.reactivation',
    payload:    enforced,
    requires_ack: true,
    context_refs: [`pipeline:${payload.pipeline_id}`, `stage_in:${payload.stage_in || 'unknown'}`],
  });
}

// ─── Definiciones Anthropic Tool Use ────────────────────────────────────────
export const TOOL_DEFINITIONS = [
  {
    name: 'read_top_ads',
    description: 'Lee performance de campañas Meta Ads para un pipeline en un período (last_7d, last_30d, lifetime). Solo lectura.',
    input_schema: {
      type: 'object',
      properties: {
        pipeline_id: { type: 'string', description: 'Uno de: 216977, 755062, 252999, 94103, 273944.' },
        period:      { type: 'string', description: 'Ej: last_7d, last_30d, lifetime.' },
      },
      required: ['pipeline_id', 'period'],
    },
  },
  {
    name: 'read_recent_conversations',
    description: 'Lee últimas N conversaciones del pipeline desde CRM Wapify. STUB en Fase 1: devuelve mock.',
    input_schema: {
      type: 'object',
      properties: {
        pipeline_id: { type: 'string' },
        limit:       { type: 'number', description: 'Default 10. Máx 50.' },
      },
      required: ['pipeline_id'],
    },
  },
  // get_cpr_table — CPR vía tool, reemplaza CPRs hardcoded del prompt (delta B2).
  getCprTable.toolDefinition,
];

export const TOOL_HANDLERS = {
  read_top_ads: readTopAds,
  read_recent_conversations: readRecentConversations,
  get_cpr_table: getCprTable,
  // save_draft_* NO se exponen al modelo — los invoca graph.js tras parsear JSON.
};

export default TOOL_DEFINITIONS;

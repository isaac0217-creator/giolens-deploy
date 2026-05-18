/**
 * GioLens — DB helpers para agentes
 * Capa sobre agents/_shared/supabase.js · Sprint 1 wiring 18 may 2026.
 *
 * Provee operaciones de alto nivel sobre las 11 tablas del schema:
 *   - readKnowledgeBase(category, key?)
 *   - readAppConfig(key)
 *   - logAgentRun({ agent_name, model_version, ... })
 *   - logAuditEvent({ actor_type, actor_id, action, ... })
 *   - readPendingApprovals({ agent? })
 *   - publishAgentMessage({ from_agent, to_agent, message_type, payload })
 *
 * Patrón: cada función devuelve `{ ok: bool, data?: any, error?: string }`.
 * Nunca tira excepciones — todos los errores se devuelven como `ok: false`.
 *
 * Pre-requisito: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY en env vars.
 * Sin estos, todas las funciones devuelven `{ ok: false, error: 'no client' }`.
 */

import { getServiceClient } from './supabase.js';

/**
 * Lee knowledge_base. Si `key` es undefined, retorna todos los rows de la categoría.
 * @param {string} category - ej: 'pipeline_meta', 'product_pricing', 'cpr_baseline'
 * @param {string} [key]    - ej: '216977', 'spy_base'
 */
export async function readKnowledgeBase(category, key) {
  const client = getServiceClient();
  if (!client) return { ok: false, error: 'no service client' };

  try {
    let q = client.from('knowledge_base').select('category, key, value, confidence, source, valid_from, valid_until').eq('category', category);
    if (key !== undefined) q = q.eq('key', key);
    const { data, error } = await q;
    if (error) return { ok: false, error: error.message };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Lee app_config por key. Devuelve el value JSONB.
 * @param {string} key - ej: 'reactivation_dry_run', 'analista_mode', 'cost_caps'
 */
export async function readAppConfig(key) {
  const client = getServiceClient();
  if (!client) return { ok: false, error: 'no service client' };

  try {
    const { data, error } = await client
      .from('app_config')
      .select('key, value, updated_by, updated_at')
      .eq('key', key)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Logea una ejecución de agente en `agent_runs`. Devuelve el row creado.
 * @param {object} params
 * @param {string} params.agent_name        - 'analista' | 'qa' | 'creativo' | etc.
 * @param {string} params.agent_version     - 'v0.1.0'
 * @param {string} params.model_version     - 'claude-sonnet-4-5' / 'claude-haiku-4-5'
 * @param {string} [params.mode='shadow']   - 'shadow' | 'production' | 'eval'
 * @param {string} [params.trigger_source]  - 'cron' | 'webhook' | 'manual'
 * @param {object} [params.input_context]
 * @param {object} [params.output_payload]
 * @param {number} [params.tokens_input]
 * @param {number} [params.tokens_output]
 * @param {number} [params.cost_usd]
 * @param {number} [params.latency_ms]
 * @param {string} [params.error]
 * @param {string} [params.finished_at]     - ISO timestamp
 */
export async function logAgentRun(params) {
  const client = getServiceClient();
  if (!client) return { ok: false, error: 'no service client' };

  const row = {
    agent_name: params.agent_name,
    agent_version: params.agent_version || 'v0.1.0',
    model_version: params.model_version,
    mode: params.mode || 'shadow',
    trigger_source: params.trigger_source || 'manual',
    input_context: params.input_context || null,
    output_payload: params.output_payload || null,
    tokens_input: params.tokens_input || null,
    tokens_output: params.tokens_output || null,
    cost_usd: params.cost_usd || null,
    latency_ms: params.latency_ms || null,
    error: params.error || null,
    finished_at: params.finished_at || null,
  };

  try {
    const { data, error } = await client
      .from('agent_runs')
      .insert(row)
      .select('id, started_at')
      .single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Logea un evento en audit_log.
 * @param {object} params
 * @param {'human'|'agent'|'system'} params.actor_type
 * @param {string} params.actor_id
 * @param {string} params.action
 * @param {string} [params.target_type]
 * @param {string} [params.target_id]
 * @param {object} [params.payload]
 */
export async function logAuditEvent(params) {
  const client = getServiceClient();
  if (!client) return { ok: false, error: 'no service client' };

  try {
    const { data, error } = await client
      .from('audit_log')
      .insert({
        actor_type: params.actor_type || 'agent',
        actor_id: params.actor_id,
        action: params.action,
        target_type: params.target_type || null,
        target_id: params.target_id || null,
        payload: params.payload || {},
      })
      .select('id, created_at')
      .single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Lista decisiones pendientes (panel aprobaciones).
 * @param {object} [opts]
 * @param {string} [opts.agent]      - filtrar por agent_name
 * @param {number} [opts.limit=50]
 */
export async function readPendingApprovals(opts = {}) {
  const client = getServiceClient();
  if (!client) return { ok: false, error: 'no service client' };

  const limit = Math.min(Math.max(opts.limit || 50, 1), 500);

  try {
    let q = client
      .from('agent_decisions')
      .select('id, agent_name, decision_type, proposed_action, justification, evidence_refs, severity, expires_at, created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (opts.agent) q = q.eq('agent_name', opts.agent);
    const { data, error } = await q;
    if (error) return { ok: false, error: error.message };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Publica un mensaje en el bus agent_messages.
 * @param {object} params
 * @param {string} params.from_agent
 * @param {string} [params.to_agent]       - null = broadcast
 * @param {string} params.message_type
 * @param {object} params.payload
 * @param {string[]} [params.context_refs] - UUIDs de otros agent_runs
 * @param {boolean} [params.requires_ack=false]
 */
export async function publishAgentMessage(params) {
  const client = getServiceClient();
  if (!client) return { ok: false, error: 'no service client' };

  try {
    const { data, error } = await client
      .from('agent_messages')
      .insert({
        from_agent: params.from_agent,
        to_agent: params.to_agent || null,
        message_type: params.message_type,
        payload: params.payload || {},
        context_refs: params.context_refs || null,
        requires_ack: params.requires_ack || false,
      })
      .select('id, created_at')
      .single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export default {
  readKnowledgeBase,
  readAppConfig,
  logAgentRun,
  logAuditEvent,
  readPendingApprovals,
  publishAgentMessage,
};

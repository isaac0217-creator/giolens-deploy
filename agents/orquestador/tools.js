/**
 * GioLens — Agente Orquestador · tools.js
 * Rol: Declara tools (formato Anthropic Tool Use) que el Orquestador puede
 *      invocar + handlers JS que graph.js usa para emitir eventos al bus.
 *
 * Política de orquestación (§15 v12 GIOCORE):
 *   - El Orquestador NO ejecuta acciones de negocio. Solo:
 *       * lee colas / mensajes pendientes (read_*),
 *       * verifica locks de recursos (check_resource_locks),
 *       * propone schedules (propose_schedule — draft),
 *       * escala al humano (escalate_to_human → requestApproval).
 *   - propose_schedule emite al bus type='task_scheduled' con status='queued'
 *     y requires_ack=true para que Fase 2 (Inngest) consuma.
 *   - check_resource_locks y read_* son MOCK Fase 1; Fase 2 consulta Supabase
 *     (tablas agent_runs, agent_messages, resource_locks).
 *
 * Tools internas (NO expuestas al modelo):
 *   - publishTaskScheduledEvent, publishContextSharedEvent: las invoca
 *     graph.js tras parsear el JSON del modelo.
 *
 * TODO Fase 2: read_agent_queue lee agent_runs WHERE status IN ('pending','running').
 * TODO Fase 2: check_resource_locks consulta tabla resource_locks (lease-based).
 * TODO Fase 2: propose_schedule encola en cola Inngest (en vez de mock).
 */

import { publish } from '../_shared/bus.js';
import { requestApproval } from '../_shared/approval.js';

const AGENT_NAME = 'orquestador';

// Agentes válidos del ecosistema GIOCORE (no inventar otros).
export const VALID_TARGET_AGENTS = Object.freeze([
  'analista',
  'qa',
  'creativo',
  'optimizacion',
  'desarrollador',
]);

/**
 * Valida que un agente esté en el universo conocido.
 */
export function isValidTargetAgent(agent) {
  return typeof agent === 'string' && VALID_TARGET_AGENTS.includes(agent.toLowerCase());
}

// ────────────────────────────────────────────────────────────────────────────
// Tool: read_agent_queue (read-only, MOCK Fase 1)
// ────────────────────────────────────────────────────────────────────────────
/**
 * Devuelve la cola actual de runs pendientes / en curso. Fase 1: mock vacío.
 * Fase 2: SELECT * FROM agent_runs WHERE status IN ('pending','running')
 *         ORDER BY priority ASC, created_at ASC.
 *
 * @returns {Promise<Array<{run_id, agent, task, priority, status, created_at}>>}
 */
export async function readAgentQueue() {
  // TODO Fase 2: query Supabase.
  return [];
}

// ────────────────────────────────────────────────────────────────────────────
// Tool: read_pending_messages (read-only, MOCK Fase 1)
// ────────────────────────────────────────────────────────────────────────────
/**
 * Devuelve mensajes pendientes del bus dirigidos a un agente. Fase 1: mock vacío.
 * Fase 2: SELECT * FROM agent_messages WHERE to_agent=$1 AND acked_at IS NULL.
 *
 * @param {{to_agent:string}} input
 * @returns {Promise<Array<object>>}
 */
export async function readPendingMessages({ to_agent } = {}) {
  if (!to_agent || typeof to_agent !== 'string') {
    return [];
  }
  // TODO Fase 2: query Supabase.
  return [];
}

// ────────────────────────────────────────────────────────────────────────────
// Tool: check_resource_locks (read-only, MOCK Fase 1)
// ────────────────────────────────────────────────────────────────────────────
/**
 * Verifica si un recurso está bloqueado por otro agente. Fase 1: mock libre.
 * Fase 2: SELECT * FROM resource_locks WHERE resource_id=$1 AND released_at IS NULL.
 *
 * @param {{resource_id:string}} input
 * @returns {Promise<{locked:boolean, holders:string[]}>}
 */
export async function checkResourceLocks({ resource_id } = {}) {
  if (!resource_id) return { locked: false, holders: [] };
  // TODO Fase 2: query Supabase.
  return { locked: false, holders: [] };
}

// ────────────────────────────────────────────────────────────────────────────
// Tool: propose_schedule (draft — NO ejecuta)
// ────────────────────────────────────────────────────────────────────────────
/**
 * Guarda un schedule como draft. NO ejecuta. graph.js publica al bus tras
 * parsear el JSON del modelo, NO desde aquí (este handler sólo deja log).
 *
 * @param {{target_agent:string, task:string, priority?:number}} input
 * @returns {Promise<{ok:boolean, draft_id?:string, error?:string}>}
 */
export async function proposeSchedule({ target_agent, task, priority } = {}) {
  if (!isValidTargetAgent(target_agent)) {
    return { ok: false, error: `invalid target_agent: ${target_agent}` };
  }
  if (!task || typeof task !== 'string') {
    return { ok: false, error: 'task required' };
  }
  const draftId = `draft-sched-${target_agent}-${Date.now()}`;
  console.log(
    `[tool:propose_schedule][DRAFT] target=${target_agent} task=${task} priority=${priority ?? 4} draft_id=${draftId}`,
  );
  return { ok: true, draft_id: draftId };
}

// ────────────────────────────────────────────────────────────────────────────
// Tool: escalate_to_human (envuelve requestApproval)
// ────────────────────────────────────────────────────────────────────────────
/**
 * Pide intervención humana cuando una decisión queda fuera de las reglas
 * automáticas del Orquestador. Es un wrapper sobre requestApproval con la
 * acción 'orquestador_escalation' y rationale obligatorio.
 *
 * @param {{reason:string, context?:object, decision_id?:string, resource_id?:string}} input
 * @returns {Promise<{approved:boolean, by:string, at:string, decision_id:string}>}
 */
export async function escalateToHuman({ reason, context, decision_id, resource_id } = {}) {
  const id = decision_id || `orq-escalate-${Date.now()}`;
  const approval = await requestApproval({
    decision_id: id,
    agent: AGENT_NAME,
    action: 'orquestador_escalation',
    rationale: reason || 'orquestador requiere decisión humana',
    evidence: {
      resource_id: resource_id || null,
      context: context || null,
    },
  });
  return approval;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers que graph.js usa para emitir eventos al bus tras parsear el LLM.
// NO se exponen al modelo (no aparecen en LLM_INVOCABLE_TOOLS).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Emite 'task_scheduled' al bus, dirigido al target_agent.
 *
 * @param {{
 *   target_agent: string,
 *   scheduled_id: string,
 *   task: string,
 *   priority: number,
 *   estimated_start_at: string,
 *   params?: object,
 *   depends_on?: string[],
 *   justification: string,
 * }} payload
 * @returns {object} mensaje publicado
 */
export function publishTaskScheduled(payload) {
  if (!payload || !isValidTargetAgent(payload.target_agent)) {
    throw new Error('[publishTaskScheduled] target_agent inválido');
  }
  if (!payload.scheduled_id) {
    throw new Error('[publishTaskScheduled] scheduled_id requerido');
  }
  return publish({
    from_agent: AGENT_NAME,
    to_agent:   payload.target_agent,
    type:       'task_scheduled',
    payload: {
      scheduled_id: payload.scheduled_id,
      task:         payload.task,
      priority:     payload.priority,
      estimated_start_at: payload.estimated_start_at,
      params:       payload.params || {},
      depends_on:   Array.isArray(payload.depends_on) ? payload.depends_on : [],
      justification: payload.justification || null,
      status:       'queued',
    },
    requires_ack: true,
    context_refs: [
      payload.scheduled_id,
      ...(Array.isArray(payload.depends_on) ? payload.depends_on : []),
    ],
  });
}

/**
 * Emite 'conflict_resolved' al bus (broadcast).
 *
 * @param {{
 *   resource_id: string,
 *   resource_type?: string,
 *   decision: string,
 *   winner_proposal_id?: string|null,
 *   rationale: string,
 *   blocked_proposals?: string[],
 *   escalation?: object,
 * }} payload
 * @returns {object} mensaje publicado
 */
export function publishConflictResolved(payload) {
  if (!payload || !payload.resource_id) {
    throw new Error('[publishConflictResolved] resource_id requerido');
  }
  if (!payload.decision) {
    throw new Error('[publishConflictResolved] decision requerida');
  }
  return publish({
    from_agent: AGENT_NAME,
    to_agent:   '*',
    type:       'conflict_resolved',
    payload: {
      resource_id:        payload.resource_id,
      resource_type:      payload.resource_type || null,
      decision:           payload.decision,
      winner_proposal_id: payload.winner_proposal_id ?? null,
      rationale:          payload.rationale,
      blocked_proposals:  Array.isArray(payload.blocked_proposals) ? payload.blocked_proposals : [],
      escalation:         payload.escalation || null,
    },
    requires_ack: payload.decision === 'escalate_human',
    context_refs: [
      payload.resource_id,
      ...(Array.isArray(payload.blocked_proposals) ? payload.blocked_proposals : []),
      ...(payload.winner_proposal_id ? [payload.winner_proposal_id] : []),
    ],
  });
}

/**
 * Emite 'context_shared' al bus dirigido a UN agente. graph.js llama esto
 * en loop, una vez por delivered_to.
 *
 * @param {{
 *   target_agent: string,
 *   source_agent: string,
 *   insight: object,
 *   context_msg_id: string,
 * }} payload
 * @returns {object} mensaje publicado
 */
export function publishContextShared(payload) {
  if (!payload || !isValidTargetAgent(payload.target_agent)) {
    throw new Error('[publishContextShared] target_agent inválido');
  }
  if (!payload.context_msg_id) {
    throw new Error('[publishContextShared] context_msg_id requerido');
  }
  return publish({
    from_agent: AGENT_NAME,
    to_agent:   payload.target_agent,
    type:       'context_shared',
    payload: {
      context_msg_id: payload.context_msg_id,
      source_agent:   payload.source_agent || 'unknown',
      insight:        payload.insight || {},
    },
    requires_ack: false,
    context_refs: [payload.context_msg_id],
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Definiciones Anthropic Tool Use
// ────────────────────────────────────────────────────────────────────────────
export const TOOL_DEFINITIONS = [
  {
    name: 'read_agent_queue',
    description:
      'Lee la cola actual de runs pendientes/en curso de todos los agentes. Solo lectura. Usar para detectar saturación antes de encolar más trabajo.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'read_pending_messages',
    description:
      'Lee mensajes del bus dirigidos a un agente que aún no han sido ack-eados. Solo lectura. Usar para detectar backlog antes de programar otra ronda.',
    input_schema: {
      type: 'object',
      properties: {
        to_agent: {
          type: 'string',
          description:
            'Agente destino. Uno de: analista, qa, creativo, optimizacion, desarrollador.',
        },
      },
      required: ['to_agent'],
    },
  },
  {
    name: 'check_resource_locks',
    description:
      'Verifica si un recurso (campaign_id, pipeline_id, lead_id, creative_id) está siendo modificado por otro agente. Solo lectura. Devuelve { locked, holders[] }.',
    input_schema: {
      type: 'object',
      properties: {
        resource_id: {
          type: 'string',
          description: 'Identificador del recurso a verificar.',
        },
      },
      required: ['resource_id'],
    },
  },
  {
    name: 'propose_schedule',
    description:
      'Guarda en draft un schedule para otro agente. NO ejecuta — graph.js publica al bus tras parsear el JSON final del task.',
    input_schema: {
      type: 'object',
      properties: {
        target_agent: {
          type: 'string',
          description:
            'Agente que ejecutará. Uno de: analista, qa, creativo, optimizacion, desarrollador.',
        },
        task: { type: 'string', description: 'Nombre del task a ejecutar en el agente destino.' },
        priority: {
          type: 'number',
          description: 'Prioridad 1..5 (1=blocker prod, 5=exploración).',
        },
      },
      required: ['target_agent', 'task'],
    },
  },
  {
    name: 'escalate_to_human',
    description:
      'Pide intervención humana cuando una decisión queda fuera de las reglas automáticas. Wrapper sobre requestApproval con action=orquestador_escalation.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Por qué se necesita decisión humana.' },
        resource_id: {
          type: 'string',
          description: 'Recurso afectado (campaign, pipeline, lead, creative).',
        },
        decision_id: { type: 'string', description: 'ID de decisión sugerido (opcional).' },
      },
      required: ['reason'],
    },
  },
];

// Mapa nombre → implementación para resolver tool_use del modelo.
// publishTaskScheduled / publishConflictResolved / publishContextShared NO
// se exponen al modelo — los invoca graph.js.
export const TOOL_HANDLERS = {
  read_agent_queue:       readAgentQueue,
  read_pending_messages:  readPendingMessages,
  check_resource_locks:   checkResourceLocks,
  propose_schedule:       proposeSchedule,
  escalate_to_human:      escalateToHuman,
};

// Tools que el LLM puede invocar. Subset estricto: solo read-only + propose +
// escalate. NUNCA exponer publish* (mutación real).
export const LLM_INVOCABLE_TOOLS = TOOL_DEFINITIONS.filter((t) =>
  [
    'read_agent_queue',
    'read_pending_messages',
    'check_resource_locks',
    'propose_schedule',
    'escalate_to_human',
  ].includes(t.name),
);

export default TOOL_DEFINITIONS;

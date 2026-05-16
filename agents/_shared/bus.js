/**
 * GioLens — Bus de mensajes entre agentes
 * Fase 3 §15. Capa compartida.
 *
 * Estado: IN-MEMORY (EventEmitter local). Misma API que la version final
 * sobre tabla agent_messages de Supabase.
 *
 * Schema de mensaje (HTML maestro v10 §15):
 *   {
 *     from_agent:    string,
 *     to_agent:      string | '*',
 *     type:          string,   // 'request' | 'response' | 'event' | 'alert'
 *     payload:       object,
 *     context_refs:  string[], // IDs de evidencia (decision_id, lead_id, ad_id...)
 *     requires_ack:  boolean,
 *     created_at:    ISO string,
 *   }
 *
 * TODO cuando llegue Supabase:
 *   - publish() -> insert en agent_messages
 *   - subscribe() -> Postgres realtime channel filtrando por to_agent
 *   - mantener fallback in-memory para tests
 */

import { EventEmitter } from 'node:events';

const _emitter = new EventEmitter();
_emitter.setMaxListeners(100);

const CHANNEL = 'agent_message';

/**
 * Publica un mensaje en el bus.
 * @param {object} msg
 * @param {string} msg.from_agent
 * @param {string} msg.to_agent  - nombre de agente destino o '*' para broadcast
 * @param {string} msg.type
 * @param {object} [msg.payload]
 * @param {string[]} [msg.context_refs]
 * @param {boolean} [msg.requires_ack]
 * @returns {object} mensaje normalizado (con created_at agregado)
 */
export function publish(msg) {
  if (!msg || typeof msg !== 'object') {
    throw new Error('[bus.publish] msg must be an object');
  }
  if (!msg.from_agent || !msg.to_agent || !msg.type) {
    throw new Error('[bus.publish] from_agent, to_agent and type are required');
  }
  const normalized = {
    from_agent:   String(msg.from_agent),
    to_agent:     String(msg.to_agent),
    type:         String(msg.type),
    payload:      msg.payload || {},
    context_refs: Array.isArray(msg.context_refs) ? msg.context_refs : [],
    requires_ack: Boolean(msg.requires_ack),
    created_at:   msg.created_at || new Date().toISOString(),
  };
  // TODO cuando llegue Supabase: await supabase.from('agent_messages').insert(normalized)
  _emitter.emit(CHANNEL, normalized);
  return normalized;
}

/**
 * Suscribe un handler a mensajes dirigidos a un agente.
 * @param {string} agentName  - nombre del agente, recibe mensajes con to_agent === agentName o '*'
 * @param {(msg:object)=>void|Promise<void>} handler
 * @returns {() => void}  unsubscribe
 */
export function subscribe(agentName, handler) {
  if (!agentName || typeof handler !== 'function') {
    throw new Error('[bus.subscribe] agentName and handler required');
  }
  const wrapped = (msg) => {
    if (msg.to_agent !== agentName && msg.to_agent !== '*') return;
    try {
      const r = handler(msg);
      if (r && typeof r.catch === 'function') r.catch(err => console.error(`[bus] ${agentName} handler rejected: ${err.message}`));
    } catch (err) {
      console.error(`[bus] ${agentName} handler threw: ${err.message}`);
    }
  };
  _emitter.on(CHANNEL, wrapped);
  return () => _emitter.off(CHANNEL, wrapped);
}

/**
 * Util para tests: borra todos los listeners.
 */
export function _resetForTests() {
  _emitter.removeAllListeners(CHANNEL);
}

export default { publish, subscribe, _resetForTests };

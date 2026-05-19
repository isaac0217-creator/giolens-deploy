/**
 * GioLens — Inngest Bridge (Frente C · C.0.7 · decisión §3.4 opción A)
 *
 * Adapter bidireccional entre dos shapes de mensaje:
 *
 *   bus.js (interno)      { from_agent, to_agent, type, payload,
 *                           context_refs?, requires_ack?, created_at }
 *   Inngest events        { name, data: { correlation_id, ... } }
 *
 * Decisión arquitectural (D1 Chat 19 may · §3.4 A): el bus in-memory sigue
 * siendo el canal CANÓNICO interno entre los 6 agentes. Inngest es transporte
 * EXTERNO (cron, fan-out, durabilidad). Este bridge traduce entre ambos sin
 * que ninguno tenga que conocer el shape del otro.
 *
 * NO modifica bus.js (zona compartida — los 6 agentes dependen de él).
 * NO acopla Inngest dentro del bus. El bridge es opt-in: un caller que quiera
 * que su publish también llegue a Inngest Cloud usa `publishBridged()` en
 * lugar de `publish()` directo.
 *
 * Activación: si `INNGEST_EVENT_KEY` no está seteada, `publishBridged` se
 * comporta idéntico a `publish` (el `inngest` importado es el stub no-op).
 *
 * Fase C.0: el bridge queda disponible. El wiring de callers concretos
 * (qué agentes publican bridged) es trabajo de C.1/C.2.
 */

import { publish } from './bus.js';
import { inngest } from '../../inngest/client.js';

/**
 * Namespace de eventos Inngest derivados de mensajes del bus inter-agente.
 * Los EVENTS canónicos de inngest/events.js cubren orquestación/cron; los
 * mensajes inter-agente del bus usan este namespace separado para no
 * colisionar con el catálogo canónico.
 */
const AGENT_EVENT_PREFIX = 'giolens/agent.';

/** Normaliza un `type` del bus a un segmento de nombre de evento Inngest. */
function normalizeType(type) {
  return String(type || 'message').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

/**
 * Extrae o genera un correlation_id para un mensaje del bus.
 * Prioridad: context_refs[0] (suele ser un decision_id/proposal_id estable)
 * → de lo contrario genera uno determinista-por-llamada.
 */
function correlationIdFor(busMsg) {
  if (Array.isArray(busMsg?.context_refs) && busMsg.context_refs.length > 0) {
    return String(busMsg.context_refs[0]);
  }
  return `bus-${busMsg?.from_agent || 'unknown'}-${Date.now()}`;
}

/**
 * bus message → Inngest event.
 * @param {{from_agent:string,to_agent:string,type:string,payload?:object,
 *   context_refs?:string[],requires_ack?:boolean,created_at?:string}} busMsg
 * @returns {{name:string, data:object}}
 */
export function toInngestEvent(busMsg) {
  if (!busMsg || typeof busMsg !== 'object') {
    throw new Error('[inngest-bridge] busMsg debe ser un objeto');
  }
  if (!busMsg.from_agent || !busMsg.to_agent || !busMsg.type) {
    throw new Error('[inngest-bridge] busMsg requiere from_agent, to_agent y type');
  }
  return {
    name: AGENT_EVENT_PREFIX + normalizeType(busMsg.type),
    data: {
      correlation_id: correlationIdFor(busMsg),
      from_agent:   busMsg.from_agent,
      to_agent:     busMsg.to_agent,
      bus_type:     busMsg.type,
      payload:      busMsg.payload || {},
      context_refs: Array.isArray(busMsg.context_refs) ? busMsg.context_refs : [],
      requires_ack: Boolean(busMsg.requires_ack),
      created_at:   busMsg.created_at || new Date().toISOString(),
    },
  };
}

/**
 * Inngest event → bus message.
 * Inverso de toInngestEvent. Tolera eventos que no nacieron del bridge
 * (mapea lo que puede; el resto cae a defaults).
 * @param {{name:string, data?:object}} event
 * @returns {{from_agent:string,to_agent:string,type:string,payload:object,
 *   context_refs:string[],requires_ack:boolean,created_at:string}}
 */
export function toBusMsg(event) {
  if (!event || typeof event !== 'object' || !event.name) {
    throw new Error('[inngest-bridge] event debe tener name');
  }
  const d = event.data || {};
  const type = d.bus_type
    || (event.name.startsWith(AGENT_EVENT_PREFIX)
      ? event.name.slice(AGENT_EVENT_PREFIX.length)
      : event.name);
  return {
    from_agent:   d.from_agent || 'inngest',
    to_agent:     d.to_agent   || '*',
    type:         String(type),
    payload:      d.payload || d,
    context_refs: Array.isArray(d.context_refs)
      ? d.context_refs
      : (d.correlation_id ? [d.correlation_id] : []),
    requires_ack: Boolean(d.requires_ack),
    created_at:   d.created_at || new Date().toISOString(),
  };
}

/**
 * Publica un mensaje al bus interno Y, si Inngest está activo
 * (`INNGEST_EVENT_KEY` seteada), emite el evento traducido a Inngest Cloud.
 *
 * Sin keys: el `inngest` importado es el stub no-op → equivale a `publish`.
 * El emit a Inngest NUNCA rompe el publish local: si `inngest.send` falla,
 * se loggea y se continúa (el bus interno es la fuente de verdad).
 *
 * @param {object} busMsg  mensaje en shape bus.js
 * @returns {Promise<{busResult:object, inngestSent:boolean, inngestError:string|null}>}
 */
export async function publishBridged(busMsg) {
  // 1) Publicación local (canónica). Si esto tira, propaga — es el contrato real.
  const busResult = publish(busMsg);

  // 2) Espejo a Inngest Cloud (best-effort).
  let inngestSent = false;
  let inngestError = null;
  if (process.env.INNGEST_EVENT_KEY) {
    try {
      await inngest.send(toInngestEvent(busMsg));
      inngestSent = true;
    } catch (err) {
      inngestError = err?.message || String(err);
      console.error('[inngest-bridge] emit a Inngest falló (bus local OK):', inngestError);
    }
  }

  return { busResult, inngestSent, inngestError };
}

export default { toInngestEvent, toBusMsg, publishBridged };

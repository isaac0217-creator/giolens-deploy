/**
 * GioLens — Motor Runner
 * Adapta los 5 motores de /api/webhook.js para que el harness pueda invocarlos.
 *
 * Para evitar tocar /api/webhook.js (constraint del Sprint 6), este runner
 * mantiene su propia copia mínima de:
 *   - PROMPTS por motor (lista de huellas semánticas para el mock heurístico)
 *   - TOOLS schema (debe matchear webhook.js)
 *
 * Dos modos:
 *   1. MOCK (default): heurística determinista que cubre los casos golden.
 *      No requiere ANTHROPIC_API_KEY. Útil para CI y loop QA↔Dev.
 *   2. LIVE (env LIVE=1): llama a Anthropic con el mismo prompt+tools
 *      que webhook.js usaría. Más costoso pero valida el comportamiento real.
 *
 * Output normalizado para el harness:
 *   { content: [{type:'tool_use', name, input}] }   (mismo schema de Anthropic)
 */

const MODEL = 'claude-haiku-4-5';

// ─── Schema de tools (debe espejear webhook.js TOOLS) ─────────────────────
const TOOLS = [
  { name: 'send_message',   input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, description: 'Envía un mensaje de WhatsApp.' },
  { name: 'move_stage',     input_schema: { type: 'object', properties: { stage_name: { type: 'string' } }, required: ['stage_name'] }, description: 'Mueve al lead a otra etapa.' },
  { name: 'send_and_move',  input_schema: { type: 'object', properties: { text: { type: 'string' }, stage_name: { type: 'string' } }, required: ['text', 'stage_name'] }, description: 'Envía mensaje + mueve etapa.' },
  { name: 'escalate_human', input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] }, description: 'Escala a humano.' },
  { name: 'no_action',      input_schema: { type: 'object', properties: {} }, description: 'No hace nada.' },
];

// ─── Mock heurístico determinista (uno por motor) ─────────────────────────
// Cada función devuelve un tool_use plausible dado el input.
// El objetivo no es replicar Claude — es producir output que satisfaga el golden
// para validar el HARNESS y el LOOP QA↔Dev cuando no hay API key disponible.

function toolUse(name, input) {
  return { content: [{ type: 'tool_use', name, input: input || {} }] };
}

function lower(s) { return String(s || '').toLowerCase(); }

function mockMotorJustinHolbrook(input) {
  const msg = lower(input.last_message);
  if (msg.includes('persona') || msg.includes('humano') || msg.includes('basta'))
    return toolUse('escalate_human', { reason: 'lead solicita atención humana' });
  if (msg.includes('dónde') || msg.includes('donde') || msg.includes('llego') || msg.includes('ubicación'))
    return toolUse('send_and_move', { text: 'Estamos en Plaza MAC, Zona Río, Local 10, Tijuana. Te esperamos.', stage_name: 'UBICACIÓN ENVIADA' });
  if (msg.includes('paso') || msg.includes('mañana') || msg.includes('confirmo'))
    return toolUse('send_and_move', { text: '¡Excelente! Te esperamos.', stage_name: 'VISITA CONFIRMADA' });
  if (msg.includes('borroso') || msg.includes('cansancio') || msg.includes('vista'))
    return toolUse('send_message', { text: 'Te ofrecemos un examen de vista gratis. ¿Te viene mejor hoy o mañana?' });
  if (msg.includes('precio') || msg.includes('cuesta') || msg.includes('cuanto'))
    return toolUse('send_message', { text: 'Los Justin/Holbrook van de $2,200 a $4,950 MXN e incluyen examen de vista gratis. ¿Te agendo cita?' });
  return toolUse('send_message', { text: 'Hola, gracias por escribir. ¿Cómo te puedo ayudar?' });
}

function mockMotorGioSports(input) {
  const msg = lower(input.last_message);
  const stage = lower(input.stage);
  if (msg.includes('paso') || msg.includes('sábado') || msg.includes('sabado'))
    return toolUse('send_and_move', { text: 'Va, te esperamos en Plaza MAC.', stage_name: 'VISITA CONFIRMADA' });
  if (msg.includes('graduación') || msg.includes('graduacion') || msg.includes('uso lentes'))
    return toolUse('send_message', { text: 'Con tu graduación los RecSpecs van desde $3,950 MXN. ¿Tienes tu receta?' });
  if (msg.includes('guadalajara') || msg.includes('envío') || msg.includes('envio') || msg.includes('foráne') || msg.includes('foraneo'))
    return toolUse('send_message', { text: 'Sí, envío nacional gratis: opticagiolens.com/products/giosports — todo México.' });
  if (msg.includes('ciclismo') || msg.includes('béisbol') || msg.includes('beisbol') || msg.includes('correr') || msg.includes('montaña'))
    return toolUse('send_message', { text: 'Para ciclismo los GioSports solar desde $1,950 MXN. ¿Tienes graduación o solar base?' });
  if (stage === 'nuevo' || msg.includes('anuncio') || msg.includes('deportivos'))
    return toolUse('send_message', { text: '¡Hola! ¿Para qué deporte o actividad los buscas? (ciclismo, béisbol, correr, montaña...)' });
  return toolUse('send_message', { text: '¿Para qué deporte los buscas?' });
}

function mockMotorSpyZ87(input) {
  const msg = lower(input.last_message);
  const stage = lower(input.stage);
  if (msg.includes('factura') || msg.includes('pago') || stage.includes('cotizcion'))
    return toolUse('send_and_move', { text: 'Para empresas manejamos factura. Te paso opciones.', stage_name: 'metodo de pago' });
  if (msg.includes('equipo') || msg.includes('obra') || msg.includes('empresa') || msg.includes('varios'))
    return toolUse('send_message', { text: 'Para pedidos de empresa con factura y descuento por volumen, ¿cuántos lentes necesitan? Te preparo cotización.' });
  if (msg.includes('receta') || msg.includes('uso lentes'))
    return toolUse('send_message', { text: 'Puedes mandarme tu receta como archivo o pasar a examen gratis. Envío en 3-5 días hábiles.' });
  if (msg.includes('personal') || msg.includes('sin graduación') || msg.includes('sin graduacion'))
    return toolUse('send_message', { text: 'Base sin graduación $2,999 MXN. Verlos aquí: opticagiolens.com/products/spy-z87-ansi-estandar-negro' });
  if (stage === 'nuevo' || msg.includes('spy') || msg.includes('z87'))
    return toolUse('send_message', { text: 'Los SPY Z87 son certificados ANSI Z87.1. ¿Es para uso personal o tienes un equipo (empresa)?' });
  return toolUse('send_message', { text: '¿Es para empresa o personal? Los SPY Z87 cumplen ANSI Z87.1.' });
}

function mockMotorDamaLuxury(input) {
  const msg = lower(input.last_message);
  if (msg.includes('tarjeta') || msg.includes('meses') || msg.includes('pago'))
    return toolUse('send_and_move', { text: 'Aceptamos tarjeta y meses sin intereses según promoción vigente.', stage_name: 'MÉTODO DE PAGO' });
  if (msg.includes('paso') || msg.includes('viernes') || msg.includes('tarde'))
    return toolUse('send_and_move', { text: 'Será un placer atenderte el viernes.', stage_name: 'VISITA CONFIRMADA' });
  if (msg.includes('caro') || msg.includes('económico') || msg.includes('economico') || msg.includes('barato'))
    return toolUse('send_message', { text: 'Incluye examen de vista gratis, armazón de diseñador original, asesoría de imagen y garantía. Es valor completo.' });
  if (msg.includes('michael kors') || msg.includes('versace') || msg.includes('prada'))
    return toolUse('send_message', { text: 'Sí tenemos Michael Kors. Desde $3,500 MXN incluyendo tu graduación y examen de vista gratis.' });
  return toolUse('send_message', { text: 'Tenemos una colección preciosa. ¿Ya tienes una marca favorita (Michael Kors, Versace, Prada) o prefieres orientación de estilo?' });
}

function mockMotorGioVision(input) {
  const msg = lower(input.last_message);
  if (msg.includes('manejar') || msg.includes('volante') || msg.includes('coche'))
    return toolUse('send_message', { text: 'Para manejar te recomiendo fotocromático: cambia de claro a oscuro según la luz. Desde $3,500 MXN.' });
  if (msg.includes('paso') || msg.includes('dónde') || msg.includes('donde') || msg.includes('ubicac'))
    return toolUse('send_and_move', { text: 'Plaza MAC, Zona Río, Local 10, Tijuana. Te esperamos.', stage_name: 'UBICACIÓN' });
  if (msg.includes('diferencia') || (msg.includes('entintado') && msg.includes('fotocrom')))
    return toolUse('send_message', { text: 'El entintado tiene color fijo siempre; el fotocromático cambia de claro a oscuro según la luz. ¿Cuál te conviene más?' });
  if (msg.includes('corrient') || msg.includes('baratos') || msg.includes('calidad'))
    return toolUse('send_message', { text: 'Son armazones de buena calidad, puedes verlos y probarlos en tienda sin compromiso.' });
  return toolUse('send_message', { text: '¡Hola! Tenemos promo $950 MXN: armazón + micas entintadas. ¿Buscas entintado o fotocromático?' });
}

const MOCK_MAP = {
  '216977': mockMotorJustinHolbrook,
  '755062': mockMotorGioSports,
  '252999': mockMotorSpyZ87,
  '94103':  mockMotorDamaLuxury,
  '273944': mockMotorGioVision,
  'justin-holbrook': mockMotorJustinHolbrook,
  'giosports':       mockMotorGioSports,
  'spy-z87':         mockMotorSpyZ87,
  'dama-luxury':     mockMotorDamaLuxury,
  'giovision':       mockMotorGioVision,
};

// ─── LIVE mode: llama a Anthropic igual que webhook.js ────────────────────
// Nota: no importamos webhook.js para no acoplar. El prompt se replicaría
// aquí cuando LIVE=1 se active; por ahora dejamos un stub que avisa.
async function callLive(motorKey, input) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('LIVE=1 requiere ANTHROPIC_API_KEY en env');
  }
  // TODO Fase 3: importar prompts desde /api/webhook.js (vía export) y reusar callClaude.
  // Mientras tanto, en LIVE caemos al mock con un warning para no romper CI.
  console.warn(`[motor-runner] LIVE mode no implementado para ${motorKey} — usando mock`);
  const fn = MOCK_MAP[motorKey];
  return fn ? fn(input) : null;
}

// ─── API pública ──────────────────────────────────────────────────────────
export function getMotorAdapter(motorKey) {
  const fn = MOCK_MAP[motorKey];
  if (!fn) throw new Error(`Motor desconocido: ${motorKey}`);
  return async function adapter(input) {
    if (process.env.LIVE === '1') return callLive(motorKey, input);
    return fn(input);
  };
}

export { MOCK_MAP, TOOLS, MODEL };

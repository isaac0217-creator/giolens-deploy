/**
 * GioLens — Webhook Principal + 5 Motores Claude
 * URL: https://giolens-dashboard.vercel.app/api/webhook
 * Registrar en Wapify → claudeNOVA (ID 278215)
 */

const WAPIFY_TOKEN = process.env.WAPIFY_TOKEN;
const WAPIFY_BASE  = 'https://ap.whapify.ai/api';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5';

// ─── Pipeline → Motor ───
const MOTOR_MAP = {
  '216977': motorJustinHolbrook,
  '755062': motorGioSports,
  '252999': motorSpyZ87,
  '94103':  motorDamaLuxury,
  '273944': motorGioVision,
};

// ─── WAPIFY HELPERS ───

async function wapFetch(path, opts = {}) {
  try {
    const res = await fetch(`${WAPIFY_BASE}/${path}`, {
      ...opts,
      headers: {
        'X-ACCESS-TOKEN': WAPIFY_TOKEN,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    return res.ok ? res.json() : null;
  } catch (err) {
    console.warn(`[wapFetch] ${path} failed: ${err.message}`);
    return null;
  }
}

async function sendWAMessage(contactId, text) {
  // Confirmed working endpoint: contacts/{id}/send
  return wapFetch(`contacts/${contactId}/send`, {
    method: 'POST',
    body: JSON.stringify({ message: text, type: 'text' }),
  });
}

async function moveStage(contactId, stageId, cardId, pipelineId) {
  if (!cardId || !pipelineId) {
    console.warn(`[moveStage] missing cardId=${cardId} or pipelineId=${pipelineId} — skip`);
    return null;
  }
  await wapFetch(`pipelines/${pipelineId}/opportunities/${cardId}`, { method: 'DELETE' });
  return wapFetch(`pipelines/${pipelineId}/opportunities`, {
    method: 'POST',
    body: JSON.stringify({ contact_id: contactId, stage_id: stageId }),
  });
}

// ─── CLAUDE BRAIN ───

const TOOLS = [
  {
    name: 'send_message',
    description: 'Envía un mensaje de WhatsApp al lead. Úsalo para responder, hacer seguimiento, o guiar al lead.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Texto del mensaje. Máx 3 oraciones, tono amable y directo.' } },
      required: ['text'],
    },
  },
  {
    name: 'move_stage',
    description: 'Mueve al lead a otra etapa del CRM según su comportamiento o respuesta.',
    input_schema: {
      type: 'object',
      properties: { stage_name: { type: 'string', description: 'Nombre exacto de la etapa destino.' } },
      required: ['stage_name'],
    },
  },
  {
    name: 'send_and_move',
    description: 'Envía un mensaje Y mueve al lead de etapa al mismo tiempo. Úsalo cuando el mensaje confirma el avance.',
    input_schema: {
      type: 'object',
      properties: {
        text:       { type: 'string' },
        stage_name: { type: 'string' },
      },
      required: ['text', 'stage_name'],
    },
  },
  {
    name: 'escalate_human',
    description: 'Marca al lead para atención humana. Úsalo si el lead está enojado, el caso es complejo, o pide hablar con una persona.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Razón de escalada' } },
      required: ['reason'],
    },
  },
  {
    name: 'no_action',
    description: 'No hacer nada. Úsalo si el lead acaba de recibir un mensaje reciente, si la conversación está resuelta, o si no hay acción necesaria ahora.',
    input_schema: { type: 'object', properties: {} },
  },
];

async function callClaude(systemPrompt, history, fallbackContext = null) {
  const messages = history
    .filter(m => m.body || m.message)
    .map(m => ({
      role: m.from_me ? 'assistant' : 'user',
      content: String(m.body || m.message || '').trim(),
    }))
    .filter(m => m.content.length > 0);

  if (messages.length === 0) {
    if (!fallbackContext) return null;
    messages.push({ role: 'user', content: fallbackContext });
  }

  const normalized = [];
  for (const m of messages) {
    if (normalized.length > 0 && normalized[normalized.length - 1].role === m.role) {
      normalized[normalized.length - 1].content += '\n' + m.content;
    } else {
      normalized.push({ ...m });
    }
  }
  if (normalized[normalized.length - 1]?.role === 'assistant') {
    normalized.pop();
  }
  if (normalized.length === 0) return null;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        system: [
          { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
        ],
        messages: normalized,
        tools: TOOLS,
        tool_choice: { type: 'auto' },
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error(`[Claude] API error ${res.status}: ${errBody.slice(0, 200)}`);
      return null;
    }
    return res.json();
  } catch (err) {
    console.error(`[Claude] fetch failed: ${err.message}`);
    return null;
  }
}

async function executeDecision(decision, contactId, conversationId, stageMap, cardId, pipelineId) {
  if (!decision) return { action: 'no_decision' };

  const toolUse = decision.content?.find(c => c.type === 'tool_use');
  if (!toolUse) return { action: 'no_tool' };

  const { name, input } = toolUse;
  const log = { action: name, input };

  if (name === 'send_message') {
    const r = await sendWAMessage(contactId, input.text);
    log.sent = r?.success === true;
    console.log(`[send_message] contact=${contactId} sent=${log.sent}`);
  }

  if (name === 'move_stage') {
    const sid = stageMap[input.stage_name];
    if (sid) {
      const r = await moveStage(contactId, sid, cardId, pipelineId);
      log.stage_id = sid;
      log.stage_moved = !!r;
    } else {
      console.warn(`[move_stage] unknown stage_name="${input.stage_name}"`);
      log.stage_id = null;
    }
  }

  if (name === 'send_and_move') {
    const r = await sendWAMessage(contactId, input.text);
    log.sent = r?.success === true;
    const sid = stageMap[input.stage_name];
    if (sid) {
      const r2 = await moveStage(contactId, sid, cardId, pipelineId);
      log.stage_id = sid;
      log.stage_moved = !!r2;
    } else {
      console.warn(`[send_and_move] unknown stage_name="${input.stage_name}"`);
    }
    console.log(`[send_and_move] contact=${contactId} sent=${log.sent} stage_id=${log.stage_id}`);
  }

  if (name === 'escalate_human') {
    console.warn(`[ESCALATE] Contact: ${contactId} | Reason: ${input.reason}`);
  }

  return log;
}

// ══════════════════════════════════════════
// MOTOR #1 — JUSTIN · HOLBROOK · LITEBEAM
// Pipeline 216977 | $8.64 CPR
// ══════════════════════════════════════════

const STAGES_216977 = {
  'NUEVO': 1, 'BOT ACTIVO': 2, 'COTIZADO': 3, 'CTA VISITA': 4,
  'INT2 · CATÁLOGO': 5, 'PRECIO ENTREGADO': 6, 'RUTA MÉDICA': 7,
  'INT3 · PROMO ACTIVA': 8, 'UBICACIÓN ENVIADA': 9, 'MÉTODO DE PAGO': 10,
  'FUERA DE CATÁLOGO': 11, 'VISITA CONFIRMADA': 12, 'CATCH-ALL': 13,
  'RUTA COMERCIAL': 14, 'INT2 · RE-ENTRADA': 15, 'NT3 · COMPARATIVA': 16,
  'VENTA CONFIRMADA': 17, 'LEAD PERDIDO': 18, 'CLIENTE GANADO': 19,
};

const PROMPT_M1 = `Eres GIOBOT, el asistente de ventas de GioLens Vision Care — óptica en Tijuana, México.

PRODUCTO: Armazones de seguridad industrial y lentes ópticos premium — líneas Justin y Holbrook.
PRECIO: $2,200 – $4,950 MXN (incluye armazón, graduación y tratamientos básicos).
DIFERENCIADOR: Examen de vista GRATIS + asesoría personalizada en tienda + garantía.
TIENDA: GioLens Vision Care, Tijuana B.C. Tel/WA: el lead ya está en este chat.
HORARIO: Lunes a Sábado 10am – 5pm (última cita 4:30pm). Domingo cerrado.
DIRECCIÓN: Proporcionar cuando el lead pregunte (usar la dirección real de la tienda).

TU OBJETIVO: Llevar al lead a una visita presencial o a cerrar venta. Cada lead costó $8.64 MXN en publicidad — tratar cada conversación como valiosa.

REGLAS DE CONVERSACIÓN:
1. Máximo 2-3 oraciones por respuesta. No párrafos largos.
2. Si el lead pregunta precio → da el rango + menciona que incluye examen gratis.
3. Si el lead menciona síntoma visual (visión borrosa, cansancio, etc.) → ofrece examen gratis.
4. Si el lead lleva tiempo en COTIZADO sin respuesta → usa preguntas de opciones cerradas:
   "¿Te viene mejor hoy en la tarde o mañana en la mañana para tu examen de vista?"
5. Si el lead pide ubicación o cómo llegar → muévelo a UBICACIÓN y da dirección + Maps.
6. Si el lead confirma que va a venir → muévelo a VISITA CONFIRMADA + confirma horario.
7. Si el lead pregunta método de pago → muévelo a METODO PAGO + da opciones (efectivo, tarjeta, transferencia).
8. Si el lead está molesto o pide hablar con persona → usa escalate_human.
9. Responde SIEMPRE en español. Tono amigable pero profesional.

ETAPAS DISPONIBLES para move_stage (escribir EXACTO):
NUEVO, BOT ACTIVO, COTIZADO, CTA VISITA, INT2 · CATÁLOGO, PRECIO ENTREGADO,
RUTA MÉDICA, INT3 · PROMO ACTIVA, UBICACIÓN ENVIADA, MÉTODO DE PAGO,
FUERA DE CATÁLOGO, VISITA CONFIRMADA, CATCH-ALL, RUTA COMERCIAL,
INT2 · RE-ENTRADA, NT3 · COMPARATIVA, VENTA CONFIRMADA, LEAD PERDIDO, CLIENTE GANADO

NOTAS:
- "NT3 · COMPARATIVA" tiene typo en el CRM (falta la I de INT3) — usar así.
- Los puntos medios "·" son carácter U+00B7, no asterisco ni guión.
- "RUTA MÉDICA" usa journey médico, "RUTA COMERCIAL" usa journey de precio/visita.
- Etapas terminales: VISITA CONFIRMADA, VENTA CONFIRMADA, CLIENTE GANADO, LEAD PERDIDO, FUERA DE CATÁLOGO, CATCH-ALL.`;

async function motorJustinHolbrook(payload) {
  const ids = extractIds(payload);
  const { contact_id, conversation_id, stage, event } = ids;

  // Wapify no expone endpoint REST de historial. Usamos el last_message del payload
  // como mensaje único del lead — al menos Claude ve lo que disparó este webhook.
  const history = ids.last_message
    ? [{ body: ids.last_message, from_me: false }]
    : [];

  const contactName = payload.data?.contact?.first_name || payload.user?.first_name || 'Lead';
  const fallbackContext = history.length === 0
    ? `[Sistema] Evento: ${event}. Lead: ${contactName}. Etapa actual: ${stage || 'NUEVO'}. ` +
      `Este lead acaba de entrar o moverse en el CRM — no hay historial de conversación aún. ` +
      `Decide qué acción tomar basándote en la etapa.`
    : null;

  const decision = await callClaude(PROMPT_M1, history, fallbackContext);
  return executeDecision(decision, contact_id, conversation_id, STAGES_216977, ids.card_id, '216977');
}

// ══════════════════════════════════════════
// MOTOR #2 — GIOSPORTS · DEPORTIVO
// Pipeline 755062 | $10.29 CPR
// ══════════════════════════════════════════

const STAGES_755062 = {
  'NUEVO': 1, 'BOT ACTIVO': 2, 'CTA VISITA': 3, 'COTIZADO': 4,
  'INT2 · CATÁLOGO': 5, 'PRECIO ENTREGADO': 6, 'METODO PAGO': 7,
  'RUTA MÉDICA': 8, 'UBICACIÓN ENVIADA': 9, 'INT3 · PROMO ACTIVA': 10,
  'FUERA DE CATÁLOGO': 11, 'VISITA CONFIRMADA': 12, 'CATCH-ALL': 13,
  'RUTA COMERCIAL': 14, 'INT2 · RE-ENTRADA': 15, 'NT3 · COMPARATIVA': 16,
  'VENTA CONFIRMADA': 17, 'LEAD PERDIDO': 18, 'CLIENTE GANADO': 19,
};

const PROMPT_M2 = `Eres GIOBOT, el asistente de ventas de GioLens Vision Care — óptica en Tijuana, México.

PRODUCTO: Lentes deportivos GioSports — para ciclismo, béisbol, running, montaña, trabajo al aire libre.
INSIGHT CRÍTICO (basado en 1,798 conversaciones reales):
- El 53.9% de los leads NO necesitan prescripción — buscan lente solar/funcional para deporte.
- El 33.6% SÍ tienen graduación y quieren deporte + corrección visual (RecSpecs).
- NUNCA preguntar "¿tienes problema visual?" o "¿necesitas examen de vista?" como primer paso.
- La primera pregunta SIEMPRE es: ¿Para qué deporte o actividad los buscas?

PRECIOS REALES (confirmar con tienda si cambian):
- Sin graduación (solar protección deportiva): desde $1,950 MXN
- Con filtro UV avanzado + antirreflejante: $2,950 MXN
- Con graduación incluida (RecSpecs): desde $3,950 MXN
- Con mica fotocromática o progresivo: desde $4,450 MXN

MODELOS CLAVE: GioSports (solar base), RecSpecs (con graduación), Oakley Holbrook (premium)

TIENDA: Plaza MAC, Zona Río · Blvd. Rodolfo Sánchez Taboada #16004, Local 10 · Lun-Sáb 10am-5pm
COMPRA ONLINE: opticagiolens.com/products/giosports (para leads fuera de Tijuana)

SCRIPTS POR ETAPA:
ETAPA 1 — Bienvenida:
"Hola [Nombre] 👋 Vi que te interesaron nuestros lentes deportivos — buena elección 💪
Cuéntame rapidito: ¿Para qué deporte o actividad los buscas? (ciclismo, béisbol, correr, montaña...)
Con eso te digo exactamente qué modelo te va mejor y el precio 👌"

ETAPA 2 — Cotización (sin fricción médica):
"Perfecto, para [deporte] te van muy bien los GioSports 🎯
• Sin graduación (solar protección): desde $1,950 MXN ✅
• Con filtro UV avanzado: $2,950 MXN
• Con tu graduación incluida (RecSpecs): desde $3,950 MXN
¿Tienes graduación o buscas el solar base? (no necesitas receta para los solares 😉)"

ETAPA 3 — Cierre presencial:
"Va, te esperamos cuando quieras 🏃 📍 Plaza MAC, Zona Río, Local 10 · Lun-Sáb 10am-5pm
Cuando llegues dices que vienes por los GioSports para [deporte] 👌 ¿Algún día esta semana te funciona?"

ETAPA 3B — Cierre online (lead foráneo):
"Para envío nacional: 📦 opticagiolens.com/products/giosports (envío gratis a todo México)
¿Tienes graduación o buscas el solar base? Con eso te confirmo el link exacto ✅"

REGLAS:
1. Máximo 2-3 oraciones en respuestas libres. Usar el script de la etapa cuando aplique.
2. NUNCA preguntar sobre examen de vista o graduación ANTES de saber el deporte.
3. Asumir que el lead NO necesita prescripción hasta que él mismo lo diga.
4. Si menciona que SÍ tiene graduación → ofrecer RecSpecs o examen gratis.
5. Si pide ubicación → dar dirección completa de Plaza MAC.
6. Si confirma visita → mover a "visita confirmada".
7. Si está molesto o pide persona → usar escalate_human.
8. Responde SIEMPRE en español.

ETAPAS DISPONIBLES para move_stage (escribir EXACTO):
NUEVO, BOT ACTIVO, CTA VISITA, COTIZADO, INT2 · CATÁLOGO, PRECIO ENTREGADO,
METODO PAGO, RUTA MÉDICA, UBICACIÓN ENVIADA, INT3 · PROMO ACTIVA,
FUERA DE CATÁLOGO, VISITA CONFIRMADA, CATCH-ALL, RUTA COMERCIAL,
INT2 · RE-ENTRADA, NT3 · COMPARATIVA, VENTA CONFIRMADA, LEAD PERDIDO, CLIENTE GANADO

NOTAS:
- "NT3 · COMPARATIVA" tiene typo en el CRM (falta la I de INT3) — usar así.
- Etapa "METODO PAGO" sin tilde y sin "DE" en este pipeline (a diferencia de Holbrook).
- Para GioSports el journey médico aplica solo si el lead pregunta por graduación.`;

async function motorGioSports(payload) {
  const ids = extractIds(payload);
  const { contact_id, stage, event } = ids;
  // Wapify no expone endpoint REST de historial. Usamos el last_message del payload
  // como mensaje único del lead — al menos Claude ve lo que disparó este webhook.
  const history = ids.last_message
    ? [{ body: ids.last_message, from_me: false }]
    : [];
  const contactName = payload.data?.contact?.first_name || payload.user?.first_name || 'Lead';
  const fallbackContext = history.length === 0
    ? `[Sistema] Evento: ${event}. Lead: ${contactName}. Etapa: ${stage || 'NUEVO'}. Lead de lentes deportivos — sin historial aún. Decide acción.`
    : null;
  const decision = await callClaude(PROMPT_M2, history, fallbackContext);
  return executeDecision(decision, contact_id, ids.conversation_id, STAGES_755062, ids.card_id, '755062');
}

// ══════════════════════════════════════════
// MOTOR #3 — SPY Z87 · SEGURIDAD INDUSTRIAL
// Pipeline 252999 | $15.20 CPR
// ══════════════════════════════════════════

// IDs verificados contra GET /api/pipelines/252999/stages — preservar typos del CRM.
const STAGES_252999 = {
  'NUEVO': 1, 'NECESIDAD DETECTADA ': 2, 'COTIZcion': 3,
  'SÍNTOMA': 4, 'metodo de pago': 5, 'fuera del flujo': 6,
  'visita confirmada': 7, 'ubicacion': 8,
};

const PROMPT_M3 = `Eres GIOBOT, el asistente de ventas de GioLens Vision Care — óptica en Tijuana, México.

PRODUCTO: Lentes de seguridad industrial SPY Z87 — certificados ANSI Z87.1 para trabajo y protección ocular.
CPR: $15.20 MXN — lead de alto valor. Muchos son pedidos de empresa/volumen.

INSIGHT CRÍTICO (basado en conversaciones reales de este pipeline):
- El 80.9% de los leads quieren COMPRA ONLINE — dar URL en el 2do mensaje, no esperar.
- El B2B es fuerte: preguntar siempre si es para empresa o personal.
- ANSI Z87.1 es el diferenciador #1 — mencionarlo desde el inicio.
- Muchos leads ya tienen prescripción — ofrecer enviar archivo de graduación.

PRECIOS REALES:
- Base sin graduación (protección industrial): $2,999 MXN
- Con visión sencilla (el más vendido): $3,950 MXN
- Con mica fotocromática: $4,950 MXN
- Progresivo / bifocal premium: $5,950 – $9,950 MXN

TIENDA: Plaza MAC, Zona Río · Blvd. Rodolfo Sánchez Taboada #16004, Local 10 · Lun-Sáb 10am-5pm
COMPRA ONLINE: opticagiolens.com/products/spy-z87-ansi-estandar-negro

SCRIPTS POR ETAPA:
ETAPA 1 — Bienvenida + cualificación inmediata:
"Hola [Nombre] 👷 Gracias por tu interés en los SPY Z87 — son certificados ANSI Z87.1, los mejores para protección laboral.
¿Los necesitas con graduación o sin graduación? Y ¿es para uso personal o tienes un equipo de trabajo?
Con eso te doy precio exacto y el link directo 👌"

ETAPA 2 — Cotización + URL inmediata:
"Perfecto. Para [uso/graduación] el precio es $[X] MXN. 📦 Puedes verlos aquí: opticagiolens.com/products/spy-z87-ansi-estandar-negro (enviamos a todo México)
¿Tienes tu graduación a la mano o te hacemos examen de vista gratis en tienda? 👓"

ETAPA B2B — Pedido empresa:
"Para pedidos de empresa manejamos cotización especial con factura y descuento por volumen 🏭
¿Cuántos lentes necesitarían aproximadamente? Con eso te preparo una cotización formal."

MANEJO DE OBJECIÓN — Tiene graduación:
"No hay problema — puedes mandarme el archivo de tu receta o pasar a tienda para examen gratis.
Una vez que tengamos la graduación, enviamos en 3-5 días hábiles a donde estés 📦"

REGLAS:
1. Máximo 2-3 oraciones por respuesta. Usar scripts cuando aplique.
2. DAR EL LINK ONLINE en el 2do mensaje (no esperar a que lo pidan).
3. Si menciona empresa → activar modo B2B, preguntar volumen.
4. Si tiene graduación → ofrecer enviar archivo de receta o examen gratis.
5. Si pide ubicación → dar dirección Plaza MAC + mover a ubicacion.
6. Si confirma visita o compra → mover a visita confirmada.
7. Si pregunta pago → mover a metodo de pago (factura disponible para empresas).
8. Si está molesto o pide persona → usar escalate_human.
9. Responder SIEMPRE en español.

ETAPAS: NUEVO, NECESIDAD DETECTADA , COTIZcion, SÍNTOMA, metodo de pago, fuera del flujo, visita confirmada, ubicacion
NOTA: "NECESIDAD DETECTADA " tiene espacio al final. "COTIZcion" es error tipográfico en CRM — usar exactamente así.`;

async function motorSpyZ87(payload) {
  const ids = extractIds(payload);
  const { contact_id, stage, event } = ids;
  // Wapify no expone endpoint REST de historial. Usamos el last_message del payload
  // como mensaje único del lead — al menos Claude ve lo que disparó este webhook.
  const history = ids.last_message
    ? [{ body: ids.last_message, from_me: false }]
    : [];
  const contactName = payload.data?.contact?.first_name || payload.user?.first_name || 'Lead';
  const fallbackContext = history.length === 0
    ? `[Sistema] Evento: ${event}. Lead: ${contactName}. Etapa: ${stage || 'NUEVO'}. Lead de lentes de seguridad industrial — sin historial aún. Decide acción.`
    : null;
  const decision = await callClaude(PROMPT_M3, history, fallbackContext);
  return executeDecision(decision, contact_id, ids.conversation_id, STAGES_252999, ids.card_id, '252999');
}

// ══════════════════════════════════════════
// MOTOR #4 — DAMA · LUXURY
// Pipeline 94103 | $23.53 CPR
// ══════════════════════════════════════════

const STAGES_94103 = {
  'NUEVO': 1, 'COTIZADO': 2, 'BOT ACTIVO': 3, 'CTA VISITA': 4,
  'INT2 · CATÁLOGO': 5, 'PRECIO ENTREGADO': 6, 'RUTA MÉDICA': 7,
  'UBICACIÓN ENVIADA': 8, 'CATCH-ALL': 9, 'INT3 · PROMO ACTIVA': 10,
  'MÉTODO DE PAGO': 11, 'FUERA DE CATÁLOGO': 12, 'VISITA CONFIRMADA': 13,
  'RUTA COMERCIAL': 14, 'INT2 · RE-ENTRADA': 15, 'NT3 · COMPARATIVA': 16,
  'VENTA CONFIRMADA': 17, 'LEAD PERDIDO': 18, 'CLIENTE GANADO': 19,
};

const PROMPT_M4 = `Eres GIOBOT, el asistente de ventas de GioLens Vision Care — óptica en Tijuana, México.

PRODUCTO: Armazones de diseñador para mujer — línea Dama Luxury con marcas premium europeas y americanas.
CPR: $23.53 MXN — lead de alto valor. Experiencia VIP, sin presión, enfoque en imagen y estilo.

INSIGHT CRÍTICO (basado en conversaciones reales de este pipeline):
- MARCA #1 solicitada: Michael Kors (103 menciones). Siempre preguntar si ya tiene una marca en mente.
- El 26.6% objeta el precio — NO bajar precio, SÍ reforzar el valor (exclusividad, examen, asesoría de imagen).
- El enfoque correcto es CONSULTORÍA DE IMAGEN, no venta directa de lentes.
- Leads femeninos responden mejor a "¿qué estilo buscas?" que a "¿cuánto quieres gastar?".

PRECIOS REALES:
- Armazón diseñador + graduación básica: $3,500 MXN
- Con mica antirreflejante + UV premium: $4,500 MXN
- Con progresivo o lente de alta definición: $5,500 – $6,500 MXN
- (Mencionar que incluye examen de vista gratis)

MARCAS DISPONIBLES: Michael Kors, Versace, Prada, Kate Spade, Coach, Ralph Lauren, entre otras.
TIENDA: Plaza MAC, Zona Río · Blvd. Rodolfo Sánchez Taboada #16004, Local 10 · Lun-Sáb 10am-5pm

SCRIPTS POR ETAPA:
ETAPA 1 — Bienvenida + consultoría de imagen:
"Hola [Nombre], qué gusto tenerte aquí ✨ Tenemos una colección preciosa de armazones de diseñador para mujer.
¿Ya tienes una marca favorita en mente? (Michael Kors, Versace, Prada...) ¿O prefieres que te orientemos según tu estilo?"

ETAPA 2 — Cotización con valor:
"Los armazones [marca] están desde $3,500 MXN incluyendo tu graduación y examen de vista gratis 🎁
Es una experiencia completa — te asesoramos en imagen y te ayudamos a encontrar el armazón que más te favorezca.
¿Tienes disponibilidad para pasar a la tienda esta semana?"

MANEJO DE OBJECIÓN DE PRECIO:
"Entiendo perfectamente. Lo que incluye es examen de vista gratis + armazón de diseñador original + asesoría de imagen personalizada + garantía.
Son lentes que duras usando 2-3 años con estilo. ¿Te cuento qué opciones hay en tu rango de presupuesto?"

ETAPA DE CIERRE:
"Te esperamos con mucho gusto. 📍 Plaza MAC, Zona Río, Local 10 · Lunes a Sábado 10am-5pm
Cuando llegues, pides la colección Dama y te atendemos de inmediato. ¿Algún día esta semana te queda bien?"

REGLAS:
1. Máximo 2-3 oraciones. Tono elegante, cálido, de consultora de moda. Sin presión.
2. Preguntar SIEMPRE por marca o estilo antes de hablar de precio.
3. Si objeta precio → NUNCA bajar precio, SÍ reforzar valor (examen gratis, marca original, asesoría).
4. Si menciona marca → mostrar que la tenemos y describir brevemente.
5. Si menciona síntoma visual → ofrecer "evaluación de vista completa gratuita".
6. Si confirma visita → mover a VISITA CONFIRMADA.
7. Si pregunta pago → mover a METODO PAGO (mencionar meses sin intereses si aplica).
8. Si está molesta o pide persona → usar escalate_human.
9. Responder SIEMPRE en español. Emojis mínimos y elegantes.

ETAPAS DISPONIBLES para move_stage (escribir EXACTO):
NUEVO, COTIZADO, BOT ACTIVO, CTA VISITA, INT2 · CATÁLOGO, PRECIO ENTREGADO,
RUTA MÉDICA, UBICACIÓN ENVIADA, CATCH-ALL, INT3 · PROMO ACTIVA, MÉTODO DE PAGO,
FUERA DE CATÁLOGO, VISITA CONFIRMADA, RUTA COMERCIAL, INT2 · RE-ENTRADA,
NT3 · COMPARATIVA, VENTA CONFIRMADA, LEAD PERDIDO, CLIENTE GANADO

NOTAS:
- Para Dama Luxury, "RUTA COMERCIAL" es la principal — la asesoría de imagen está en esa ruta.
- "RUTA MÉDICA" solo si la lead pide examen de vista explícitamente.
- "NT3 · COMPARATIVA" tiene typo en el CRM (falta la I) — usar así.`;

async function motorDamaLuxury(payload) {
  const ids = extractIds(payload);
  const { contact_id, stage, event } = ids;
  // Wapify no expone endpoint REST de historial. Usamos el last_message del payload
  // como mensaje único del lead — al menos Claude ve lo que disparó este webhook.
  const history = ids.last_message
    ? [{ body: ids.last_message, from_me: false }]
    : [];
  const contactName = payload.data?.contact?.first_name || payload.user?.first_name || 'Lead';
  const fallbackContext = history.length === 0
    ? `[Sistema] Evento: ${event}. Lead: ${contactName}. Etapa: ${stage || 'NUEVO'}. Lead de armazones premium Dama — sin historial aún. Decide acción con tono elegante.`
    : null;
  const decision = await callClaude(PROMPT_M4, history, fallbackContext);
  return executeDecision(decision, contact_id, ids.conversation_id, STAGES_94103, ids.card_id, '94103');
}

// ══════════════════════════════════════════
// MOTOR #5 — GIOVISION · ENTINTADOS
// Pipeline 273944 | $27.78 CPR
// ══════════════════════════════════════════

// IDs verificados contra GET /api/pipelines/273944/stages.
// Pipeline propio (NO usa journey 3-interacciones) — preservar nombres tal cual.
const STAGES_273944 = {
  'NUEVO': 1, 'PRECIO': 2, 'SÍNTOMA': 3, 'UBICACIÓN': 4,
  'CATÁLOGO RETARGETING reactivacion': 5, 'PROMOCIÓN': 6,
  'METODO PAGO': 7, 'FUERA DE CATÁLOGO': 8,
  'VISITA CONFIRMADA': 9, 'CATCH-ALL': 10,
};

const PROMPT_M5 = `Eres GIOBOT, el asistente de ventas de GioLens Vision Care — óptica en Tijuana, México.

PRODUCTO: Lentes entintados y fotocromáticos — línea GioVision para uso diario, exterior y transición sol/sombra.
CPR: $27.78 MXN — lead de mayor costo, máxima atención y seguimiento inmediato.

INSIGHT CRÍTICO (basado en conversaciones reales de este pipeline):
- El GANCHO principal que convierte es la PROMO $950: armazón + micas sencillas entintadas. Mencionarlo de entrada.
- El 61.4% duda de la CALIDAD del armazón incluido en la promo — aclarar PRO-ACTIVAMENTE que son armazones de calidad.
- Confusión frecuente entre "entintado" y "fotocromático" — explicar la diferencia brevemente si hay duda.
- Leads que preguntan por "lentes de sol con graduación" son leads calientes — cerrar rápido.

PRECIOS REALES:
- PROMO ENTRADA: Armazón + micas sencillas entintadas: $950 MXN ⭐ (el gancho principal)
- Entintado degradado o un tono: $2,800 MXN
- Fotocromático (transición automática): $3,500 MXN
- Progresivo fotocromático premium: $5,200 MXN

DIFERENCIA ENTINTADO vs FOTOCROMÁTICO:
- Entintado: color fijo siempre (estético, perfecto para exteriores habituales)
- Fotocromático: cambia solo de claro a oscuro según la luz (ideal para manejar, interior/exterior)

TIENDA: Plaza MAC, Zona Río · Blvd. Rodolfo Sánchez Taboada #16004, Local 10 · Lun-Sáb 10am-5pm

SCRIPTS POR ETAPA:
ETAPA 1 — Bienvenida con gancho de promo:
"Hola [Nombre] 👋 Tenemos una promo especial: armazón + micas entintadas desde $950 MXN 🔥
Incluye armazones de calidad con varios estilos para elegir y mica con protección UV.
¿Buscas lentes entintados (color fijo) o fotocromáticos (que cambian solos)?"

ETAPA 2 — Aclarar calidad del armazón (si hay duda):
"Los armazones de la promo son de muy buena calidad — trabajamos con proveedores nacionales e importados.
Cuando vengas a tienda puedes ver y probar los modelos disponibles 😊
¿Tienes disponibilidad esta semana?"

ETAPA 2B — Explicar diferencia entintado/fotocromático:
"Te explico rápido: el entintado tiene color fijo siempre (más estético), el fotocromático cambia de claro a oscuro según la luz (muy práctico para manejar o estar en interior y exterior).
¿Cuál se adapta mejor a cómo los vas a usar?"

ETAPA 3 — Cierre:
"Perfecto, te esperamos 📍 Plaza MAC, Zona Río, Local 10 · Lun-Sáb 10am-5pm
Examen de vista gratis incluido si lo necesitas. ¿Qué día de esta semana te queda mejor?"

REACTIVACIÓN (lead en CATÁLOGO RETARGETING):
"Hola [Nombre] 👋 ¿Sigues buscando tus lentes? Seguimos teniendo la promo de $950 disponible 🔥
¿Te surge alguna duda que pueda resolver?"

REGLAS:
1. Máximo 2-3 oraciones. Tono moderno, lifestyle, amigable.
2. MENCIONAR LA PROMO $950 en el primer mensaje — es el diferenciador que convierte.
3. Si duda de la calidad del armazón → aclarar proactivamente (buena calidad, pueden verlo en tienda).
4. Si pregunta diferencia entintado/fotocromático → explicar en 1-2 líneas usando el script.
5. Si menciona uso al volante → recomendar fotocromático directamente.
6. Si menciona síntoma visual → ofrecer examen gratis.
7. Si pide ubicación → mover a UBICACIÓN + dar dirección.
8. Si confirma visita → mover a VISITA CONFIRMADA.
9. Si pregunta pago → mover a METODO PAGO.
10. Si está en retargeting → usar script de reactivación.
11. Si está molesto o pide persona → usar escalate_human.
12. Responder SIEMPRE en español.

ETAPAS: NUEVO, PRECIO, SÍNTOMA, UBICACIÓN, CATÁLOGO RETARGETING reactivacion, PROMOCIÓN, METODO PAGO, FUERA DE CATÁLOGO, VISITA CONFIRMADA, CATCH-ALL`;

async function motorGioVision(payload) {
  const ids = extractIds(payload);
  const { contact_id, stage, event } = ids;
  // Wapify no expone endpoint REST de historial. Usamos el last_message del payload
  // como mensaje único del lead — al menos Claude ve lo que disparó este webhook.
  const history = ids.last_message
    ? [{ body: ids.last_message, from_me: false }]
    : [];
  const contactName = payload.data?.contact?.first_name || payload.user?.first_name || 'Lead';
  const fallbackContext = history.length === 0
    ? `[Sistema] Evento: ${event}. Lead: ${contactName}. Etapa: ${stage || 'NUEVO'}. Lead de lentes entintados/fotocromaticos — sin historial aún. Decide acción.`
    : null;
  const decision = await callClaude(PROMPT_M5, history, fallbackContext);
  return executeDecision(decision, contact_id, ids.conversation_id, STAGES_273944, ids.card_id, '273944');
}

// ─── PAYLOAD PARSER ───
function extractIds(payload) {
  const p = payload;
  const u = p.user || {};
  const d = p.data || p.payload || p.card || p.opportunity || {};
  const pipeline_obj = d.pipeline || {};
  const stage_obj    = d.stage    || {};

  const pipeline_id = String(
    pipeline_obj.id   ||
    d.pipeline_id     || d.board_id || d.boardId ||
    p.pipeline_id     || p.board_id ||
    u.pipeline_id     || ''
  );

  const contact_id = String(
    d.contact_id      ||
    u.id              ||
    p.contact_id      || p.id     || ''
  );

  const conversation_id = contact_id;

  const stage_name = stage_obj.name ||
    p.stage || d.stage_name || '';

  return {
    contact_id,
    conversation_id,
    pipeline_id,
    stage:        stage_name,
    stage_id:     stage_obj.id || '',
    event:        p.event || p.type || 'unknown',
    last_message: p.message || d.message || u.last_message || '',
    card_id:      d.id || '',
  };
}

// ─── WEBHOOK HANDLER (Wapify reactivo · POST de eventos) ───
async function handleWapifyWebhook(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok',
      service: 'GioLens 5 Motores — Claude Engine',
      motors: { '216977': 'Justin/Holbrook ✅', '755062': 'GioSports ✅', '252999': 'SPY Z87 ✅', '94103': 'Dama ✅', '273944': 'GioVision ✅' },
      cron_endpoint: '?mode=cron · reactivation check fusionado (sustituye /api/reactivation-check)',
      timestamp: new Date().toISOString(),
    });
  }

  if (req.method !== 'POST') return res.status(405).end();

  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'invalid JSON' });
  }

  // ── RAW LOG — captura el schema completo de cada evento Wapify ──
  console.log('WEBHOOK_RAW:', JSON.stringify(payload));

  // Log each field individually to bypass log truncation
  console.log('[WEBHOOK] KEYS:', Object.keys(payload).join(' | '));
  for (const [k, v] of Object.entries(payload)) {
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    console.log(`[WH:${k}]`, val.slice(0, 300));
  }
  // [SEGURIDAD] Canal ntfy.sh público desactivado — usaba topic sin autenticación
  // y exponía datos de leads (nombres, etapas, contact IDs) a cualquier usuario.
  // Para debug usar los logs de Vercel: vercel logs giolens-dashboard.vercel.app

  const { pipeline_id, event, contact_id } = extractIds(payload);
  console.log(`[WEBHOOK] pipeline=${pipeline_id} event=${event} contact=${contact_id}`);

  if (!ANTHROPIC_KEY) {
    console.error('[WEBHOOK] ANTHROPIC_API_KEY no configurada');
    return res.status(500).json({ error: 'missing API key' });
  }

  const motor = MOTOR_MAP[pipeline_id];
  if (!motor) {
    console.log(`[WEBHOOK] Sin motor para pipeline ${pipeline_id} — ignorando`);
    return res.status(200).json({ received: true, action: 'ignored', pipeline: pipeline_id });
  }

  try {
    const result = await motor(payload);
    console.log(`[WEBHOOK] Motor [${pipeline_id}] completó:`, JSON.stringify(result));
    return res.status(200).json({ received: true, ts: Date.now(), result });
  } catch (err) {
    console.error('[WEBHOOK] Error en motor:', err.message, err.stack?.slice(0, 300));
    return res.status(200).json({ received: true, error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// REACTIVATION CRON · fusionado de api/reactivation-check.js (18 may Frente B)
// ═══════════════════════════════════════════════════════════════════════════
// Plan de fusión: scripts/PLAN-fusion-reactivation-webhook.md
// Trigger: Vercel Cron via ?mode=cron (declarado en vercel.json) o header
// X-Vercel-Cron (header automático de cron jobs).
//
// LÓGICA (preservada de reactivation-check.js):
//   1. updated_at < 15 min (pre-filtro barato)
//   2. La etapa NO es terminal
//   3. Bot ya respondió (last_sent > last_interaction)
//   4. Silencio entre 4 y 12 minutos
//
// SEGURIDAD: REACTIVATION_DRY_RUN=true por default (regla §22 NUNCA cambiar
// sin Isaac). MAX_SENDS_PER_RUN=5 cap duro de envíos por ejecución.

const REACTIVATION_TERMINAL_STAGES = new Set([
  'VISITA CONFIRMADA', 'visita confirmada',
  'FUERA DE CATÁLOGO', 'fuera del flujo', 'FUERA DEL FLUJO',
  'CATCH-ALL',
]);
const REACTIVATION_PIPELINES = ['216977', '755062', '252999', '94103', '273944'];
const REACTIVATION_MIN_SILENCE_MS       =  4 * 60 * 1000;
const REACTIVATION_MAX_SILENCE_MS       = 12 * 60 * 1000;
const REACTIVATION_OPPORTUNITY_WINDOW_MS = 15 * 60 * 1000;
const REACTIVATION_MAX_SENDS_PER_RUN    = 5;
const REACTIVATION_DRY_RUN = process.env.REACTIVATION_DRY_RUN !== 'false';

/**
 * Parsea "2026-05-11 17:28:28" de Wapify a Unix ms.
 * Wapify devuelve wallclock CST sin timezone marker.
 * R-07 mitigación: -06:00 produce Unix ms inherente UTC; frontend convierte
 * a CST con toLocaleString('es-MX'). NO cambiar a 'Z'.
 */
function parseWapifyDate(str) {
  if (!str) return 0;
  return new Date(str.replace(' ', 'T') + '-06:00').getTime();
}

async function getRecentLeads(pipelineId, windowMs) {
  const cutoff = Date.now() - windowMs;
  const recent = [];
  let offset = 0;

  for (let page = 0; page < 20; page++) {
    const r = await wapFetch(`pipelines/${pipelineId}/opportunities?limit=100&offset=${offset}`);
    const batch = r?.data || [];
    if (batch.length === 0) break;

    for (const opp of batch) {
      const updatedMs = parseWapifyDate(opp.updated_at);
      if (updatedMs >= cutoff && !REACTIVATION_TERMINAL_STAGES.has(opp.stage?.name)) {
        recent.push(opp);
      }
    }

    const lastUpdated = parseWapifyDate(batch[batch.length - 1]?.updated_at);
    if (lastUpdated < cutoff) break;

    if (batch.length < 100) break;
    offset += 100;
  }

  return recent;
}

async function needsReactivation(contactId) {
  const contact = await wapFetch(`contacts/${contactId}`);
  if (!contact) return { needs: false, reason: 'contact_fetch_failed' };

  const lastInteraction = Number(contact.last_interaction || 0);
  const lastSent        = Number(contact.last_sent        || 0);

  if (!lastInteraction) return { needs: false, reason: 'no_last_interaction' };

  const silenceMs = Date.now() - lastInteraction;
  const botAlreadyReplied = lastSent > lastInteraction;
  const inWindow = silenceMs >= REACTIVATION_MIN_SILENCE_MS && silenceMs <= REACTIVATION_MAX_SILENCE_MS;

  if (botAlreadyReplied && inWindow) {
    return {
      needs: true,
      silenceMin: Math.round(silenceMs / 60000 * 10) / 10,
      lastInteraction,
      lastSent,
      contact,
    };
  }

  return {
    needs: false,
    reason: !botAlreadyReplied ? 'lead_message_is_newest'
      : silenceMs < REACTIVATION_MIN_SILENCE_MS ? 'too_soon' : 'window_expired',
    silenceMin: Math.round(silenceMs / 60000 * 10) / 10,
  };
}

async function getCopilotoScript(pipelineId, stageName, contactId) {
  try {
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000';

    const r = await fetch(`${baseUrl}/api/copiloto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipeline_id: pipelineId, stage_name: stageName, contact_id: contactId }),
    });
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

async function sendReactivationMessage(contactId, text) {
  if (REACTIVATION_DRY_RUN) {
    console.log(`[DRY_RUN] Would send to ${contactId}: "${text.slice(0, 80)}"`);
    return { dry_run: true };
  }
  return wapFetch(`contacts/${contactId}/send`, {
    method: 'POST',
    body: JSON.stringify({ message: text, type: 'text' }),
  });
}

async function handleReactivationCron(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const startTime = Date.now();
  console.log(`[REACTIVATION] Inicio. dry_run=${REACTIVATION_DRY_RUN}`);

  const report = {
    started_at:  new Date().toISOString(),
    dry_run:     REACTIVATION_DRY_RUN,
    pipelines:   {},
    candidates:  [],
    sent:        [],
    skipped:     [],
    errors:      [],
    total_sent:  0,
  };

  let totalSent = 0;

  for (const pid of REACTIVATION_PIPELINES) {
    if (totalSent >= REACTIVATION_MAX_SENDS_PER_RUN) {
      console.log(`[REACTIVATION] Cap de ${REACTIVATION_MAX_SENDS_PER_RUN} envíos alcanzado — deteniendo`);
      break;
    }

    try {
      const recentLeads = await getRecentLeads(pid, REACTIVATION_OPPORTUNITY_WINDOW_MS);
      report.pipelines[pid] = { recent_leads: recentLeads.length };
      console.log(`[REACTIVATION] Pipeline ${pid}: ${recentLeads.length} leads recientes`);

      for (const opp of recentLeads) {
        if (totalSent >= REACTIVATION_MAX_SENDS_PER_RUN) break;

        const contactId = opp.contact_id;
        const stageName = opp.stage?.name || 'NUEVO';

        try {
          const check = await needsReactivation(contactId);

          if (!check.needs) {
            report.skipped.push({ contact_id: contactId, stage: stageName, pipeline: pid, reason: check.reason, silence_min: check.silenceMin });
            continue;
          }

          const copiloto = await getCopilotoScript(pid, stageName, contactId);
          const scriptText = copiloto?.script || copiloto?.alternativa || null;

          if (!scriptText) {
            report.errors.push({ contact_id: contactId, error: 'copiloto_no_script' });
            continue;
          }

          const contactName = check.contact?.first_name || '';
          const finalScript = contactName
            ? scriptText.replace(/\[nombre\]/gi, contactName)
            : scriptText;

          report.candidates.push({ contact_id: contactId, stage: stageName, pipeline: pid, silence_min: check.silenceMin, script_preview: finalScript.slice(0, 80) });

          const sendResult = await sendReactivationMessage(contactId, finalScript);

          report.sent.push({ contact_id: contactId, stage: stageName, pipeline: pid, silence_min: check.silenceMin, urgencia: copiloto?.urgencia || 'media', send_result: sendResult });

          totalSent++;
          console.log(`[REACTIVATION] Enviado a ${contactId} (${stageName}, ${check.silenceMin}min silencio)`);

          await new Promise(r => setTimeout(r, 500));

        } catch (err) {
          report.errors.push({ contact_id: contactId, error: err.message });
        }
      }

    } catch (err) {
      console.error(`[REACTIVATION] Error en pipeline ${pid}:`, err.message);
      report.errors.push({ pipeline: pid, error: err.message });
    }
  }

  report.total_sent  = totalSent;
  report.duration_ms = Date.now() - startTime;
  report.finished_at = new Date().toISOString();

  console.log(`[REACTIVATION] Fin. Enviados: ${totalSent}. Candidatos: ${report.candidates.length}. Tiempo: ${report.duration_ms}ms`);

  return res.status(200).json(report);
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTER PRINCIPAL · webhook reactivo vs cron proactivo
// ═══════════════════════════════════════════════════════════════════════════
// Plan F (scripts/PLAN-fusion-reactivation-webhook.md): Wapify es caller
// dominante (>1000 POST/día vs 288 cron/día) y no controla query params →
// default = webhook. Cron usa ?mode=cron (declarativo vercel.json) o el
// header automático x-vercel-cron.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Vercel-Cron');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const isCron = req.query?.mode === 'cron'
              || req.headers['x-vercel-cron'] === '1';

  if (isCron) return handleReactivationCron(req, res);
  return handleWapifyWebhook(req, res);
}

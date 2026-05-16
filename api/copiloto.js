/**
 * GioLens — Motor #5: COPILOTO SALES
 * URL: /api/copiloto
 * Uso: El VENDEDOR llama este endpoint con pipeline + etapa + contacto
 *      y recibe el script exacto a usar con ese lead en ese momento.
 *
 * NO responde al cliente. NO es un bot. Es un asistente para el vendedor.
 */

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5';

// ─── Contexto por pipeline ───
const PIPELINES = {
  '216977': {
    name: 'Justin · Holbrook · Litebeam',
    producto: 'Armazones ópticos premium — líneas Justin, Holbrook y Litebeam',
    precio: '$2,200 – $4,950 MXN (incluye armazón + graduación + tratamientos básicos)',
    cpr: '$8.64',
    diferenciadores: ['Examen de vista GRATIS en tienda', 'Asesoría personalizada', 'Garantía incluida', 'Marcas Justin / Holbrook / Litebeam'],
    etapas: ['NUEVO','BOT ACTIVO','COTIZADO','CTA VISITA','INT2 · CATÁLOGO','PRECIO ENTREGADO','RUTA MÉDICA','INT3 · PROMO ACTIVA','UBICACIÓN ENVIADA','MÉTODO DE PAGO','FUERA DE CATÁLOGO','VISITA CONFIRMADA','CATCH-ALL','RUTA COMERCIAL','INT2 · RE-ENTRADA','NT3 · COMPARATIVA','VENTA CONFIRMADA','LEAD PERDIDO','CLIENTE GANADO'],
  },
  '755062': {
    name: 'GioSports · Deportivo',
    producto: 'Lentes deportivos GioSports y RecSpecs — para deporte y uso industrial',
    precio: '$1,800 – $3,500 MXN',
    cpr: '$10.29',
    diferenciadores: ['Certificados para deporte', 'Con o sin graduación', 'Protección UV', 'Alta resistencia a impacto'],
    etapas: ['NUEVO','BOT ACTIVO','CTA VISITA','COTIZADO','INT2 · CATÁLOGO','PRECIO ENTREGADO','METODO PAGO','RUTA MÉDICA','UBICACIÓN ENVIADA','INT3 · PROMO ACTIVA','FUERA DE CATÁLOGO','VISITA CONFIRMADA','CATCH-ALL','RUTA COMERCIAL','INT2 · RE-ENTRADA','NT3 · COMPARATIVA','VENTA CONFIRMADA','LEAD PERDIDO','CLIENTE GANADO'],
  },
  '252999': {
    name: 'SPY · Seguridad Z87',
    producto: 'Lentes de seguridad industrial SPY — certificación ANSI Z87.1',
    precio: 'Desde $2,999 MXN base sin graduación · $3,950 visión sencilla · $4,950 fotocromática · $5,950–$9,950 progresivo/bifocal (descuento por volumen empresas)',
    cpr: '$15.20',
    diferenciadores: ['Certificación ANSI Z87.1', 'Con y sin graduación', 'Cotización por volumen', 'Entrega rápida Tijuana'],
    etapas: ['NUEVO','NECESIDAD DETECTADA','COTIZcion','SÍNTOMA','metodo de pago','fuera del flujo','visita confirmada','ubicacion'],
  },
  '94103': {
    name: 'Dama · Luxury',
    producto: 'Armazones premium para mujer — línea Dama Luxury',
    precio: '$3,500 – $8,000 MXN',
    cpr: '$23.53',
    diferenciadores: ['Diseños exclusivos para mujer', 'Marcas de lujo', 'Asesoría de imagen personalizada', 'Colección limitada'],
    etapas: ['NUEVO','COTIZADO','BOT ACTIVO','CTA VISITA','INT2 · CATÁLOGO','PRECIO ENTREGADO','RUTA MÉDICA','UBICACIÓN ENVIADA','CATCH-ALL','INT3 · PROMO ACTIVA','MÉTODO DE PAGO','FUERA DE CATÁLOGO','VISITA CONFIRMADA','RUTA COMERCIAL','INT2 · RE-ENTRADA','NT3 · COMPARATIVA','VENTA CONFIRMADA','LEAD PERDIDO','CLIENTE GANADO'],
  },
  '273944': {
    name: 'GioVision · Entintados',
    producto: 'Lentes entintados y fotocromaticos GioVision',
    precio: '$1,500 – $4,000 MXN',
    cpr: '$27.78',
    diferenciadores: ['Transición automática sol/interior', 'Protección UV 400', 'Graduación incluida', 'Entintado personalizado'],
    etapas: ['NUEVO','PRECIO','SÍNTOMA','UBICACIÓN','CATÁLOGO RETARGETING reactivacion','PROMOCIÓN','METODO PAGO','FUERA DE CATÁLOGO','VISITA CONFIRMADA','CATCH-ALL'],
  },
};

// ─── Prompt del Copiloto ───
function buildPrompt(pipe, etapa, conversacion, contextStr, interaccion, ruta) {
  const intLabel = interaccion ? `INT ${interaccion}` : 'no especificada';
  const rutaLabel = ruta ? String(ruta).toUpperCase() : 'no asignada';
  return `Eres el COPILOTO de ventas de GioLens Vision Care (Tijuana, MX).
Tu rol: ayudar al VENDEDOR — NO respondes al cliente directamente.

PRODUCTO: ${pipe.producto}
PRECIO: ${pipe.precio}
DIFERENCIADORES: ${pipe.diferenciadores.join(' | ')}
COSTO POR LEAD (publicidad): ${pipe.cpr} MXN — cada lead es valioso.
ETAPA ACTUAL DEL LEAD: ${etapa || 'NUEVO'}
INTERACCIÓN ACTUAL: ${intLabel} (1=primer contacto, 2=continuidad/catálogo, 3=retargeting/cierre)
RUTA: ${rutaLabel} (COMERCIAL=precio/modelo/visita, MEDICA=graduación/receta/progresivo)${contextStr || ''}

CONVERSACIÓN RECIENTE:
${conversacion || 'Sin historial — lead nuevo sin mensajes previos.'}

OBJETIVO DEL VENDEDOR: Avanzar al lead hacia VISITA CONFIRMADA o cierre de venta.

INSTRUCCIONES:
- Analiza la etapa y la conversación
- Sugiere UN mensaje específico listo para copiar/pegar (máx 2-3 oraciones)
- Da la razón táctica (1 oración)
- Da 1 alternativa para lead frío
- Evalúa urgencia de contactar ahora

Responde SOLO en JSON válido, sin texto extra:
{
  "script": "mensaje listo para enviar al lead",
  "razon": "por qué este script en esta etapa",
  "alternativa": "mensaje alternativo si el lead está frío o no ha respondido",
  "urgencia": "alta|media|baja",
  "siguiente_etapa": "etapa sugerida si el lead responde positivamente"
}`;
}

// ─── Handler principal ───
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok',
      motor: 'Motor #5 — Copiloto Sales',
      descripcion: 'Recibe pipeline_id + stage_name + contact_id y devuelve el script óptimo para el vendedor',
      pipelines_disponibles: Object.entries(PIPELINES).map(([id, p]) => ({ id, nombre: p.name })),
    });
  }

  if (req.method !== 'POST') return res.status(405).end();

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'JSON inválido' }); }

  const { pipeline_id, stage_name, contact_id, conversacion, context_str, interaccion, ruta } = body;

  const pipe = PIPELINES[String(pipeline_id || '')];
  if (!pipe) {
    return res.status(400).json({
      error: `pipeline_id no reconocido: ${pipeline_id}`,
      disponibles: Object.keys(PIPELINES),
    });
  }

  // Sin auto-fetch de historial: Wapify no expone endpoint REST de conversaciones.
  // Si el caller pasa `conversacion` en el body lo usamos; si no, el prompt usa fallback.
  const conv = conversacion || null;

  // context_str viene del panel "Contexto IA" del dashboard (localStorage del usuario)
  const systemPrompt = buildPrompt(pipe, stage_name, conv, context_str || '', interaccion, ruta);

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{
          role: 'user',
          content: `Dame el script para este lead en etapa "${stage_name || 'NUEVO'}" del pipeline ${pipe.name}.`,
        }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      console.error(`[Copiloto] Claude error ${claudeRes.status}: ${errText.slice(0, 200)}`);
      return res.status(500).json({ error: `Claude error ${claudeRes.status}` });
    }

    const data = await claudeRes.json();
    const raw = data.content?.[0]?.text || '{}';

    let recomendacion;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      recomendacion = match ? JSON.parse(match[0]) : { script: raw, razon: '', alternativa: '', urgencia: 'media', siguiente_etapa: '' };
    } catch {
      recomendacion = { script: raw, razon: '', alternativa: '', urgencia: 'media', siguiente_etapa: '' };
    }

    return res.status(200).json({
      ok: true,
      pipeline: pipe.name,
      etapa: stage_name || 'NUEVO',
      contact_id: contact_id || null,
      tuvo_historial: !!conv,
      ...recomendacion,
    });

  } catch (err) {
    console.error(`[Copiloto] fetch error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
}

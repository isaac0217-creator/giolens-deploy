/**
 * GioLens — text-utils (fusión de auto-prompt + clean-message)
 * URL: /api/text-utils
 *
 * Router por ?op=
 *   ?op=clean   → strip ##ESTADO## (reemplaza /api/clean-message)
 *   ?op=prompt  → genera 3 variantes (reemplaza /api/auto-prompt)
 *
 * Comportamiento idéntico a los 2 endpoints originales. Migración:
 * actualizar callers (Wapify HTTP Actions, dashboard frontend) ANTES de
 * eliminar api/auto-prompt.js y api/clean-message.js.
 *
 * Origen: fusión hecha en Fase 1 Sprint 1 (16 may 2026) para liberar
 * slot Vercel para api/state.js (Supabase-backed kv + timeseries).
 */

import { withSentry } from '../agents/_shared/sentry.js';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5';

const PIPELINES = {
  '216977': {
    name: 'Justin · Holbrook · Litebeam',
    producto: 'Armazones ópticos premium Justin, Holbrook, Litebeam',
    precio: '$2,200 – $4,950 MXN (incluye armazón + graduación + tratamientos)',
    diferenciadores: 'Examen de vista GRATIS · Asesoría personalizada · Garantía incluida',
    publico: 'Hombres 25-45 años, Tijuana, interés en moda y óptica premium',
  },
  '755062': {
    name: 'GioSports · Deportivo',
    producto: 'Lentes deportivos GioSports y RecSpecs',
    precio: '$1,800 – $3,500 MXN',
    diferenciadores: 'Certificados para deporte · Alta resistencia · Con o sin graduación · UV400',
    publico: 'Deportistas y personas activas, Tijuana',
  },
  '252999': {
    name: 'SPY · Seguridad Z87',
    producto: 'Lentes de seguridad industrial SPY certificación ANSI Z87.1',
    precio: 'Desde $2,999 MXN base sin graduación · $3,950 visión sencilla · $4,950 fotocromática · $5,950–$9,950 progresivo/bifocal (descuento por volumen empresas)',
    diferenciadores: 'Certificación ANSI Z87.1 · Con y sin graduación · Entrega rápida Tijuana',
    publico: 'Trabajadores industriales y empresas, Tijuana',
  },
  '94103': {
    name: 'Dama · Luxury',
    producto: 'Armazones premium para mujer — línea Dama Luxury',
    precio: '$3,500 – $8,000 MXN',
    diferenciadores: 'Diseños exclusivos · Marcas de lujo · Asesoría de imagen · Colección limitada',
    publico: 'Mujeres 28-55 años, poder adquisitivo medio-alto, Tijuana',
  },
  '273944': {
    name: 'GioVision · Entintados',
    producto: 'Lentes entintados y fotocromáticos GioVision',
    precio: '$1,500 – $4,000 MXN',
    diferenciadores: 'Transición automática · UV400 · Graduación incluida · Entintado personalizado',
    publico: 'Personas que pasan tiempo al aire libre, Tijuana',
  },
};

const ANGULOS = [
  { id: 'urgencia',     label: 'Urgencia / Escasez',   descripcion: 'Crea sentido de urgencia real (promoción, disponibilidad, tiempo limitado). NO inventar — usa lo que existe.' },
  { id: 'valor',        label: 'Valor / Beneficio',    descripcion: 'Enfócate en el beneficio concreto que obtiene (ver mejor, protección, estilo). Nada de features, todo benefits.' },
  { id: 'social_proof', label: 'Prueba Social',        descripcion: 'Menciona que otros clientes en su misma situación ya compraron y están felices. Cálido, no presumido.' },
];

// ═══ op=clean ═══════════════════════════════════════════════════════════════

function handleClean(req, res) {
  const text = req.method === 'POST'
    ? req.body?.text
    : req.query?.text;

  if (!text) {
    return res.status(400).json({ error: 'Missing text param' });
  }

  // Elimina TODOS los tags ##ESTADO:...## (no solo el del final).
  // Cuando GPT genera 2 respuestas concatenadas, el tag intermedio queda visible.
  const clean = String(text)
    .replace(/\n?##ESTADO:[^#\n]+##[ \t]*/g, '')
    .trimEnd();

  return res.status(200).json({ clean });
}

// ═══ op=prompt ══════════════════════════════════════════════════════════════

function buildPrompt(pipe, etapa, contexto, contextStr, interaccion, ruta) {
  const intLabel = interaccion ? `INT ${interaccion}` : 'no especificada';
  const rutaLabel = ruta ? String(ruta).toUpperCase() : 'no asignada';
  return `Eres un experto en ventas por WhatsApp para GioLens Vision Care (óptica, Tijuana MX).

PRODUCTO: ${pipe.producto}
PRECIO: ${pipe.precio}
DIFERENCIADORES: ${pipe.diferenciadores}
PÚBLICO: ${pipe.publico}
ETAPA DEL LEAD: ${etapa}
INTERACCIÓN ACTUAL: ${intLabel} (1=primer contacto, 2=continuidad/catálogo, 3=retargeting/cierre)
RUTA: ${rutaLabel} (COMERCIAL=precio/modelo/visita, MEDICA=graduación/receta/progresivo)
${contexto ? `CONTEXTO ADICIONAL: ${contexto}` : ''}${contextStr || ''}

Genera EXACTAMENTE 3 variantes de mensaje para WhatsApp.
Cada variante usa un ángulo diferente:
1. URGENCIA — ${ANGULOS[0].descripcion}
2. VALOR — ${ANGULOS[1].descripcion}
3. PRUEBA SOCIAL — ${ANGULOS[2].descripcion}

Reglas:
- Máximo 3 oraciones por mensaje
- Tono natural, como habla un vendedor mexicano amigable (no robótico, no formal en exceso)
- NO uses emojis en exceso (máx 1 por mensaje)
- Termina con una pregunta o llamada a acción clara
- El mensaje debe sentirse continuación natural de la etapa "${etapa}"

Responde SOLO JSON válido, sin texto extra:
{
  "variantes": [
    {
      "angulo": "urgencia",
      "mensaje": "texto del mensaje listo para copiar",
      "cuando_usar": "descripción breve de cuándo es más efectivo este ángulo",
      "tono": "urgente|amigable|confianza"
    },
    {
      "angulo": "valor",
      "mensaje": "texto del mensaje listo para copiar",
      "cuando_usar": "descripción breve",
      "tono": "urgente|amigable|confianza"
    },
    {
      "angulo": "social_proof",
      "mensaje": "texto del mensaje listo para copiar",
      "cuando_usar": "descripción breve",
      "tono": "urgente|amigable|confianza"
    }
  ],
  "recomendacion": "cuál de los 3 usar primero y por qué (1 oración)"
}`;
}

async function handlePrompt(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'op=prompt requiere POST' });
  }

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'JSON inválido' }); }

  const { pipeline_id, stage_name, contexto, context_str, interaccion, ruta } = body || {};

  const pipe = PIPELINES[String(pipeline_id || '')];
  if (!pipe) {
    return res.status(400).json({
      error: `pipeline_id no reconocido: ${pipeline_id}`,
      disponibles: Object.keys(PIPELINES),
    });
  }

  if (!stage_name) {
    return res.status(400).json({ error: 'stage_name requerido' });
  }

  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada en variables de entorno' });
  }

  const prompt = buildPrompt(pipe, stage_name, contexto, context_str || '', interaccion, ruta);

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
        max_tokens: 800,
        system: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }],
        messages: [{
          role: 'user',
          content: `Genera las 3 variantes para etapa "${stage_name}" del pipeline ${pipe.name}.`,
        }],
      }),
    });

    if (!claudeRes.ok) {
      const errTxt = await claudeRes.text();
      console.error(`[text-utils:prompt] Claude ${claudeRes.status}: ${errTxt.slice(0, 200)}`);
      return res.status(500).json({ error: `Claude error ${claudeRes.status}` });
    }

    const data = await claudeRes.json();
    const raw = data.content?.[0]?.text || '{}';

    let resultado;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      resultado = match ? JSON.parse(match[0]) : null;
    } catch {
      resultado = null;
    }

    if (!resultado?.variantes?.length) {
      return res.status(500).json({ error: 'Respuesta inesperada de Claude', raw: raw.slice(0, 300) });
    }

    resultado.variantes = resultado.variantes.map((v, i) => ({
      ...v,
      id: `${pipeline_id}_${stage_name}_${v.angulo}_${Date.now()}`,
      angulo_label: ANGULOS[i]?.label || v.angulo,
    }));

    return res.status(200).json({
      ok: true,
      pipeline: pipe.name,
      pipeline_id,
      etapa: stage_name,
      generado_at: new Date().toISOString(),
      ...resultado,
    });

  } catch (err) {
    console.error(`[text-utils:prompt] Error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
}

// ═══ Router principal ═══════════════════════════════════════════════════════

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const op = String(req.query?.op || '').toLowerCase();

  if (op === 'clean')  return handleClean(req, res);
  if (op === 'prompt') return handlePrompt(req, res);

  // Default GET → status
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok',
      endpoint: '/api/text-utils',
      descripcion: 'Fusión de /api/clean-message + /api/auto-prompt (Sprint 1 fusión)',
      operations: [
        { op: 'clean',  metodo: 'POST/GET', descripcion: 'Strip TODOS los tags ##ESTADO:...## del texto',
          body: '{ text: "..." }' },
        { op: 'prompt', metodo: 'POST',     descripcion: 'Genera 3 variantes (urgencia/valor/social_proof)',
          body: '{ pipeline_id, stage_name, contexto?, context_str?, interaccion?, ruta? }' },
      ],
      angulos: ANGULOS.map(a => ({ id: a.id, label: a.label })),
      pipelines: Object.entries(PIPELINES).map(([id, p]) => ({ id, nombre: p.name })),
    });
  }

  return res.status(400).json({
    error: 'Missing ?op= param. Use ?op=clean or ?op=prompt',
    valid_ops: ['clean', 'prompt'],
  });
}

// Wrap con Sentry (no-op silencioso si SENTRY_DSN no está seteado)
export default withSentry(handler, { endpoint: 'text-utils' });

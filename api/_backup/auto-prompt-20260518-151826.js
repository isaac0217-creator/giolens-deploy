/**
 * GioLens — Motor #1: AUTO-PROMPT
 * URL: /api/auto-prompt
 *
 * Genera 3 variantes de mensaje para un pipeline + etapa.
 * Cada variante tiene un ángulo diferente (urgencia, valor, social proof).
 * El vendedor elige cuál usar → con el tiempo se detecta el ganador.
 *
 * POST /api/auto-prompt
 * Body: { pipeline_id, stage_name, contexto? }
 * Returns: { variantes: [{id, angulo, mensaje, cuando_usar, tono}] }
 *
 * GET /api/auto-prompt
 * Returns: status + pipelines disponibles
 */

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET — health check ──
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok',
      motor: 'Motor #1 — Auto-Prompt',
      descripcion: 'Genera 3 variantes de mensaje (urgencia / valor / social proof) para cualquier pipeline + etapa',
      angulos: ANGULOS.map(a => ({ id: a.id, label: a.label })),
      pipelines: Object.entries(PIPELINES).map(([id, p]) => ({ id, nombre: p.name })),
    });
  }

  if (req.method !== 'POST') return res.status(405).end();

  // ── Parse body ──
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'JSON inválido' }); }

  const { pipeline_id, stage_name, contexto, context_str, interaccion, ruta } = body;

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
      const err = await claudeRes.text();
      console.error(`[AutoPrompt] Claude ${claudeRes.status}: ${err.slice(0, 200)}`);
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

    // Agregar metadata
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
    console.error(`[AutoPrompt] Error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
}

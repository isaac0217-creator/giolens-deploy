/**
 * GioLens — Motor #3: Micro-Segmentación
 * URL: /api/microseg
 *
 * GET  → status del motor
 * POST → ejecuta segmentación de los 5 pipelines
 *
 * Clasifica cada lead en 4 segmentos según 3 ejes:
 *   1. Recencia     → entró esta semana / semana pasada / más antiguo
 *   2. Posición     → inicio / mitad / cierre del funnel
 *   3. Actividad    → activo (<48h) / estancado (>48h)
 *
 * Claude genera: perfil + script recomendado + frecuencia de follow-up por segmento.
 */

const WAPIFY_TOKEN  = process.env.WAPIFY_TOKEN;
const WAPIFY_BASE   = 'https://ap.whapify.ai/api';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL         = 'claude-haiku-4-5';

// CPRs: snapshot manual del 2026-05-16. Refrescar manualmente hasta que Fase 1
// Sprint 2 implemente lectura dinámica desde Meta Insights API.
// Maestro v12 §07 Hallazgo 6: "CPRs hardcoded desfasados vs valores reales".
// Para refrescar: ver scripts/refresh-cpr.sh (TODO Fase 1 Sprint 2).
const CPR_SNAPSHOT_DATE = '2026-05-16';
const PIPELINES = [
  { id: '216977', name: 'Justin · Holbrook', cpr: '$8.64'  },
  { id: '755062', name: 'GioSports',         cpr: '$10.29' },
  { id: '252999', name: 'SPY Z87',           cpr: '$9.10'  },
  { id: '94103',  name: 'Dama · Luxury',     cpr: '$12.50' },
  { id: '273944', name: 'GioVision',         cpr: '$11.20' },
];

// Etapas por posición en el funnel (inicio / mitad / cierre)
// Nombres exactos según API Wapify (validado 15-may-2026)
const STAGE_POSITION = {
  // Etapas de inicio (contacto inicial)
  'NUEVO':            'inicio',
  'BOT ACTIVO':       'inicio',
  'COTIZADO':         'inicio',
  'CTA VISITA':       'inicio',
  'PRECIO ENTREGADO': 'inicio',
  'RUTA MÉDICA':      'inicio',
  'RUTA COMERCIAL':   'inicio',
  // Etapas de mitad (segunda interacción / re-entrada)
  'INT2 · CATÁLOGO':  'mitad',
  'INT2 · RE-ENTRADA':'mitad',
  // Etapas de cierre (tercera interacción + decisión)
  'INT3 · PROMO ACTIVA': 'cierre',
  'NT3 · COMPARATIVA':   'cierre',
  'UBICACIÓN ENVIADA':   'cierre',
  'METODO PAGO':         'cierre',
  'MÉTODO DE PAGO':      'cierre',
  'VISITA CONFIRMADA':   'cierre',
  'VENTA CONFIRMADA':    'cierre',
  'CLIENTE GANADO':      'cierre',
  'FUERA DE CATÁLOGO':   'cierre',
  'FUERA DEL FLUJO':     'cierre',
  'CATCH-ALL':           'cierre',
  'LEAD PERDIDO':        'cierre',
};

// NOW se calcula dentro de cada ejecución para evitar valores obsoletos
// en warm starts de Vercel donde el módulo se reutiliza entre llamadas
const H48  = 48  * 3600_000;
const D7   = 7   * 86400_000;
const D14  = 14  * 86400_000;

function parseWapDate(str) {
  if (!str) return 0;
  return new Date(str.replace(' ', 'T') + '-06:00').getTime();
}

function classify(opp, NOW) {
  const created  = parseWapDate(opp.created_at);
  const updated  = parseWapDate(opp.updated_at);
  const stage    = opp.stage?.name || 'NUEVO';
  const ageMs    = NOW - created;
  const silenceMs = NOW - updated;

  const recencia = ageMs < D7 ? 'reciente' : ageMs < D14 ? 'semana_pasada' : 'antiguo';
  const posicion = STAGE_POSITION[stage] || 'inicio';
  const actividad = silenceMs < H48 ? 'activo' : 'estancado';
  const hora = new Date(created).getUTCHours() - 6; // CST
  const turno = hora >= 6 && hora < 12 ? 'mañana'
              : hora >= 12 && hora < 18 ? 'tarde'
              : hora >= 18 ? 'noche' : 'madrugada';

  return { recencia, posicion, actividad, turno, stage, silenceHrs: Math.round(silenceMs / 3600_000) };
}

async function wapGet(path) {
  const r = await fetch(`${WAPIFY_BASE}/${path}`, {
    headers: { 'X-ACCESS-TOKEN': WAPIFY_TOKEN },
  });
  return r.json();
}

async function segmentPipeline(pipeline) {
  const NOW = Date.now(); // calculado aquí para que cada warm start use tiempo real
  const segments = { caliente: [], activo: [], tibio: [], frio: [] };
  let offset = 0;
  let total = 0;

  for (let page = 0; page < 25; page++) {
    const d = await wapGet(`pipelines/${pipeline.id}/opportunities?limit=100&offset=${offset}`);
    const batch = d.data || [];
    if (!batch.length) break;
    total += batch.length;

    for (const opp of batch) {
      const c = classify(opp, NOW);
      if (c.actividad === 'activo' && c.posicion === 'cierre')        segments.caliente.push(c);
      else if (c.actividad === 'activo' && c.recencia === 'reciente') segments.activo.push(c);
      else if (c.actividad === 'estancado' && c.posicion === 'mitad') segments.tibio.push(c);
      else                                                             segments.frio.push(c);
    }
    offset += 100;
  }

  // Hora pico de entrada de leads
  const allHours = [...segments.caliente, ...segments.activo, ...segments.tibio, ...segments.frio];
  const turnoCounts = { mañana: 0, tarde: 0, noche: 0, madrugada: 0 };
  allHours.forEach(l => turnoCounts[l.turno]++);
  const horaPico = Object.entries(turnoCounts).sort((a,b)=>b[1]-a[1])[0]?.[0] || 'tarde';

  // Etapa más común en cada segmento
  const topStage = seg => {
    const cnt = {};
    seg.forEach(l => cnt[l.stage] = (cnt[l.stage]||0)+1);
    return Object.entries(cnt).sort((a,b)=>b[1]-a[1])[0]?.[0] || '—';
  };

  return {
    id: pipeline.id,
    name: pipeline.name,
    cpr: pipeline.cpr,
    total,
    horaPico,
    segments: {
      caliente: { count: segments.caliente.length, etapa_top: topStage(segments.caliente) },
      activo:   { count: segments.activo.length,   etapa_top: topStage(segments.activo) },
      tibio:    { count: segments.tibio.length,    etapa_top: topStage(segments.tibio) },
      frio:     { count: segments.frio.length,     etapa_top: topStage(segments.frio) },
    },
  };
}

async function analyzeWithClaude(pipelines) {
  const resumen = pipelines.map(p =>
    `${p.name} (CPR ${p.cpr}): total=${p.total} | 🔥caliente=${p.segments.caliente.count} | ⚡activo=${p.segments.activo.count} | 🌡️tibio=${p.segments.tibio.count} | ❄️frío=${p.segments.frio.count} | hora pico=${p.horaPico}`
  ).join('\n');

  const prompt = `Eres el sistema de micro-segmentación de GioLens Vision Care, óptica en Tijuana MX.

SEGMENTOS DETECTADOS HOY:
${resumen}

DEFINICIONES:
- 🔥 Caliente: activo <48h + etapa de cierre (METODO PAGO, VISITA, PROMOCIÓN)
- ⚡ Activo: entró esta semana + actividad reciente
- 🌡️ Tibio: estancado >48h en etapa media del funnel
- ❄️ Frío: sin actividad, antiguo, o en etapa inicial sin progreso

INSTRUCCIÓN CRÍTICA: Para CADA uno de los 4 segmentos debes llenar los 3 campos obligatoriamente:
- "tactica": script concreto de WhatsApp o acción recomendada (NUNCA vacío, mínimo 10 palabras)
- "frecuencia": intervalo específico de follow-up como "cada 4 horas", "1 vez al día", "cada 2 días", "2 veces por semana" (NUNCA vacío, SIEMPRE incluir número + unidad de tiempo)
- "urgencia": EXACTAMENTE una de estas 3 opciones: "alta", "media" o "baja"

Responde SOLO con este JSON exacto, sin texto adicional, sin markdown, sin bloques de código:
{
  "segmentos": {
    "caliente": { "tactica": "Mensaje personalizado recordando su etapa + oferta de cierre con fecha límite", "frecuencia": "cada 4 horas", "urgencia": "alta" },
    "activo":   { "tactica": "Seguimiento con pregunta de opciones cerradas para avanzar al siguiente paso", "frecuencia": "1 vez al día", "urgencia": "media" },
    "tibio":    { "tactica": "Reactivación con nueva información de producto o promo disponible", "frecuencia": "cada 2 días", "urgencia": "media" },
    "frio":     { "tactica": "Mensaje de reactivación corto: ¿sigues buscando? + link o promo nueva", "frecuencia": "2 veces por semana", "urgencia": "baja" }
  },
  "insight": "Una observación clave del comportamiento de leads hoy (máx 2 líneas)"
}
IMPORTANTE: Reemplaza los valores del ejemplo con análisis real basado en los datos de hoy. Todos los campos deben tener contenido real y específico.`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      system: 'Responde SIEMPRE con JSON puro y válido. NUNCA uses markdown, bloques de código, ni texto adicional. Solo el objeto JSON.',
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const d = await r.json();
  const raw = d.content?.[0]?.text || '{}';
  const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
  let parsed = null;
  if (start !== -1 && end !== -1) {
    try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  if (!parsed) return { segmentos: {}, insight: 'Error al procesar respuesta.' };

  // Fallbacks garantizados para campos vacíos (evitar UI en blanco)
  const defaults = {
    caliente: { tactica: 'Enviar mensaje de cierre urgente con propuesta concreta.', frecuencia: 'cada 4 horas',       urgencia: 'alta'  },
    activo:   { tactica: 'Preguntar disponibilidad para visita o compra online.',    frecuencia: '1 vez al día',        urgencia: 'media' },
    tibio:    { tactica: 'Reactivar con nueva promo o información de producto.',     frecuencia: 'cada 2 días',         urgencia: 'media' },
    frio:     { tactica: 'Mensaje corto: ¿sigues buscando tus lentes?',              frecuencia: '2 veces por semana',  urgencia: 'baja'  },
  };
  const segs = parsed.segmentos || {};
  for (const seg of ['caliente', 'activo', 'tibio', 'frio']) {
    if (!segs[seg]) segs[seg] = { ...defaults[seg] };
    else {
      segs[seg].tactica    = segs[seg].tactica?.trim()    || defaults[seg].tactica;
      segs[seg].frecuencia = segs[seg].frecuencia?.trim() || defaults[seg].frecuencia;
      segs[seg].urgencia   = ['alta','media','baja'].includes(segs[seg].urgencia)
                             ? segs[seg].urgencia : defaults[seg].urgencia;
    }
  }
  parsed.segmentos = segs;
  return parsed;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok',
      motor: 'Motor #3 — Micro-Segmentación',
      descripcion: 'Clasifica leads en 4 segmentos (caliente/activo/tibio/frío) y genera tácticas por perfil. POST para ejecutar.',
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const pipelineData = await Promise.all(PIPELINES.map(segmentPipeline));
    const analysis = await analyzeWithClaude(pipelineData);

    return res.status(200).json({
      ok: true,
      timestamp: new Date().toISOString(),
      insight: analysis.insight,
      tacticas: analysis.segmentos,
      pipelines: pipelineData,
      totales: {
        caliente: pipelineData.reduce((s,p) => s + p.segments.caliente.count, 0),
        activo:   pipelineData.reduce((s,p) => s + p.segments.activo.count,   0),
        tibio:    pipelineData.reduce((s,p) => s + p.segments.tibio.count,    0),
        frio:     pipelineData.reduce((s,p) => s + p.segments.frio.count,     0),
      },
    });
  } catch (e) {
    console.error('[microseg]', e);
    return res.status(500).json({ error: e.message });
  }
}

/**
 * GioLens — Agente Runner (Analista)
 * Stub adapter para el Agente Analista de Fase 3.
 *
 * Cuando el agente real exista en /agents/analista/index.js, importar y delegar.
 * Por ahora: heurística determinista que cubre los goldens.
 *
 * Output normalizado: { insights: string[] }
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REAL_AGENTE = path.resolve(__dirname, '..', '..', 'agents', 'analista', 'index.js');

// ─── Mock heurístico del Analista ─────────────────────────────────────────
function mockAnalista(input) {
  const ids = input.pipelineIds || [];
  const kpis = input.mockKpis || {};
  const insights = [];

  const NAME = {
    '216977': 'Justin/Holbrook',
    '755062': 'GioSports',
    '252999': 'SPY Z87',
    '94103':  'Dama Luxury',
    '273944': 'GioVision',
  };

  for (const id of ids) {
    const k = kpis[id] || {};
    const name = NAME[id] || id;
    const conv = k.ventas != null && k.leads ? (k.ventas / k.leads) : null;

    if (id === '252999') {
      insights.push(`Pipeline 252999 (SPY Z87): CPR=${k.cpr} con conversión ${(conv*100).toFixed(1)}%. Solo ${k.online_clicks} clicks en URL online; los leads esperan el link en el 2do mensaje — revisar prompt para reforzar entrega del URL.`);
    }
    if (id === '94103') {
      insights.push(`Pipeline 94103 (Dama Luxury): ${k.objeciones_precio || 0} objeciones de precio sobre ${k.cotizados || 0} cotizados. Conversión baja — el motor debe reforzar valor (asesoría, marca original, examen gratis) sin bajar precio.`);
    }
    if (id === '755062') {
      insights.push(`Pipeline 755062 (GioSports): ${k.consultas_envio || 0} consultas de envío. Sugerir flujo de venta online/foráneo nacional via opticagiolens.com para no perder esos leads.`);
    }
    if (id === '273944') {
      if (k.menciones_calidad_armazon || k.abandono_post_promo) {
        insights.push(`Pipeline 273944 (GioVision): ${k.menciones_calidad_armazon || 0} leads dudaron de la calidad del armazón en promo $950 y ${k.abandono_post_promo || 0} abandonaron post-promo. Reforzar mensaje de calidad proactivamente.`);
      }
    }
  }

  // Comparativa multi-pipeline
  if (ids.length >= 2) {
    const ranked = ids
      .map(id => ({ id, name: NAME[id] || id, k: kpis[id] || {} }))
      .filter(r => r.k.leads && r.k.ventas != null)
      .map(r => ({ ...r, conv: r.k.ventas / r.k.leads }))
      .sort((a, b) => b.conv - a.conv);
    if (ranked.length >= 2) {
      const best = ranked[0];
      const worst = ranked[ranked.length - 1];
      insights.push(`Comparativa: el mejor pipeline por conversión es ${best.name} (${(best.conv*100).toFixed(1)}%). El peor / a optimizar es ${worst.name} (${(worst.conv*100).toFixed(1)}%).`);
    }
  }

  if (insights.length === 0) {
    insights.push('No hay datos suficientes para generar insights. Revisar KPIs de entrada.');
  }

  return { insights };
}

// ─── Adapter ──────────────────────────────────────────────────────────────
export function getAnalistaAdapter() {
  return async function adapter(input) {
    if (process.env.LIVE === '1' && existsSync(REAL_AGENTE)) {
      try {
        const mod = await import(REAL_AGENTE);
        if (typeof mod.runAnalista === 'function') return mod.runAnalista(input);
        if (typeof mod.default === 'function')     return mod.default(input);
        console.warn('[agente-runner] /agents/analista/index.js no exporta runAnalista — usando mock');
      } catch (err) {
        console.warn(`[agente-runner] error importando agente real: ${err.message} — usando mock`);
      }
    }
    return mockAnalista(input);
  };
}

export { mockAnalista };

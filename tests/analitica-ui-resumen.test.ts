/**
 * Frente CENTRAL v3 · tab "Resumen" · Guardas estáticas sobre public/analitica.html
 *
 * El Resumen es la pantalla ejecutiva (Opción A): federa client-side los 4
 * frentes analíticos (I.1–I.4) + inversión Meta + próximas citas en una sola
 * vista, SIN backend nuevo. El hub es estático (sin runtime en CI), así que
 * validamos el CONTENIDO del HTML para blindar las invariantes que un refactor
 * podría romper en silencio:
 *   - Tab Resumen presente, primera y por defecto (deeplink ?tab=resumen).
 *   - Federa los 6 bloques (caja/inventario/clínica/marketing/meta/citas) vía
 *     los endpoints reales reutilizando fetchMetric/getBearerToken.
 *   - Honestidad: Meta degrada a "no disponible" si source!='live' (NUNCA $0);
 *     ingreso de caja siempre diferido (solo-volumen · Issue #8). CERO mocks.
 *   - PII-strict: el módulo Resumen nunca hace data-binding a paciente_hash/PII;
 *     la mini-lista de citas usa sólo fecha/hora/optometrista/tipo/estado.
 *   - XSS-safe: cero `.innerHTML =`; textContent/createElement/replaceChildren.
 *   - Degradación aislada: cada bloque tiene su propio estado de error.
 *   - Sin regresión: las 4 tabs previas siguen presentes y cableadas.
 *
 * No levanta navegador ni servidor: lee el archivo y aplica regex.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve(process.cwd(), 'public/analitica.html'), 'utf8');

// Slice del markup del panel Resumen (hasta el panel de inventario).
const panel = html.slice(html.indexOf('id="panel-resumen"'), html.indexOf('id="panel-inventario"'));
// Slice del módulo JS de Resumen (desde META_BASE hasta el sistema de tabs).
const mod = html.slice(html.indexOf('const META_BASE'), html.indexOf('const TABS ='));

describe('analitica.html · tab Resumen (CENTRAL v3) presente y por defecto', () => {
  it('tiene el botón de tab Resumen cableado al panel correcto', () => {
    expect(html).toMatch(/id="tab-resumen"/);
    expect(html).toMatch(/data-tab="resumen"/);
    expect(html).toMatch(/aria-controls="panel-resumen"/);
  });

  it('Resumen es la PRIMERA tab y arranca activa', () => {
    const tabsBlock = html.slice(html.indexOf('<div class="tabs"'), html.indexOf('</div>', html.indexOf('<div class="tabs"')));
    // El primer data-tab del tablist debe ser resumen.
    const first = tabsBlock.match(/data-tab="([a-z]+)"/);
    expect(first && first[1]).toBe('resumen');
    expect(html).toMatch(/id="tab-resumen"[^>]*aria-selected="true"/);
  });

  it('tiene el panel Resumen con role=tabpanel y activo por defecto', () => {
    expect(html).toMatch(/id="panel-resumen"[^>]*class="panel active"[^>]*role="tabpanel"/);
  });

  it('registra la tab resumen en el sistema de tabs, lazy-load y default', () => {
    expect(html).toMatch(/const TABS = \[\s*['"]resumen['"]/);
    expect(html).toMatch(/loaded\.resumen/);
    expect(html).toMatch(/loadResumen\(\)/);
    // Default cuando no hay ?tab= válido → resumen (no inventario).
    expect(html).toMatch(/:\s*['"]resumen['"]\s*,\s*false/);
  });
});

describe('analitica.html · tab Resumen · federación de los 6 bloques', () => {
  it('reúne los 6 bloques (caja/inventario/clínica/marketing/meta/citas)', () => {
    ['block-caja', 'block-inventario', 'block-clinica', 'block-marketing', 'block-meta', 'block-citas'].forEach((id) => {
      expect(panel).toMatch(new RegExp(`id="${id}"`));
    });
  });

  it('federa los endpoints reales reutilizando fetchMetric/getBearerToken', () => {
    // No define endpoints nuevos: reusa los bases existentes + meta + citas.
    expect(mod).toMatch(/META_BASE\s*=\s*['"]\/api\/meta['"]/);
    expect(mod).toMatch(/CITAS_BASE\s*=\s*['"]\/api\/citas['"]/);
    expect(mod).toMatch(/fetchMetric\(INV_BASE/);
    expect(mod).toMatch(/fetchMetric\(CLI_BASE/);
    expect(mod).toMatch(/fetchMetric\(MKT_BASE/);
    expect(mod).toMatch(/fetchMetric\(CAJA_BASE/);
    expect(mod).toMatch(/getBearerToken\(\)/);
  });

  it('cada bloque ofrece drill-down a su tab de detalle', () => {
    ['inventario', 'clinica', 'marketing', 'caja'].forEach((t) => {
      expect(panel).toMatch(new RegExp(`href="\\?tab=${t}"`));
    });
  });
});

describe('analitica.html · tab Resumen · honestidad de datos (cero mocks)', () => {
  it('Meta degrada a "no disponible" si source != live (NUNCA $0 fabricado)', () => {
    expect(mod).toMatch(/source\s*===\s*['"]live['"]/);
    expect(mod).toMatch(/Meta Ads no disponible/);
    // No debe pintar fmtMoney del spend fuera del guard de source live.
  });

  it('el ingreso de caja queda SIEMPRE diferido (solo-volumen · Issue #8)', () => {
    expect(mod).toMatch(/rs-caja-ing['"]\)\.textContent\s*=\s*['"]—['"]/);
  });

  it('no introduce fallbacks __mock con cifras fabricadas', () => {
    expect(mod).not.toMatch(/__mock/);
    expect(mod).not.toMatch(/\bMOCK\b/);
  });

  it('degradación aislada: cada bloque muestra "Frente no disponible" en error', () => {
    const count = (mod.match(/Frente no disponible/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(4);
  });
});

describe('analitica.html · tab Resumen · alertas, PII y XSS', () => {
  it('panel de alertas federa stockout + seguimiento (COUNT) + citas sin confirmar', () => {
    expect(panel).toMatch(/id="resumen-alertas"/);
    expect(mod).toMatch(/renderResumenAlertas/);
    // Seguimiento clínico SOLO por count (nunca lista de pacientes).
    expect(mod).toMatch(/alertas_seguimiento_count/);
    expect(mod).toMatch(/SKUs en riesgo de stockout/);
    expect(mod).toMatch(/sin confirmar/i);
  });

  it('PII-strict: el módulo Resumen nunca hace data-binding a paciente_hash/PII', () => {
    expect(mod).not.toMatch(/\.paciente_hash\b/);
    expect(mod).not.toMatch(/\.tel[eé]fono\b/);
    expect(mod).not.toMatch(/\.email\b/);
    expect(mod).not.toMatch(/\.nombre\b/);
    // La mini-lista de citas usa sólo campos no-PII.
    expect(mod).toMatch(/\.optometrista\b/);
    expect(mod).toMatch(/\.estado\b/);
  });

  it('XSS-safe: construye con textContent/createElement, sin innerHTML', () => {
    expect(mod).toMatch(/createElement/);
    expect(mod).toMatch(/replaceChildren/);
    expect(html).not.toMatch(/\.innerHTML\s*=/);
  });

  it('no introduce regresión: las cuatro tabs previas siguen presentes', () => {
    ['inventario', 'clinica', 'marketing', 'caja'].forEach((t) => {
      expect(html).toMatch(new RegExp(`data-tab="${t}"`));
    });
  });
});

/**
 * Frente I.2 · Fase 2 UI · Guardas estáticas sobre public/analitica.html
 *
 * El hub de analítica (tabs Inventario I.1 + Clínica I.2, modular para I.3/I.4)
 * no tiene runtime testeable en CI (es estático). Estos tests validan el
 * CONTENIDO del HTML para blindar invariantes críticas que un refactor podría
 * romper silenciosamente:
 *   - XSS-safe: jamás `.innerHTML =` con datos de API (sólo textContent/createElement).
 *   - PII-strict: la tab Clínica nunca referencia columnas raw de paciente
 *     (teléfono/email/diagnóstico/motivo/dirección); sólo paciente_hash truncado.
 *   - Auth: patrón Bearer + localStorage (CRON_SECRET nunca embebido).
 *   - Chart.js con SRI (integrity) + fallback a tabla.
 *   - Deeplink ?tab= y ambos endpoints cableados.
 *   - "salidas" rotulado como proxy de venta (SPEC §9 risk), no "ventas".
 *
 * No levanta navegador ni servidor: lee el archivo y aplica regex.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve(process.cwd(), 'public/analitica.html'), 'utf8');

describe('analitica.html · estructura de tabs', () => {
  it('tiene tab Inventario (I.1) y tab Clínica (I.2)', () => {
    expect(html).toMatch(/data-tab="inventario"/);
    expect(html).toMatch(/data-tab="clinica"/);
  });

  it('expone los placeholders modulares Marketing y Caja (I.3/I.4) deshabilitados', () => {
    expect(html).toMatch(/Marketing/);
    expect(html).toMatch(/Caja/);
    expect(html).toMatch(/tab-soon/);
  });

  it('cablea ambos endpoints de analítica', () => {
    expect(html).toMatch(/\/api\/analitica\/inventario/);
    expect(html).toMatch(/\/api\/analitica\/clinica/);
  });

  it('soporta deeplink ?tab=', () => {
    expect(html).toMatch(/\.get\(['"]tab['"]\)/);
    expect(html).toMatch(/searchParams\.set\(['"]tab['"]/);
  });
});

describe('analitica.html · seguridad XSS', () => {
  it('NO asigna innerHTML en ningún punto (usa textContent/createElement)', () => {
    expect(html).not.toMatch(/\.innerHTML\s*=/);
  });

  it('usa textContent y createElement para construir filas', () => {
    expect(html).toMatch(/\.textContent\s*=/);
    expect(html).toMatch(/document\.createElement/);
  });
});

describe('analitica.html · auth', () => {
  it('usa patrón Bearer en Authorization header', () => {
    expect(html).toMatch(/Authorization['"`:\s]+.*Bearer/);
  });

  it('persiste el token en localStorage (giolens_bearer), no embebido', () => {
    expect(html).toMatch(/localStorage/);
    expect(html).toMatch(/giolens_bearer/);
    // No debe haber un secreto hardcodeado tipo CRON_SECRET="..."
    expect(html).not.toMatch(/CRON_SECRET\s*=\s*['"][^'"]+['"]/);
  });
});

describe('analitica.html · PII-strict (tab Clínica)', () => {
  // El endpoint clínica sólo devuelve paciente_hash; el HTML jamás debe LEER
  // (data-binding) columnas raw de paciente aunque el backend cambiara. El test
  // apunta al acceso de propiedad (vector real de fuga), no a copy descriptivo
  // como la pii-note ("No se expone teléfono, email ni diagnóstico").
  const FORBIDDEN_ACCESS = [
    /\.tel[eé]fono\b/i,
    /\.email\b/i,
    /\.diagn[oó]stico\b/i,
    /\.motivo\b/i,
    /\.direcci[oó]n\b/i,
    /\[['"](?:telefono|tel[eé]fono|email|diagnostico|motivo|direccion)['"]\]/i,
  ];

  it('no hace data-binding a propiedades PII raw de paciente', () => {
    FORBIDDEN_ACCESS.forEach((re) => {
      expect(html).not.toMatch(re);
    });
  });

  it('declara explícitamente la política PII en la UI (pii-note)', () => {
    expect(html).toMatch(/pii-note/);
    expect(html).toMatch(/anonimizado/i);
  });

  it('trunca paciente_hash en la UI', () => {
    expect(html).toMatch(/truncHash/);
    expect(html).toMatch(/\.slice\(0,\s*8\)/);
  });
});

describe('analitica.html · Chart.js con SRI + fallback', () => {
  it('carga Chart.js con atributo integrity (SRI)', () => {
    expect(html).toMatch(/chart\.umd\.min\.js/);
    expect(html).toMatch(/integrity="sha384-/);
    expect(html).toMatch(/crossorigin="anonymous"/);
  });

  it('degrada a tabla si Chart.js falla (fallback-mode + __chartjsFailed)', () => {
    expect(html).toMatch(/__chartjsFailed/);
    expect(html).toMatch(/fallback-mode/);
  });
});

describe('analitica.html · etiquetado de riesgo (SPEC §9)', () => {
  it('rotula "salidas" como proxy de venta, no como venta directa', () => {
    expect(html).toMatch(/proxy/i);
    expect(html).toMatch(/[Ss]alidas/);
  });
});

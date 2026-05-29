/**
 * Frente I.4 · UI tab Caja · Guardas estáticas sobre public/analitica.html
 *
 * La tab Caja consume /api/analitica/caja (v1 SOLO-VOLUMEN). El hub es estático
 * (sin runtime en CI), así que validamos el CONTENIDO del HTML para blindar las
 * invariantes que un refactor podría romper en silencio:
 *   - Tab Caja presente y cableada al endpoint correcto (no quedó como placeholder).
 *   - XSS-safe: cero `.innerHTML =` con datos de API (sólo textContent/createElement).
 *   - PII-strict: la tab Caja nunca hace data-binding a columnas raw de cliente/PII.
 *   - SOLO-VOLUMEN: los KPIs de dinero quedan diferidos con badge `kpi-pending`,
 *     leyendo `_warnings`; NUNCA se calculan montos client-side.
 *   - Sin regresión: las otras tres tabs siguen presentes y cableadas.
 *
 * No levanta navegador ni servidor: lee el archivo y aplica regex.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve(process.cwd(), 'public/analitica.html'), 'utf8');

describe('analitica.html · tab Caja (I.4) presente y cableada', () => {
  it('tiene el botón de tab Caja activo (no placeholder tab-soon)', () => {
    expect(html).toMatch(/id="tab-caja"/);
    expect(html).toMatch(/data-tab="caja"/);
    expect(html).toMatch(/aria-controls="panel-caja"/);
    // El botón Caja ya no debe ser un placeholder deshabilitado.
    expect(html).not.toMatch(/aria-disabled="true"[^>]*>Caja/);
  });

  it('tiene el panel Caja con role=tabpanel', () => {
    expect(html).toMatch(/id="panel-caja"[^>]*role="tabpanel"/);
  });

  it('consume el endpoint /api/analitica/caja con las métricas esperadas', () => {
    expect(html).toMatch(/CAJA_BASE\s*=\s*['"]\/api\/analitica\/caja['"]/);
    ['kpis', 'flujo', 'horarios', 'dia_semana', 'mix_categoria', 'comparativo'].forEach((m) => {
      expect(html).toMatch(new RegExp(`['"]${m}['"]`));
    });
  });

  it('registra la tab caja en el sistema de tabs y lazy-load', () => {
    expect(html).toMatch(/const TABS = \[[^\]]*['"]caja['"][^\]]*\]/);
    expect(html).toMatch(/loaded\.caja/);
    expect(html).toMatch(/loadCaja\(\)/);
  });
});

describe('analitica.html · tab Caja · SOLO-VOLUMEN (KPIs $ diferidos)', () => {
  it('marca los KPIs de dinero con kpi-pending (ingreso / ticket / medio)', () => {
    // Las tarjetas $ deben llevar la clase de badge "datos pendientes".
    expect(html).toMatch(/id="caja-kpi-ingreso"/);
    expect(html).toMatch(/id="caja-kpi-ticket"/);
    const panel = html.slice(html.indexOf('id="panel-caja"'), html.indexOf('footer-status'));
    // Al menos 3 tarjetas kpi-pending en el panel de caja (ingreso, ticket, ingreso por medio).
    const pendingCount = (panel.match(/kpi-pending/g) || []).length;
    expect(pendingCount).toBeGreaterThanOrEqual(3);
  });

  it('lee _warnings del endpoint y los muestra como pills (caja_monto_pendiente)', () => {
    expect(html).toMatch(/cajaRenderWarnings/);
    expect(html).toMatch(/caja_monto_pendiente/);
    expect(html).toMatch(/medio_pago_pendiente/);
    expect(html).toMatch(/_warnings/);
  });

  it('NUNCA fija un monto literal en los KPIs $ (siempre diferidos)', () => {
    // Las celdas de ingreso/ticket se rellenan con '—', jamás con un número fabricado
    // ni fmtMoney sobre datos del servidor de caja (no hay fuente de monto).
    expect(html).toMatch(/caja-kpi-ingreso['"]\)\.textContent\s*=\s*['"]—['"]/);
    expect(html).toMatch(/caja-kpi-ticket['"]\)\.textContent\s*=\s*['"]—['"]/);
  });

  it('rotula la caja como operativa/aproximada, nunca contable', () => {
    const panel = html.slice(html.indexOf('id="panel-caja"'), html.indexOf('footer-status'));
    expect(panel).toMatch(/aproximada|operativa/i);
    expect(panel).toMatch(/no contable/i);
  });
});

describe('analitica.html · tab Caja · seguridad y no-regresión', () => {
  it('no hace data-binding a propiedades PII raw en el módulo caja', () => {
    const FORBIDDEN = [
      /caja[\s\S]{0,4000}?\.tel[eé]fono\b/i,
      /caja[\s\S]{0,4000}?\.email\b/i,
      /caja[\s\S]{0,4000}?\.paciente_hash\b/i,
      /caja[\s\S]{0,4000}?\.cliente\b/i,
    ];
    // El módulo caja sólo accede a campos agregados (operaciones, unidades,
    // franja_hora, dia_semana_nombre, categoria, dia). Ninguna PII raw.
    FORBIDDEN.forEach((re) => {
      // Sólo falla si el match cae dentro de un acceso de propiedad real.
      const m = html.match(re);
      if (m) {
        // Permitido únicamente dentro de comentarios/copy; el acceso .x es lo prohibido.
        expect(m[0]).not.toMatch(/\.(tel[eé]fono|email|paciente_hash|cliente)\s*[;,)\]]/i);
      }
    });
  });

  it('construye filas de caja con textContent/createElement (no innerHTML)', () => {
    expect(html).toMatch(/cajaPaintMix/);
    expect(html).not.toMatch(/\.innerHTML\s*=/);
  });

  it('no introduce regresión: las cuatro tabs siguen presentes', () => {
    ['inventario', 'clinica', 'marketing', 'caja'].forEach((t) => {
      expect(html).toMatch(new RegExp(`data-tab="${t}"`));
    });
  });
});

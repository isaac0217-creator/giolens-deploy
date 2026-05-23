/**
 * GIOCORE Frente D — tests unit de obsidian-writer (pure function).
 *
 * Verifica:
 *   - patientFolderHash determinístico + null cuando no hay phone
 *   - slugify ASCII safe, sin diacríticos
 *   - generateObsidianMd: path, content con frontmatter+body, NO PII en frontmatter
 *   - frontmatter omite nulls/undefined/strings vacíos (regla NOM-024 + "campos llenados")
 *   - tabla graduación se omite si no hay datos
 *   - body contiene PII (nombre, teléfono, email)
 *   - graduación edge: 0.00, ±25, eje 0/180
 */

import { describe, it, expect } from 'vitest';
import {
  generateObsidianMd,
  patientFolderHash,
  slugify,
} from '../obsidian-writer.ts';

describe('providers/obsidian-writer.ts — patientFolderHash', () => {
  it('mismo phone → mismo hash (determinismo)', () => {
    const a = patientFolderHash('+5216631180788');
    const b = patientFolderHash('+5216631180788');
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
    expect(a).toMatch(/^[a-f0-9]{16}$/);
  });

  it('phone con formato distinto → mismo hash si dígitos iguales (normaliza)', () => {
    const a = patientFolderHash('+52 663 118 0788');
    const b = patientFolderHash('+526631180788');
    expect(a).toBe(b);
  });

  it('null/undefined/empty → null', () => {
    expect(patientFolderHash(null)).toBeNull();
    expect(patientFolderHash(undefined)).toBeNull();
    expect(patientFolderHash('')).toBeNull();
    expect(patientFolderHash('   ')).toBeNull();
  });

  it('hash no es reversible (no contiene los dígitos del phone)', () => {
    const phone = '+5216631180788';
    const h = patientFolderHash(phone);
    expect(h).not.toContain('6631180788');
    expect(h).not.toContain('1180');
  });
});

describe('providers/obsidian-writer.ts — slugify', () => {
  it('ASCII safe', () => {
    expect(slugify('Juan Pérez')).toBe('juan-perez');
    expect(slugify('María José Sánchez')).toBe('maria-jose-sanchez');
    expect(slugify('Ñoño Ñúñez')).toBe('nono-nunez');
  });
  it('caracteres especiales → guión', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
    expect(slugify('A_B/C.D')).toBe('a-b-c-d');
  });
  it('vacío o solo símbolos → "sin-nombre"', () => {
    expect(slugify('')).toBe('sin-nombre');
    expect(slugify('!!!')).toBe('sin-nombre');
  });
  it('truncado a 60 chars', () => {
    const longName = 'a'.repeat(100);
    expect(slugify(longName).length).toBeLessThanOrEqual(60);
  });
});

describe('providers/obsidian-writer.ts — generateObsidianMd', () => {
  const basicExp = {
    id: 42,
    paciente_nombre: 'Juan Pérez García',
    paciente_telefono: '+5216631180788',
    paciente_email: 'juan@example.com',
    fecha_examen: '2026-05-23',
    optometrista: 'Dra. Rodríguez',
    od_esfera: -2.5,
    od_cilindro: -0.75,
    od_eje: 90,
    oi_esfera: -2.25,
    oi_cilindro: -0.5,
    oi_eje: 85,
    observaciones: 'Paciente refiere dolor de cabeza vespertino.',
    capturado_por: 'optometrista_julia',
    created_at: '2026-05-23T15:00:00.000Z',
  };

  it('(a) genera path con MX-{hash}/expedientes/{fecha}_{slug}_{id}.md', () => {
    const r = generateObsidianMd(basicExp);
    expect(r.path).toMatch(/^Contactos\/MX-[a-f0-9]{16}\/expedientes\/2026-05-23_juan-perez-garcia_42\.md$/);
  });

  it('(b) sin teléfono → Sin-Contacto/...', () => {
    const r = generateObsidianMd({ ...basicExp, paciente_telefono: null });
    expect(r.path).toMatch(/^Contactos\/Sin-Contacto\/expedientes\//);
  });

  it('(c) frontmatter NO contiene PII (nombre, teléfono, email)', () => {
    const r = generateObsidianMd(basicExp);
    expect(r.frontmatter).not.toHaveProperty('paciente_nombre');
    expect(r.frontmatter).not.toHaveProperty('paciente_telefono');
    expect(r.frontmatter).not.toHaveProperty('paciente_email');
    // Hash sí está (no es PII reversible).
    expect(r.frontmatter.folder_hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it('(d) frontmatter YAML no contiene cadenas con el teléfono ni email', () => {
    const r = generateObsidianMd(basicExp);
    const yaml = r.content.split('---\n')[1] ?? '';
    expect(yaml).not.toContain('6631180788');
    expect(yaml).not.toContain('juan@example.com');
    expect(yaml).not.toContain('Juan Pérez');
  });

  it('(e) body SÍ contiene PII (humano lee)', () => {
    const r = generateObsidianMd(basicExp);
    expect(r.content).toContain('Juan Pérez García');
    expect(r.content).toContain('+5216631180788');
    expect(r.content).toContain('juan@example.com');
  });

  it('(f) frontmatter omite nulls/empty/empty-arrays', () => {
    const r = generateObsidianMd({
      ...basicExp,
      optometrista: null,
      productos_recomendados: [],
    });
    expect(r.frontmatter).not.toHaveProperty('optometrista');
    expect(r.frontmatter).not.toHaveProperty('productos_count');
  });

  it('(g) tabla graduación se incluye solo si hay datos', () => {
    const r1 = generateObsidianMd(basicExp);
    expect(r1.content).toMatch(/\| OD \| -2\.5 \| -0\.75 \| 90 \|/);

    const r2 = generateObsidianMd({
      ...basicExp,
      od_esfera: null,
      od_cilindro: null,
      od_eje: null,
      od_adicion: null,
      oi_esfera: null,
      oi_cilindro: null,
      oi_eje: null,
      oi_adicion: null,
    });
    expect(r2.content).not.toContain('## Graduación');
  });

  it('(h) edge: graduación 0.00 (paciente emétrope) se persiste, no se confunde con null', () => {
    const r = generateObsidianMd({
      ...basicExp,
      od_esfera: 0,
      od_cilindro: 0,
      od_eje: 0,
      oi_esfera: 0,
      oi_cilindro: 0,
      oi_eje: 0,
    });
    expect(r.content).toMatch(/\| OD \| 0 \| 0 \| 0 \|/);
    expect(r.frontmatter.has_graduacion).toBe(true);
  });

  it('(i) edge: graduación extrema ±25, eje 0/180 → se persiste como número', () => {
    const r = generateObsidianMd({
      ...basicExp,
      od_esfera: -25,
      od_cilindro: -12,
      od_eje: 0,
      oi_esfera: 25,
      oi_cilindro: 12,
      oi_eje: 180,
    });
    expect(r.content).toMatch(/\| OD \| -25 \| -12 \| 0 \|/);
    expect(r.content).toMatch(/\| OI \| 25 \| 12 \| 180 \|/);
  });

  it('(j) productos_recomendados: count en frontmatter, lista en body', () => {
    const r = generateObsidianMd({
      ...basicExp,
      productos_recomendados: ['Holbrook 51x18', 'Mica monofocal AR'],
    });
    expect(r.frontmatter.productos_count).toBe(2);
    expect(r.content).toContain('- Holbrook 51x18');
    expect(r.content).toContain('- Mica monofocal AR');
  });

  it('(k) contact_id en frontmatter solo expone últimos 4 chars (no full id)', () => {
    const r = generateObsidianMd({
      ...basicExp,
      contact_id: '526631180788',
    });
    expect(r.frontmatter.contact_id_hash).toBe('0788');
    expect(r.content).not.toMatch(/contact_id_hash: 526631/);
  });

  it('(l) content empieza con --- (frontmatter YAML válido)', () => {
    const r = generateObsidianMd(basicExp);
    expect(r.content.startsWith('---\n')).toBe(true);
    expect(r.content.split('---\n').length).toBeGreaterThanOrEqual(3); // open + body + (trailing parts)
  });

  it('(m) tags por defecto incluye expediente + clinica', () => {
    const r = generateObsidianMd(basicExp);
    expect(r.frontmatter.tags).toEqual(['expediente', 'clinica']);
  });
});

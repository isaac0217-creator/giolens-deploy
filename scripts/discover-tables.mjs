#!/usr/bin/env node
/**
 * GIOCORE Frente H · Delta D2 — Discovery de tablas reales para snapshot-daily.
 *
 * Lee DATABASE_URL desde .env.local, conecta a Supabase Postgres, lista todas
 * las tablas REGULARES (relkind='r') del schema `public` excluyendo
 * materialized views (relkind='m'), pg_tables internas, y vistas (relkind='v').
 *
 * Output: `agents/_shared/backups/tables-manifest.json` (lista canónica).
 *
 * Uso:
 *   node --env-file=.env.local scripts/discover-tables.mjs
 *   # o con npm script (ver package.json:scripts.discover-tables)
 *
 * Cuando agregamos/renombramos tablas, re-correr y commitear el JSON.
 *
 * Acceptance criteria delta D2:
 *   - Snapshot SOLO las tablas reales (no las del wishlist hardcodeadas).
 *   - Loguear ausentes vs. expected con severity=0.3 (info, no warning).
 *   - Filtrar relkind='r' (excluye matviews).
 */

import pg from 'pg';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const { Client } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(__dirname, '../agents/_shared/backups/tables-manifest.json');

/** Tablas ESPERADAS según el brief Frente H (referencia, no autoridad). */
const EXPECTED_TABLES = [
  'contacts',
  'productos',
  'expedientes',
  'productos_movimientos',
  'agent_decisions',
  'meta_metrics',
  'provider_usage',
  'auth_tokens',
  'app_config',
];

/**
 * Query Postgres para listar tablas REALES del schema public.
 *
 * Filtros:
 *   - relkind='r' → tablas regulares (excluye 'm' matview, 'v' view, 'i' index).
 *   - n.nspname='public' → schema público (excluye pg_catalog, supabase_* internos).
 *   - NOT relname LIKE 'pg_%' → defensivo contra tablas system.
 *
 * Devuelve metadata útil para auditoría:
 *   - row_estimate (reltuples): conteo aproximado de filas según pg_class
 *   - has_id_col: si tiene columna `id` (para usar como order en paginación).
 *   - has_key_col: si tiene columna `key` (fallback para tablas como app_config).
 */
/**
 * Query Postgres para listar tablas REALES + detectar PK dinámicamente.
 *
 * Pre-fix: discovery v1 buscaba columnas literales `id`/`key`/`created_at`.
 *   Bug encontrado: `productos` tiene PK=`slug` (TEXT), no `id` → snapshot
 *   default a `id` order y Postgres devuelve 42703.
 *
 * Fix: detectamos la PK real de cada tabla y la usamos como order_column.
 *   Fallback: si la tabla no tiene PK, fallback a `created_at` (timestamp más
 *   antiguo común) o NULL (paginar sin order, no recomendado).
 */
const QUERY = `
  WITH pk AS (
    SELECT
      c.oid AS rel_oid,
      string_agg(a.attname, ',' ORDER BY x.idx) AS pk_columns
    FROM pg_class c
    JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
    CROSS JOIN LATERAL unnest(i.indkey::int[]) WITH ORDINALITY AS x(att, idx)
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = x.att
    GROUP BY c.oid
  )
  SELECT
    c.relname AS table_name,
    c.reltuples::BIGINT AS row_estimate,
    pk.pk_columns,
    EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = c.oid AND a.attname = 'created_at' AND a.attnum > 0 AND NOT a.attisdropped
    ) AS has_created_at_col
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pk ON pk.rel_oid = c.oid
  WHERE c.relkind = 'r'
    AND n.nspname = 'public'
    AND c.relname NOT LIKE 'pg_%'
  ORDER BY c.relname ASC;
`;

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('ERROR: DATABASE_URL no está en el entorno.');
    console.error('Run with: node --env-file=.env.local scripts/discover-tables.mjs');
    process.exit(1);
  }

  // Supabase Postgres usa SSL por default; permitimos self-signed (Supabase pooler).
  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
  });

  console.log('→ Conectando a Postgres…');
  await client.connect();

  console.log('→ Ejecutando discovery (relkind=r, schema=public)…');
  const { rows } = await client.query(QUERY);
  await client.end();

  console.log(`→ ${rows.length} tablas encontradas.`);

  // Determinar order_column por tabla:
  //   1. PK real (puede ser 'id', 'slug', 'key', etc. — detectado en query).
  //      Si PK es compuesta (ej. 'a,b'), usamos sólo la primera columna.
  //   2. fallback 'created_at' si no hay PK.
  //   3. null si nada — paginar sin order (no recomendado).
  const tables = rows.map((r) => {
    let orderCol = null;
    if (r.pk_columns) orderCol = r.pk_columns.split(',')[0];
    else if (r.has_created_at_col) orderCol = 'created_at';
    return {
      name: r.table_name,
      row_estimate: Number(r.row_estimate),
      pk_columns: r.pk_columns ?? null,
      order_column: orderCol,
      in_brief_h: EXPECTED_TABLES.includes(r.table_name),
    };
  });

  // Diff vs expected
  const realNames = tables.map((t) => t.name);
  const missingFromReal = EXPECTED_TABLES.filter((t) => !realNames.includes(t));
  const extraInReal = realNames.filter((t) => !EXPECTED_TABLES.includes(t));

  const manifest = {
    generated_at: new Date().toISOString(),
    schema: 'public',
    filter: 'relkind=r (excluye matviews, views, indexes)',
    total_tables: tables.length,
    expected_per_brief_h: EXPECTED_TABLES.length,
    missing_from_brief_h: missingFromReal,
    extra_in_db: extraInReal,
    tables,
  };

  // Imprimir resumen humano-legible
  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log('  GIOCORE · tables-manifest discovery summary');
  console.log('═══════════════════════════════════════════════');
  console.log(`Tablas en DB:                ${tables.length}`);
  console.log(`Esperadas (brief H):         ${EXPECTED_TABLES.length}`);
  console.log(`Faltan vs. brief:            ${missingFromReal.length} ${
    missingFromReal.length > 0 ? '→ ' + missingFromReal.join(', ') : ''
  }`);
  console.log(`Extras (no en brief):        ${extraInReal.length} ${
    extraInReal.length > 0 ? '→ ' + extraInReal.join(', ') : ''
  }`);
  console.log('');
  console.log('Listado completo:');
  for (const t of tables) {
    const flag = t.in_brief_h ? '✓ brief-H' : '  (extra)';
    console.log(`  ${flag}  ${t.name.padEnd(28)} ~${t.row_estimate} rows  order=${t.order_column ?? 'NONE'}`);
  }

  // Escribir manifest
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  console.log('');
  console.log(`→ Escrito ${OUTPUT_PATH}`);
  console.log('→ Próximo paso: revisar, commitear, y deploy.');
}

main().catch((err) => {
  console.error('ERROR durante discovery:', err.message);
  console.error(err.stack);
  process.exit(2);
});

#!/usr/bin/env node
/**
 * GIOCORE · Utility de inspección de schema de tabla Postgres.
 *
 * Útil cuando el discovery (`scripts/discover-tables.mjs`) reporta una tabla
 * sin PK conocida o con order_column NULL, y querés ver columnas + PK reales.
 *
 * Uso:
 *   node --env-file=.env.local scripts/inspect-table.mjs <table_name>
 *
 * Ejemplos:
 *   node --env-file=.env.local scripts/inspect-table.mjs productos
 *   node --env-file=.env.local scripts/inspect-table.mjs app_config
 */
import pg from 'pg';

const table = process.argv[2];
if (!table) {
  console.error('Usage: node inspect-table.mjs <table>');
  process.exit(1);
}

const c = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();

const cols = await c.query(
  `SELECT column_name, data_type, is_nullable, column_default
   FROM information_schema.columns
   WHERE table_schema='public' AND table_name=$1
   ORDER BY ordinal_position;`,
  [table],
);

const pk = await c.query(
  `SELECT a.attname AS col
   FROM pg_index i
   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
   WHERE i.indrelid = $1::regclass AND i.indisprimary;`,
  [`public.${table}`],
);

console.log(`\n== ${table} ==`);
console.log('Columns:');
cols.rows.forEach((r) =>
  console.log(
    `  ${r.column_name.padEnd(30)} ${r.data_type}  null=${r.is_nullable}  default=${
      r.column_default ?? ''
    }`,
  ),
);
console.log(`PK: ${pk.rows.map((r) => r.col).join(', ') || '(none)'}`);
await c.end();

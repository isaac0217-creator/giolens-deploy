# Patrón para crear índices en migrations

> Cierra **G-11** del `BACKLOG_G.md`. Estándar de proceso para decidir entre
> `CREATE INDEX` transaccional y `CREATE INDEX CONCURRENTLY` en este repo.
> El runner de migrations Supabase es **transaccional por default**, así que la
> decisión también determina *dónde* corre la migration (runner vs `psql` manual).

---

## Regla rápida

| Situación de la tabla | Sintaxis | Dónde corre |
|---|---|---|
| Pequeña (< ~10k filas) o recién creada, sin tráfico de escritura concurrente | `CREATE INDEX IF NOT EXISTS` dentro de `BEGIN/COMMIT` | Runner automático |
| Caliente / grande (> ~10k filas) o prod LIVE con escrituras concurrentes | `CREATE INDEX CONCURRENTLY IF NOT EXISTS` **fuera de transacción** | `psql` manual, archivo separado |

El umbral de 10k es una heurística: lo que importa es si un lock exclusivo de
escritura durante el build del índice causaría downtime perceptible. En una tabla
nueva sin tráfico, el lock dura milisegundos y no se nota.

---

## Cuándo NO usar CONCURRENTLY (caso por default)

Tabla pequeña o recién nacida, migration normal envuelta en `BEGIN/COMMIT`.
`CREATE INDEX` toma un lock `SHARE` que bloquea escrituras hasta terminar, pero
sobre pocas filas eso es instantáneo. Es atómico y reversible — si la migration
falla, el `ROLLBACK` deja todo limpio.

```sql
-- Ejemplo real: migrations/014_citas_indexes.sql
-- (tabla `citas` recién creada → lock irrelevante)
CREATE INDEX IF NOT EXISTS idx_citas_fecha_estado
  ON citas(fecha DESC, estado);
```

Ventajas: corre en el runner automático, es atómico, idempotente con `IF NOT EXISTS`.

---

## Cuándo SÍ usar CONCURRENTLY (tabla caliente / grande / prod live)

Si la tabla tiene cientos de miles de filas y recibe escrituras, un
`CREATE INDEX` bloqueante congela los `INSERT/UPDATE/DELETE` durante todo el
build → downtime de escritura. `CREATE INDEX CONCURRENTLY` construye el índice
con un scan en segundo plano **sin lock exclusivo de escritura**.

```sql
-- Ejemplo real: migrations/016_idx_movimientos_concurrently.sql
-- ⚠️ EJECUTAR FUERA DE TRANSACCIÓN — aplicar manualmente con psql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_movimientos_salida_fecha
    ON productos_movimientos(created_at DESC)
    WHERE tipo = 'salida';

-- Rollback manual:
-- DROP INDEX CONCURRENTLY IF EXISTS idx_movimientos_salida_fecha;
```

### Reglas obligatorias para una migration CONCURRENTLY

1. **Archivo separado, sin `BEGIN/COMMIT`.** `CONCURRENTLY` no puede correr dentro
   de un bloque transaccional (ver anti-patrón abajo).
2. **Header de advertencia** indicando que se aplica a mano, fuera del runner:
   ```
   -- ⚠️ EJECUTAR FUERA DE TRANSACCIÓN
   -- ⚠️ NO incluir en migrations runner Supabase (transaccional por default)
   -- ⚠️ Aplicar manualmente:
   --     psql "$DATABASE_URL" -v ON_ERROR_STOP=0 -f migrations/0NN_*.sql
   ```
3. **Idempotencia con `IF NOT EXISTS`** — re-correr no debe fallar.
4. **Rollback comentado al final** (`DROP INDEX CONCURRENTLY IF EXISTS ...`).
5. **No correr dos CONCURRENTLY en paralelo sobre la misma tabla** — el segundo
   queda en espera.
6. **Si falla a mitad** (ej. violación de unicidad), Postgres deja un *invalid
   index*: hay que `DROP INDEX` y reintentar. Verificar con
   `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;`.

---

## Anti-patrón: CONCURRENTLY dentro de una transacción

```sql
-- ❌ FALLA: "CREATE INDEX CONCURRENTLY cannot run inside a transaction block"
BEGIN;
CREATE INDEX CONCURRENTLY idx_foo ON foo(bar);
COMMIT;
```

Como el runner de migrations envuelve cada archivo en una transacción, meter un
`CONCURRENTLY` ahí aborta la migration entera. Por eso estas migrations van en
archivo aparte y se aplican con `psql` manualmente.

---

## Referencias en este repo

| Migration | Patrón | Razón |
|---|---|---|
| `migrations/014_citas_indexes.sql` | `CREATE INDEX` (transaccional) | `citas` recién creada, lock irrelevante |
| `migrations/016_idx_movimientos_concurrently.sql` | `CONCURRENTLY` fuera de tx | índice parcial sobre `productos_movimientos` |
| `migrations/018_citas_indexes_concurrently.sql` | `CONCURRENTLY` fuera de tx | re-creación de los 4 índices de 014 sin downtime futuro |

La migration 018 es el ejemplo canónico de re-crear índices ya existentes de
forma no-bloqueante (DROP de los no-CONCURRENTLY + CREATE CONCURRENTLY,
idempotente). Su header documenta las mismas reglas listadas arriba.

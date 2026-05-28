-- ============================================================
-- Frente G · Backlog P2 · G-11
-- Migration 018 · Re-creación CONCURRENTLY de los 4 índices de 014
-- ============================================================
--
-- ⚠️ EJECUTAR FUERA DE TRANSACCIÓN
-- ⚠️ NO incluir en migrations runner Supabase (transaccional por default)
-- ⚠️ Aplicar manualmente:
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=0 -f migrations/018_citas_indexes_concurrently.sql
--
-- Contexto: migration 014 creó 4 índices sin CONCURRENTLY. En tabla pequeña
-- OK (citas recién nacida); pero si en el futuro la tabla crece a cientos
-- de miles de filas y hay que re-crear los índices (ej. cambio de strategy,
-- repair, REINDEX), el CREATE INDEX bloqueante puede causar downtime de
-- escritura.
--
-- Esta migration:
--   1. DROP IF EXISTS de los 4 índices no-CONCURRENTLY (si están).
--   2. CREATE INDEX CONCURRENTLY IF NOT EXISTS — no bloquea writes durante
--      el build (scan completo en segundo plano, valida sin lock exclusivo).
--   3. Idempotente: si los 4 índices CONCURRENTLY ya existen, no falla.
--
-- IMPORTANTE: CREATE INDEX CONCURRENTLY:
--   - No puede correr dentro de un BLOCK (BEGIN...COMMIT).
--   - No puede correr en paralelo sobre la misma tabla — si otro
--     CONCURRENTLY ya corre, este queda waiting.
--   - Si falla a mitad (ej. constraint violation), deja un "invalid index";
--     hay que DROP INDEX y reintentar.
-- ============================================================

-- Paso 1: DROP IF EXISTS de la versión no-CONCURRENTLY (idempotente).
-- Nota: DROP INDEX permite CONCURRENTLY también, pero solo si no hay otros
-- objetos dependientes; aquí no hay FK ni RLS sobre estos índices.
DROP INDEX CONCURRENTLY IF EXISTS idx_citas_fecha_estado;
DROP INDEX CONCURRENTLY IF EXISTS idx_citas_optometrista_fecha;
DROP INDEX CONCURRENTLY IF EXISTS idx_citas_estado_updated_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_citas_paciente_hash_estado;

-- Paso 2: CREATE INDEX CONCURRENTLY — re-creación sin lock exclusivo.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_citas_fecha_estado
    ON citas(fecha DESC, estado);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_citas_optometrista_fecha
    ON citas(optometrista, fecha DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_citas_estado_updated_at
    ON citas(estado, updated_at DESC)
    WHERE estado != 'cancelada';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_citas_paciente_hash_estado
    ON citas(paciente_hash, estado);

-- ─── ROLLBACK MANUAL (descomentar) ───
-- DROP INDEX CONCURRENTLY IF EXISTS idx_citas_fecha_estado;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_citas_optometrista_fecha;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_citas_estado_updated_at;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_citas_paciente_hash_estado;
-- -- Luego re-aplicar 014_citas_indexes.sql si quiere volver al estado previo.

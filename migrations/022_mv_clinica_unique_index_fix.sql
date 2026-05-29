-- ============================================================
-- Hot-fix · Frente I.2 · UNIQUE INDEX sobre columna real para
--          REFRESH MATERIALIZED VIEW CONCURRENTLY
--
-- Bug detectado sesión 7B/8 (confirmado en prod):
--   refresh_mv_analitica_clinica() fallaba con
--     ERROR: cannot refresh materialized view ... concurrently
--     HINT:  Create a unique index ... on one or more columns of the matview.
--
-- Causa raíz: migration 019 creó el índice singleton sobre la EXPRESIÓN
--   constante `((1))`. Postgres NO acepta índices de expresión (ni con
--   WHERE) para REFRESH ... CONCURRENTLY: exige un índice único sobre
--   COLUMNA(S) reales de la matview. Recrear el mismo `((1))` (como sugería
--   el sketch original) sería un no-op y el bug persistiría.
--
-- Fix: índice único sobre la columna real `refreshed_at`. La matview es
--   singleton (siempre 1 fila, sin GROUP BY) → unicidad trivialmente
--   garantizada. Esto sí satisface el requisito de Postgres.
--
-- Aplica DESPUÉS de: 019_analitica_clinica.sql
-- Idempotente: DROP IF EXISTS + CREATE. El nombre del índice se conserva
--   (uq_mv_clinica_singleton) para no romper referencias.
-- ============================================================

BEGIN;

DROP INDEX IF EXISTS uq_mv_clinica_singleton;

CREATE UNIQUE INDEX uq_mv_clinica_singleton
    ON mv_analitica_clinica (refreshed_at);

COMMIT;

-- Smoke (ejecutar aparte, NO dentro de tx — REFRESH CONCURRENTLY no admite tx):
--   SELECT refresh_mv_analitica_clinica();
-- Debe retornar void sin error tras esta migration.

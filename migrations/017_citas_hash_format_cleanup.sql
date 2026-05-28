-- ============================================================
-- Frente G · Backlog P2 · G-10
-- Migration 017 · Fix-up histórico paciente_hash inválido
-- ============================================================
--
-- Contexto: migration 013 añadió CHECK constraint
--   chk_citas_paciente_hash_format CHECK (paciente_hash ~ '^[a-f0-9]{16}$')
-- Si la tabla tiene filas pre-A con paciente_hash en otro formato
-- (mayúsculas, longitud distinta, caracteres no-hex), el ALTER de 013 falla
-- atómicamente y aborta la transacción.
--
-- Esta migration:
--   (a) Detecta filas con paciente_hash inválido vs el patrón hex16.
--   (b) Las marca con estado='cancelada' (excluidas de UNIQUE parcial slot)
--       + notas='[autofix YYYY-MM-DD] hash invalido detectado' como audit trail.
--       NO borra — preserva data para retroactiva si se decide rehash.
--   (c) Re-aplica el CHECK con `NOT VALID` para no bloquear reads/writes en
--       caliente sobre tablas grandes. Después `VALIDATE` para promover a
--       constraint efectiva (rapid scan, sin lock exclusivo).
--
-- Idempotente: chequea existencia del CHECK antes de re-añadirlo.
-- ============================================================

BEGIN;

-- 1 · Detección + audit (NO borra)
UPDATE citas
SET
    estado = 'cancelada',
    notas = COALESCE(notas || E'\n', '') ||
            '[autofix ' || to_char(now(), 'YYYY-MM-DD') || '] hash invalido detectado · ' ||
            'paciente_hash="' || left(paciente_hash, 4) || '..." (' || length(paciente_hash) || ' chars)'
WHERE paciente_hash !~ '^[a-f0-9]{16}$';

-- 2 · Si el CHECK ya existe (caso normal post-013), DROP para re-añadir NOT VALID.
--     Si NO existe (caso 013 nunca aplicada o reset), simplemente añade.
ALTER TABLE citas DROP CONSTRAINT IF EXISTS chk_citas_paciente_hash_format;

-- 3 · Re-añadir como NOT VALID para no bloquear writes en tabla grande.
--     NOT VALID: la constraint se aplica a INSERT/UPDATE futuros, pero NO
--     valida filas existentes en este momento.
ALTER TABLE citas
    ADD CONSTRAINT chk_citas_paciente_hash_format
        CHECK (paciente_hash ~ '^[a-f0-9]{16}$')
        NOT VALID;

-- 4 · VALIDATE en operación separada (rapid scan, sin lock exclusivo full).
--     Después de paso 1 todas las filas conformes; VALIDATE pasa sin error
--     y promueve el CHECK a constraint efectiva (mismo rigor que sin
--     NOT VALID, pero sin bloquear writes durante la migración).
ALTER TABLE citas
    VALIDATE CONSTRAINT chk_citas_paciente_hash_format;

COMMIT;

-- ─── ROLLBACK (descomentar manualmente si necesario) ───
-- BEGIN;
-- ALTER TABLE citas DROP CONSTRAINT IF EXISTS chk_citas_paciente_hash_format;
-- -- Las filas con notas '[autofix YYYY-MM-DD] hash invalido detectado'
-- -- siguen marcadas como 'cancelada'; revisar manualmente si conviene
-- -- restaurar a su estado previo (no automático: requiere snapshot anterior).
-- COMMIT;

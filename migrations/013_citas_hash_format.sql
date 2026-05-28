-- Migration: 013_citas_hash_format.sql
-- Blocker A-4: Validar formato del hash del paciente
-- Añade CHECK constraint para garantizar que paciente_hash sea 16 caracteres hexadecimales
-- Formato esperado: SHA256(email|telefono)[:16] = 16 hex chars

ALTER TABLE citas
  ADD CONSTRAINT chk_citas_paciente_hash_format
    CHECK (
      paciente_hash ~ '^[a-f0-9]{16}$'
    );

COMMENT ON CONSTRAINT chk_citas_paciente_hash_format ON citas IS
  'A-4: Valida que paciente_hash sea exactamente 16 caracteres hexadecimales (0-9, a-f).
   Formato esperado: SHA256(email|telefono)[:16]
   PostgreSQL lanza error 23514 si intenta INSERT/UPDATE que viole.';

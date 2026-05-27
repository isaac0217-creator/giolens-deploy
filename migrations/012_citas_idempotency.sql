-- Migration: 012_citas_idempotency.sql
-- Blocker A-4: Implementar idempotencia en envíos Wapify
-- Añade columna confirmacion_enviada_at para rastrear cuándo se envió confirmación
-- Previene envíos duplicados verificando si confirmacion_enviada_at != NULL

ALTER TABLE citas
  ADD COLUMN confirmacion_enviada_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN citas.confirmacion_enviada_at IS
  'A-4: Timestamp cuando se envió confirmación de cita a Wapify.
   NULL = pendiente. NOT NULL = ya enviada.
   Previene duplicate sends en retry loops.';

-- Índice para queries que filtran por "no enviadas"
CREATE INDEX IF NOT EXISTS idx_citas_confirmacion_no_enviada
  ON citas(confirmacion_enviada_at)
  WHERE confirmacion_enviada_at IS NULL;

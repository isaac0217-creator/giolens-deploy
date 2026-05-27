-- Migration: 011_citas_unique_slot.sql
-- Blocker A-2: Prevenir race conditions en reserva de slots de citas
-- Implementa UNIQUE INDEX en (fecha, hora, optometrista) para garantizar
-- que dos citas no pueden ocupar el mismo slot simultáneamente.

-- Nota: El índice permite NULLs, pero la tabla nunca debería tener NULLs
-- en estas columnas (son NOT NULL en la definición original).

CREATE UNIQUE INDEX IF NOT EXISTS idx_citas_slot_unique
  ON citas(fecha, hora, optometrista)
  WHERE estado != 'cancelada';

COMMENT ON INDEX idx_citas_slot_unique IS
  'A-2: Evita que dos citas (no-canceladas) ocupen el mismo slot (fecha, hora, optometrista).
   PostgreSQL lanza error 23505 (unique_violation) si intenta INSERT/UPDATE que viole.';

-- Migration: 014_citas_indexes.sql
-- Blocker A-4: Optimizar índices para queries GET de paginación
-- Crea índices compuestos para queries frecuentes de lectura/filtrado

-- Composite index: fecha + estado (filtros comunes en GET list)
CREATE INDEX IF NOT EXISTS idx_citas_fecha_estado
  ON citas(fecha DESC, estado);

COMMENT ON INDEX idx_citas_fecha_estado IS
  'A-4: Optimiza GET list queries filtrando por fecha rango + estado.
   Ordering DESC en fecha para "citas más recientes primero".';

-- Composite index: optometrista + fecha (appointments por profesional)
CREATE INDEX IF NOT EXISTS idx_citas_optometrista_fecha
  ON citas(optometrista, fecha DESC);

COMMENT ON INDEX idx_citas_optometrista_fecha IS
  'A-4: Optimiza queries de citas por optometrista + ordenadas por fecha desc.
   Permite LIMIT/OFFSET paginación eficiente en GET schedule.';

-- Composite index: estado + updated_at DESC (para audit trail, cambios recientes)
CREATE INDEX IF NOT EXISTS idx_citas_estado_updated_at
  ON citas(estado, updated_at DESC)
  WHERE estado != 'cancelada';

COMMENT ON INDEX idx_citas_estado_updated_at IS
  'A-4: Optimiza queries de cambios recientes (audit, sync).
   WHERE estado != cancelada para skip histórico eliminado.';

-- Single index on paciente_hash + estado (customer view)
CREATE INDEX IF NOT EXISTS idx_citas_paciente_hash_estado
  ON citas(paciente_hash, estado);

COMMENT ON INDEX idx_citas_paciente_hash_estado IS
  'A-4: Optimiza queries "mis citas" filtrando por paciente_hash + estado.
   Permite ver activas vs canceladas vs realizadas rápidamente.';

-- Migración 010 · Frente G · Citas + Calendar Sync
-- Fecha: 2026-05-26
-- Prerequisito: tablas expedientes ✅ (FK confirmada en T2)
--
-- Resultado de inventario T2:
--   - tabla `pacientes`     NO existe → usar paciente_hash TEXT (patrón EXP)
--   - tabla `optometristas` NO existe → optometrista TEXT libre (igual que expedientes)
--   - tabla `usuarios`      NO existe → sin FK de usuario
--   - tabla `contacts`      EXISTS    → opcional: contact_id TEXT nullable
--   - FK válida: expedientes.id BIGINT ✅
--
-- GATED: ejecutar solo después de aprobación G-1 + G-2 + G-3 por Isaac.
-- Aplicar primero en staging, luego prod (Supabase Dashboard > SQL Editor).

CREATE TABLE IF NOT EXISTS citas (
  id              BIGSERIAL PRIMARY KEY,
  fecha           DATE        NOT NULL,
  hora            TIME        NOT NULL,
  duracion_min    INT         DEFAULT 30,
  paciente_hash   TEXT        NOT NULL,       -- SHA256(email|telefono)[:16] — mismo patrón EXP
  optometrista    TEXT,                        -- nombre libre, mismo patrón campo en expedientes
  tipo_consulta   TEXT        CHECK (tipo_consulta IN (
                    'revision_visual',
                    'contactologia',
                    'entrega_producto',
                    'seguimiento'
                  )),
  estado          TEXT        DEFAULT 'agendada' CHECK (estado IN (
                    'agendada',
                    'confirmada',
                    'cancelada',
                    'realizada'
                  )),
  notas           TEXT,
  gcal_event_id   TEXT,                        -- ID evento Google Calendar (nullable hasta sync)
  expediente_id   BIGINT      REFERENCES expedientes(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Índices de consulta frecuente
CREATE INDEX IF NOT EXISTS idx_citas_fecha         ON citas(fecha);
CREATE INDEX IF NOT EXISTS idx_citas_estado        ON citas(estado);
CREATE INDEX IF NOT EXISTS idx_citas_paciente_hash ON citas(paciente_hash);

-- Trigger updated_at automático
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_citas_updated_at
  BEFORE UPDATE ON citas
  FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

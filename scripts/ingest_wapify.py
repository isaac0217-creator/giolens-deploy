#!/usr/bin/env python3
"""ingest_wapify.py — ingesta Wapify → SQLite + expedientes Obsidian.

ARQUITECTURA 50K · FASE 4 · ESQUEMA LISTO — la ingesta real NO se ha ejecutado.
Por defecto corre en DRY-RUN (no escribe nada). Ingesta real: flag --apply.

Capas (3 temperaturas):
  - FRÍA  (raw)   : data/giocore.db          SQLite · gitignored · NOM-024 local-only
  - CALIENTE      : 10_PACIENTES/activos/    expedientes .md · gitignored
  - TEMPLADA      : 13_INTERACCIONES/resumen-semanal/YYYY-WW.md

Privacidad NOM-024:
  - SQLite y 10_PACIENTES/ y 13_INTERACCIONES/ están gitignored (no se versionan).
  - El frontmatter del expediente NO lleva PII (solo pipeline/stage/contadores).
  - nombre y teléfono viven en el cuerpo del .md y en SQLite (ambos local-only).

Uso:
    python3 scripts/ingest_wapify.py                 # DRY-RUN (default · no escribe)
    python3 scripts/ingest_wapify.py --init-db       # solo crea el esquema SQLite vacío
    python3 scripts/ingest_wapify.py --apply         # ingesta REAL (requiere WAPIFY_TOKEN)

Cron de ejemplo (diario 6:00am · antes de render_reports.py):
    0 6 * * *  VAULT_ROOT="$HOME/Documents/Claude/OBSIDIAN/GIOCORE" \\
      /usr/bin/python3 "$HOME/giolens_deploy/scripts/ingest_wapify.py" --apply \\
      >> "$HOME/Library/Logs/giocore-ingest-wapify.log" 2>&1
"""
import json
import os
import re
import sqlite3
import sys
import unicodedata
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# ─── Config ───────────────────────────────────────────────────────────────────
VAULT = Path(os.environ.get(
    'VAULT_ROOT', str(Path.home() / 'Documents/Claude/OBSIDIAN/GIOCORE'))).expanduser()
DB_PATH = VAULT / 'data' / 'giocore.db'
PACIENTES = VAULT / '10_PACIENTES' / 'activos'
RESUMENES = VAULT / '13_INTERACCIONES' / 'resumen-semanal'

WAPIFY_BASE = 'https://ap.whapify.ai/api'
ACCOUNT_ID = os.environ.get('WAPIFY_ACCOUNT_ID', '1187373')
PIPELINES = ['216977', '755062', '252999', '94103', '273944']

# ─── Esquema SQLite (capa fría / raw) ─────────────────────────────────────────
SCHEMA = """
CREATE TABLE IF NOT EXISTS contactos (
    id                  TEXT PRIMARY KEY,
    nombre              TEXT,
    telefono            TEXT,
    pipeline_id         TEXT,
    stage_id            TEXT,
    primera_interaccion TEXT,
    ultima_interaccion  TEXT,
    total_interacciones INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS interacciones (
    id           TEXT PRIMARY KEY,
    contacto_id  TEXT REFERENCES contactos(id),
    fecha        TEXT,
    canal        TEXT,
    tipo         TEXT,
    contenido    TEXT,
    pipeline_id  TEXT,
    stage_id     TEXT
);

CREATE INDEX IF NOT EXISTS idx_inter_contacto ON interacciones(contacto_id);
CREATE INDEX IF NOT EXISTS idx_inter_fecha    ON interacciones(fecha);
CREATE INDEX IF NOT EXISTS idx_cont_pipeline  ON contactos(pipeline_id);
"""


def load_token():
    """WAPIFY_TOKEN desde env, o de ~/giolens_deploy/.env.local (solo esa línea)."""
    if os.environ.get('WAPIFY_TOKEN'):
        return os.environ['WAPIFY_TOKEN']
    env = Path.home() / 'giolens_deploy' / '.env.local'
    if env.exists():
        for line in env.read_text(encoding='utf-8').splitlines():
            if line.startswith('WAPIFY_TOKEN='):
                return line.split('=', 1)[1].strip().strip('"').strip("'")
    return ''


def init_db(conn):
    """Crea las tablas e índices si no existen."""
    conn.executescript(SCHEMA)
    conn.commit()


def slugify(value):
    """Nombre → slug seguro para nombre de archivo."""
    value = unicodedata.normalize('NFKD', str(value)).encode('ascii', 'ignore').decode()
    value = re.sub(r'[^\w\s-]', '', value).strip().lower()
    return re.sub(r'[\s_-]+', '-', value) or 'sin-nombre'


# ─── Cliente Wapify ───────────────────────────────────────────────────────────
def wapify_get(path, token):
    """GET autenticado a la API Wapify. Devuelve JSON dict/list."""
    req = urllib.request.Request(
        f'{WAPIFY_BASE}/{path}', headers={'X-ACCESS-TOKEN': token})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode('utf-8'))


def fetch_contactos(token):
    """Recorre los 5 pipelines y devuelve dicts de contacto desde opportunities."""
    contactos = {}
    for pid in PIPELINES:
        offset = 0
        for _ in range(50):  # cap de páginas
            data = wapify_get(
                f'pipelines/{pid}/opportunities?limit=100&offset={offset}', token)
            batch = data.get('data', []) if isinstance(data, dict) else []
            if not batch:
                break
            for opp in batch:
                cid = str(opp.get('contact_id') or '')
                if not cid:
                    continue
                contactos[cid] = {
                    'id': cid,
                    'pipeline_id': pid,
                    'stage_id': str((opp.get('stage') or {}).get('id') or ''),
                }
            offset += 100
            if len(batch) < 100:
                break
    return list(contactos.values())


def fetch_detalle_contacto(contacto_id, token):
    """Datos del contacto (nombre, teléfono) — endpoint contacts/{id}."""
    try:
        return wapify_get(f'contacts/{contacto_id}', token) or {}
    except Exception:  # noqa: BLE001
        return {}


def fetch_interacciones(contacto_id, token):
    """Mensajes/interacciones de un contacto — endpoint contacts/{id}/messages."""
    try:
        data = wapify_get(f'contacts/{contacto_id}/messages?limit=200', token)
        return data.get('data', []) if isinstance(data, dict) else (data or [])
    except Exception:  # noqa: BLE001
        return []


# ─── Upserts SQLite ───────────────────────────────────────────────────────────
def upsert_contacto(conn, c):
    conn.execute("""
        INSERT INTO contactos
          (id, nombre, telefono, pipeline_id, stage_id,
           primera_interaccion, ultima_interaccion, total_interacciones)
        VALUES (:id, :nombre, :telefono, :pipeline_id, :stage_id,
                :primera_interaccion, :ultima_interaccion, :total_interacciones)
        ON CONFLICT(id) DO UPDATE SET
          nombre=excluded.nombre, telefono=excluded.telefono,
          pipeline_id=excluded.pipeline_id, stage_id=excluded.stage_id,
          primera_interaccion=excluded.primera_interaccion,
          ultima_interaccion=excluded.ultima_interaccion,
          total_interacciones=excluded.total_interacciones
    """, c)


def upsert_interaccion(conn, it):
    conn.execute("""
        INSERT INTO interacciones
          (id, contacto_id, fecha, canal, tipo, contenido, pipeline_id, stage_id)
        VALUES (:id, :contacto_id, :fecha, :canal, :tipo, :contenido,
                :pipeline_id, :stage_id)
        ON CONFLICT(id) DO UPDATE SET
          fecha=excluded.fecha, canal=excluded.canal, tipo=excluded.tipo,
          contenido=excluded.contenido, pipeline_id=excluded.pipeline_id,
          stage_id=excluded.stage_id
    """, it)


# ─── Renderers (capa caliente / templada) ─────────────────────────────────────
def render_expediente(conn, contacto_id):
    """Lee contacto + interacciones de SQLite → escribe 10_PACIENTES/activos/{slug}.md.

    Frontmatter SIN PII (NOM-024). nombre/teléfono solo en el cuerpo.
    """
    row = conn.execute("SELECT * FROM contactos WHERE id=?", (contacto_id,)).fetchone()
    if not row:
        return None
    cols = [d[0] for d in conn.execute("SELECT * FROM contactos LIMIT 0").description]
    c = dict(zip(cols, row))

    inter = conn.execute(
        "SELECT fecha, canal, tipo, contenido FROM interacciones "
        "WHERE contacto_id=? ORDER BY fecha DESC LIMIT 20", (contacto_id,)).fetchall()

    PACIENTES.mkdir(parents=True, exist_ok=True)
    slug = slugify(c.get('nombre') or contacto_id)
    fm = f"""---
tipo: expediente
contacto_id: {contacto_id}
pipeline_id: {c.get('pipeline_id', '')}
stage_id: {c.get('stage_id', '')}
total_interacciones: {c.get('total_interacciones', 0)}
primera_interaccion: {c.get('primera_interaccion', '')}
ultima_interaccion: {c.get('ultima_interaccion', '')}
db: data/giocore.db
tags: [expediente, pipeline/{c.get('pipeline_id', '')}]
---

# Expediente · {c.get('nombre', 'Sin nombre')}

- **Teléfono:** {c.get('telefono', '—')}
- **Pipeline:** {c.get('pipeline_id', '—')} · stage {c.get('stage_id', '—')}
- **Interacciones:** {c.get('total_interacciones', 0)}
- **Raw completo:** `data/giocore.db` → `interacciones WHERE contacto_id='{contacto_id}'`

## Últimas interacciones
"""
    body = ''.join(
        f"- {fecha} · {canal}/{tipo}: {str(contenido)[:120]}\n"
        for (fecha, canal, tipo, contenido) in inter) or "- (sin interacciones)\n"

    out = PACIENTES / f"{slug}.md"
    out.write_text(fm + body, encoding='utf-8')
    return out


def render_resumen_semanal(conn, semana):
    """semana = 'YYYY-WW'. Escribe 13_INTERACCIONES/resumen-semanal/{semana}.md."""
    RESUMENES.mkdir(parents=True, exist_ok=True)
    rows = conn.execute("""
        SELECT pipeline_id, COUNT(*) FROM interacciones
        WHERE strftime('%Y-%W', fecha) = ?
        GROUP BY pipeline_id
    """, (semana,)).fetchall()
    total = sum(n for _, n in rows)
    fm = f"""---
tipo: resumen-semanal
semana: {semana}
total_interacciones: {total}
generado: {datetime.now(timezone.utc).isoformat()}
---

# Resumen semanal · {semana}

- **Total interacciones:** {total}

## Por pipeline
"""
    body = ''.join(f"- {pid}: {n}\n" for pid, n in rows) or "- (sin datos)\n"
    out = RESUMENES / f"{semana}.md"
    out.write_text(fm + body, encoding='utf-8')
    return out


# ─── Main ─────────────────────────────────────────────────────────────────────
def main():
    args = sys.argv[1:]
    apply = '--apply' in args
    only_init = '--init-db' in args

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    init_db(conn)
    print(f"[ingest_wapify] esquema SQLite OK · {DB_PATH}")

    if only_init:
        conn.close()
        print("[ingest_wapify] --init-db: esquema creado, sin ingesta.")
        return 0

    token = load_token()
    if not apply:
        print("[ingest_wapify] DRY-RUN (no escribe expedientes ni interacciones).")
        print(f"  token presente: {'sí' if token else 'NO — poblar WAPIFY_TOKEN'}")
        print(f"  account_id: {ACCOUNT_ID} · pipelines: {len(PIPELINES)}")
        print("  para ingesta real: --apply")
        conn.close()
        return 0

    # ─── ingesta REAL (solo con --apply) ───
    if not token:
        print("[ingest_wapify] ABORT: --apply requiere WAPIFY_TOKEN.", file=sys.stderr)
        conn.close()
        return 1

    contactos = fetch_contactos(token)
    print(f"[ingest_wapify] {len(contactos)} contactos desde pipelines")
    for c in contactos:
        detalle = fetch_detalle_contacto(c['id'], token)
        inter = fetch_interacciones(c['id'], token)
        fechas = sorted(str(m.get('fecha') or m.get('created_at') or '') for m in inter)
        c.update({
            'nombre': detalle.get('first_name') or detalle.get('name') or '',
            'telefono': detalle.get('phone') or '',
            'primera_interaccion': fechas[0] if fechas else '',
            'ultima_interaccion': fechas[-1] if fechas else '',
            'total_interacciones': len(inter),
        })
        upsert_contacto(conn, c)
        for m in inter:
            upsert_interaccion(conn, {
                'id': str(m.get('id') or ''),
                'contacto_id': c['id'],
                'fecha': str(m.get('fecha') or m.get('created_at') or ''),
                'canal': m.get('channel') or 'whatsapp',
                'tipo': m.get('type') or '',
                'contenido': m.get('text') or m.get('content') or '',
                'pipeline_id': c['pipeline_id'],
                'stage_id': c['stage_id'],
            })
        conn.commit()
        render_expediente(conn, c['id'])

    semana = datetime.now(timezone.utc).strftime('%Y-%W')
    render_resumen_semanal(conn, semana)
    conn.close()
    print(f"[ingest_wapify] ingesta real completa · semana {semana}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

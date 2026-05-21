#!/usr/bin/env python3
"""
consolidate_contactos_index.py
Bloque 5 / ADR-03 — T3/T4

Genera 5 archivos INDEX_PIPELINE_<id>.md en
~/Documents/Claude/OBSIDIAN/GIOCORE/04_CONTACTOS/

Lee exclusivamente de data/giocore.db (SQLite, NOM-024 SoT).
NO escribe PII en frontmatter.
Es idempotente: cada corrida sobrescribe los 5 archivos completos;
solo el campo `generado` cambia entre corridas.

Stdlib pura Python 3.9+, sin dependencias externas.
"""

import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuración
# ---------------------------------------------------------------------------
DB_PATH = Path.home() / "Documents/Claude/OBSIDIAN/GIOCORE/data/giocore.db"
OUTPUT_DIR = Path.home() / "Documents/Claude/OBSIDIAN/GIOCORE/04_CONTACTOS"

PIPELINES = {
    "216977": "Justin Holbrook Litebeam",
    "755062": "GioSports",
    "252999": "SPY",
    "94103":  "Dama",
    "273944": "GioVision",
}

# Nombres de stage legibles (stage_id 1-9 genérico; ajustar si se mapean)
STAGE_LABELS = {
    "1": "Nuevo",
    "2": "Contactado",
    "3": "Calificado",
    "4": "Propuesta",
    "5": "Negociación",
    "6": "Cerrado-Ganado",
    "7": "Cerrado-Perdido",
    "8": "Nurturing",
    "9": "Inactivo",
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def now_utc_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def stage_label(stage_id: str) -> str:
    return STAGE_LABELS.get(str(stage_id), f"stage-{stage_id}")


def md_table(headers: list[str], rows: list[list]) -> str:
    """Render a simple Markdown table."""
    sep = "|".join(["---"] * len(headers))
    header_row = " | ".join(headers)
    lines = [f"| {header_row} |", f"| {sep} |"]
    for row in rows:
        lines.append("| " + " | ".join(str(c) for c in row) + " |")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def generate_index(
    cur: sqlite3.Cursor,
    pipeline_id: str,
    pipeline_nombre: str,
    generado: str,
) -> str:
    """Return the full Markdown content for one INDEX file."""

    # --- aggregate counts ---
    cur.execute(
        "SELECT COUNT(*), COALESCE(SUM(total_interacciones), 0) "
        "FROM contactos WHERE pipeline_id = ?",
        (pipeline_id,),
    )
    total_contactos, total_interacciones = cur.fetchone()

    # --- distribution by stage ---
    cur.execute(
        "SELECT stage_id, COUNT(*) as cnt "
        "FROM contactos WHERE pipeline_id = ? "
        "GROUP BY stage_id ORDER BY stage_id",
        (pipeline_id,),
    )
    stage_rows = cur.fetchall()

    # --- top 20 by last interaction (ultima_interaccion DESC, NULL last) ---
    cur.execute(
        """
        SELECT id, stage_id, total_interacciones,
               COALESCE(ultima_interaccion, '') as ui,
               COALESCE(primera_interaccion, '') as pi
        FROM contactos
        WHERE pipeline_id = ?
        ORDER BY
            CASE WHEN ultima_interaccion IS NULL OR ultima_interaccion = '' THEN 1 ELSE 0 END,
            ultima_interaccion DESC
        LIMIT 20
        """,
        (pipeline_id,),
    )
    top20_rows = cur.fetchall()

    # --- build frontmatter ---
    tags = f"[index-pipeline, pipeline-{pipeline_id}]"
    frontmatter = f"""\
---
tipo: index-pipeline
pipeline_id: "{pipeline_id}"
pipeline_nombre: "{pipeline_nombre}"
total_contactos: {total_contactos}
total_interacciones: {total_interacciones}
generado: "{generado}"
fuente: "data/giocore.db"
editable: false
tags: {tags}
---"""

    # --- Resumen section ---
    resumen = f"""\
## Resumen

| Campo | Valor |
|---|---|
| Pipeline | {pipeline_id} · {pipeline_nombre} |
| Total contactos | {total_contactos} |
| Total interacciones | {total_interacciones} |
| Generado (UTC) | {generado} |
| Fuente SoT | `data/giocore.db` |

> Archivo generado automáticamente por `consolidate_contactos_index.py`.
> **No editar manualmente** (`editable: false`)."""

    # --- Distribución por stage ---
    dist_table_rows = [
        [stage_id, stage_label(stage_id), cnt, f"{(cnt/total_contactos*100):.1f}%" if total_contactos else "0%"]
        for stage_id, cnt in stage_rows
    ]
    dist_section = "## Distribución por stage\n\n" + md_table(
        ["stage_id", "nombre_stage", "contactos", "pct"],
        dist_table_rows,
    )

    # --- Top 20 ---
    top20_table_rows = [
        [row[0], stage_label(row[1]), row[2], row[3] or "(sin dato)", row[4] or "(sin dato)"]
        for row in top20_rows
    ]
    top20_section = "## Top 20 contactos por última interacción\n\n" + (
        md_table(
            ["contacto_id", "stage", "interacciones", "ultima_interaccion", "primera_interaccion"],
            top20_table_rows,
        )
        if top20_table_rows
        else "_Sin contactos en este pipeline._"
    )

    # --- SQL hint ---
    sql_section = f"""\
## Consulta SQL de referencia

```sql
-- Todos los contactos de este pipeline:
SELECT id, stage_id, total_interacciones, primera_interaccion, ultima_interaccion
FROM contactos
WHERE pipeline_id = '{pipeline_id}'
ORDER BY ultima_interaccion DESC;

-- Interacciones de un contacto:
SELECT * FROM interacciones
WHERE pipeline_id = '{pipeline_id}'
ORDER BY fecha DESC;
```"""

    return "\n\n".join([frontmatter, resumen, dist_section, top20_section, sql_section]) + "\n"


def main() -> None:
    if not DB_PATH.exists():
        print(f"ERROR: no se encontró la base de datos en {DB_PATH}", file=sys.stderr)
        sys.exit(1)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    generado = now_utc_iso()

    conn = sqlite3.connect(str(DB_PATH))
    cur = conn.cursor()

    written = []
    total_sum = 0

    for pipeline_id, pipeline_nombre in PIPELINES.items():
        content = generate_index(cur, pipeline_id, pipeline_nombre, generado)
        out_path = OUTPUT_DIR / f"INDEX_PIPELINE_{pipeline_id}.md"
        out_path.write_text(content, encoding="utf-8")

        # Extract total_contactos from the generated content for verification
        m = re.search(r'^total_contactos:\s*(\d+)', content, re.MULTILINE)
        tc = int(m.group(1)) if m else 0
        total_sum += tc
        written.append((pipeline_id, pipeline_nombre, tc, str(out_path)))
        print(f"  WROTE: INDEX_PIPELINE_{pipeline_id}.md  ({tc} contactos)")

    conn.close()

    print(f"\nArchivos escritos: {len(written)}")
    print(f"Suma total_contactos: {total_sum}")

    # Verify against DB direct count
    conn2 = sqlite3.connect(str(DB_PATH))
    cur2 = conn2.cursor()
    cur2.execute("SELECT COUNT(*) FROM contactos")
    db_total = cur2.fetchone()[0]
    conn2.close()

    print(f"SELECT COUNT(*) FROM contactos: {db_total}")
    match = "OK" if total_sum == db_total else f"MISMATCH (diferencia: {db_total - total_sum})"
    print(f"Verificacion suma: {match}")

    if total_sum != db_total:
        # Contacts with NULL or unknown pipeline_id won't appear in any index
        conn3 = sqlite3.connect(str(DB_PATH))
        cur3 = conn3.cursor()
        known_ids = "','".join(PIPELINES.keys())
        cur3.execute(f"SELECT COUNT(*) FROM contactos WHERE pipeline_id NOT IN ('{known_ids}')")
        orphans = cur3.fetchone()[0]
        conn3.close()
        if orphans:
            print(f"  Nota: {orphans} contacto(s) tienen pipeline_id fuera del mapa — no incluidos en ningún INDEX.")


if __name__ == "__main__":
    main()

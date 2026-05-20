#!/usr/bin/env python3
"""Ingesta inventario EOPTIS (.xls HTML disfrazado) -> vault Obsidian.

Frente v17 · brief PROMPT_CODE_INGESTA_EOPTIS_v17.md.
Nombre con guion_bajo (no guion) para que sea importable desde el dry-run.
"""
import os, re, sys, hashlib
import pandas as pd
from pathlib import Path
from datetime import datetime

# CONFIG
SOURCE = Path(os.environ.get('EOPTIS_FILE',
    '/Users/chunkuni/giolens_deploy/data/eoptis_inventario_2026-05-20.xls'))
VAULT = Path(os.environ['VAULT_ROOT']).expanduser()  # expanduser: tolera "~" literal
INV_ROOT = VAULT / '12_INVENTARIO'

# Mapeo tipo producto -> carpeta + pipeline_link
CATEGORY_MAP = {
    'Armazones': {'folder': 'armazones', 'pipeline_link': None},
    'SOLARES': {'folder': 'solares', 'pipeline_link': None},
    'LENTES DE CONTACTO': {'folder': 'lentes-contacto', 'pipeline_link': None},
    'ESTUCHES LENTES DE CONTACTO': {'folder': 'lentes-contacto/estuches', 'pipeline_link': None},
    'SOLUCIONES': {'folder': 'lentes-contacto/soluciones', 'pipeline_link': None},
    'CLIP ON': {'folder': 'clip-on', 'pipeline_link': None},
    'DEPORTIVOS': {'folder': 'deportivos', 'pipeline_link': '755062-GioSports'},
    'SMART GLASSES': {'folder': 'smart-glasses', 'pipeline_link': '273944-GioVision'},
    'SEGURIDAD Z87': {'folder': 'seguridad-z87', 'pipeline_link': '252999-SPY'},
    'PUPILA NEGRA': {'folder': 'pupila-negra', 'pipeline_link': None},
    'PINZA Y COLOCADOR': {'folder': 'accesorios', 'pipeline_link': None},
    'NATACION': {'folder': 'accesorios/natacion', 'pipeline_link': None},
}

def sanitize_sku(sku):
    """SKU como nombre de archivo seguro."""
    return re.sub(r'[^\w\-]', '_', str(sku))

def safe(val, default=''):
    """Maneja NaN."""
    if pd.isna(val):
        return default
    return str(val).strip()

def build_md(row):
    """Genera (folder, sku, contenido_markdown) para 1 producto."""
    tipo = safe(row['Tipo producto'])
    cat = CATEGORY_MAP.get(tipo, {'folder': 'otros', 'pipeline_link': None})

    sku = safe(row['Clave'])
    desc = safe(row['Descripción'])
    marca = safe(row['Marca'])
    submarca = safe(row['Submarca'])
    stock = int(float(row['Existencia']) if not pd.isna(row['Existencia']) else 0)
    min_stock = int(float(row['Límite mínimo']) if not pd.isna(row['Límite mínimo']) else 0)
    max_stock = int(float(row['Límite máximo']) if not pd.isna(row['Límite máximo']) else 0)
    consign = safe(row['Consignación'], 'NO')
    estatus = safe(row['Estatus'], 'Activo')

    # Tags
    tags = ['inventario', f'categoria/{cat["folder"].split("/")[0]}',
            f'marca/{marca.lower().replace(" ", "-")}']
    if estatus == 'Baja':
        tags.append('deprecated')
    if stock == 0:
        tags.append('agotado')
    elif stock <= min_stock and min_stock > 0:
        tags.append('stock-bajo')
    if consign == 'SI':
        tags.append('consignacion')
    if cat['pipeline_link']:
        tags.append(f'pipeline/{cat["pipeline_link"].split("-")[0]}')

    # Frontmatter
    fm = f"""---
sku: {sku}
descripcion: "{desc.replace('"', "'")}"
tipo: {tipo}
marca: {marca}
submarca: {submarca}
stock: {stock}
limite_minimo: {min_stock}
limite_maximo: {max_stock}
consignacion: {consign}
estatus: {estatus}
fuente: EOPTIS
fecha_ingesta: {datetime.now().strftime('%Y-%m-%d')}
tags: {tags}
"""
    if cat['pipeline_link']:
        fm += f"pipeline_relacionado: \"[[15_CONTACTOS_PIPELINE/{cat['pipeline_link']}]]\"\n"
    fm += "---\n\n"

    body = f"""# {desc}

**SKU:** `{sku}`
**Marca:** {marca}{f' · {submarca}' if submarca else ''}

## Stock actual
- **Existencia:** {stock} unidades
- **Mínimo:** {min_stock}
- **Máximo:** {max_stock}
- **Consignación:** {consign}
- **Estatus:** {estatus}

## Notas
"""
    if estatus == 'Baja':
        body += "- ⚠️ Producto dado de BAJA · no reordenar\n"
    if stock == 0:
        body += "- 🔴 Agotado · revisar reorden si Activo\n"
    elif stock <= min_stock and min_stock > 0:
        body += f"- 🟠 Stock bajo (≤{min_stock}) · considerar reorden\n"
    if cat['pipeline_link']:
        body += f"- 🔗 Vinculado a pipeline {cat['pipeline_link']}\n"

    return cat['folder'], sku, fm + body

def main():
    print(f"Leyendo {SOURCE}...")
    tables = pd.read_html(str(SOURCE), encoding='utf-16')
    df = tables[0]
    df.columns = df.iloc[0]
    df = df[1:].reset_index(drop=True)
    print(f"Total filas: {len(df)}")

    stats = {'created': 0, 'errors': 0, 'by_category': {}}

    for idx, row in df.iterrows():
        try:
            folder, sku, content = build_md(row)
            out_dir = INV_ROOT / folder
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / f"{sanitize_sku(sku)}.md").write_text(content, encoding='utf-8')
            stats['created'] += 1
            stats['by_category'][folder] = stats['by_category'].get(folder, 0) + 1
        except Exception as e:
            stats['errors'] += 1
            print(f"ERROR fila {idx}: {e}")

    print(f"\n=== RESUMEN ===")
    print(f"Creados: {stats['created']}")
    print(f"Errores: {stats['errors']}")
    print(f"\nPor categoría:")
    for cat, count in sorted(stats['by_category'].items(), key=lambda x: -x[1]):
        print(f"  {cat}: {count}")

    # Audit entry
    audit_dir = VAULT / '13_AUDIT_AGENTES' / 'data-ingester'
    audit_dir.mkdir(parents=True, exist_ok=True)
    audit_file = audit_dir / f"eoptis-ingesta-{datetime.now().strftime('%Y-%m-%d')}.md"
    with audit_file.open('w', encoding='utf-8') as f:
        f.write(f"---\nagent: giocore-data-ingester\nfuente: EOPTIS\n"
                f"total: {stats['created']}\nerrores: {stats['errors']}\n---\n\n# Ingesta EOPTIS\n\n")
        for cat, count in sorted(stats['by_category'].items(), key=lambda x: -x[1]):
            f.write(f"- {cat}: {count}\n")

if __name__ == '__main__':
    main()

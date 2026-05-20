#!/usr/bin/env python3
"""render_reports.py — reportes estáticos de inventario · arquitectura 50K FASE 3.

Reemplaza las queries Dataview cross-folder del dashboard de inventario por
tablas pre-computadas en 99_REPORTES/ → carga instantánea en Obsidian, sin que
Dataview escanee 7,082 notas en cada apertura.

Uso:
    VAULT_ROOT="$HOME/Documents/Claude/OBSIDIAN/GIOCORE" python3 scripts/render_reports.py

Cron de ejemplo (diario 6:15am, tras el vault-sync de las 6:00):
    15 6 * * *  VAULT_ROOT="$HOME/Documents/Claude/OBSIDIAN/GIOCORE" \\
      /usr/bin/python3 "$HOME/giolens_deploy/scripts/render_reports.py" \\
      >> "$HOME/Library/Logs/giocore-render-reports.log" 2>&1
"""
import os
import re
from pathlib import Path
from datetime import datetime
from collections import Counter

VAULT = Path(os.environ.get(
    'VAULT_ROOT', str(Path.home() / 'Documents/Claude/OBSIDIAN/GIOCORE'))).expanduser()
INV = VAULT / '12_INVENTARIO'
OUT = VAULT / '99_REPORTES'


def parse_frontmatter(text):
    m = re.match(r'^---\n(.*?)\n---', text, re.DOTALL)
    if not m:
        return {}
    d = {}
    for line in m.group(1).splitlines():
        if ':' not in line:
            continue
        k, v = line.split(':', 1)
        d[k.strip()] = v.strip()
    return d


def load_products():
    """Lee todas las notas de 12_INVENTARIO/ y devuelve lista de dicts."""
    prods = []
    if not INV.exists():
        return prods
    for f in INV.rglob('*.md'):
        if f.name.startswith('00_'):
            continue
        fm = parse_frontmatter(f.read_text(encoding='utf-8'))
        if not fm.get('sku'):
            continue

        def as_int(key):
            try:
                return int(fm.get(key, 0))
            except (ValueError, TypeError):
                return 0

        prods.append({
            'sku': fm.get('sku', ''),
            'desc': fm.get('descripcion', '').strip('"'),
            'tipo': fm.get('tipo', ''),
            'marca': fm.get('marca', ''),
            'stock': as_int('stock'),
            'min': as_int('limite_minimo'),
            'estatus': fm.get('estatus', 'Activo'),
            'temp': f.parent.name,  # activos | _agotados | _baja
        })
    return prods


def md_table(headers, rows):
    out = ['| ' + ' | '.join(headers) + ' |',
           '|' + '|'.join(['---'] * len(headers)) + '|']
    for r in rows:
        out.append('| ' + ' | '.join(str(c) for c in r) + ' |')
    return '\n'.join(out)


def main():
    prods = load_products()
    OUT.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime('%Y-%m-%d %H:%M')
    total = len(prods)

    # 1 · Resumen por categoría (tipo)
    by_tipo = {}
    for p in prods:
        t = by_tipo.setdefault(p['tipo'], {'n': 0, 'u': 0, 'ago': 0, 'baja': 0})
        t['n'] += 1
        t['u'] += p['stock']
        if p['stock'] == 0:
            t['ago'] += 1
        if p['estatus'] == 'Baja':
            t['baja'] += 1
    cat_rows = [(k, v['n'], v['u'], v['ago'], v['baja'])
                for k, v in sorted(by_tipo.items(), key=lambda x: -x[1]['n'])]

    # 2 · Temperatura
    temp = Counter(p['temp'] for p in prods)

    # 3 · Top 10 marcas
    marcas = Counter(p['marca'] for p in prods if p['marca'])
    top_marcas = marcas.most_common(10)

    # 4 · Stock crítico (stock <= min, min > 0, Activo)
    critico = [p for p in prods
               if p['min'] > 0 and p['stock'] <= p['min'] and p['estatus'] == 'Activo']

    # 5 · Agotados activos
    ago_act = [p for p in prods if p['stock'] == 0 and p['estatus'] == 'Activo']

    # 6 · Productos especiales por pipeline
    smart = [p for p in prods if p['tipo'] == 'SMART GLASSES']
    seg = [p for p in prods if p['tipo'] == 'SEGURIDAD Z87']

    doc = f"""---
tipo: reporte
generado: {ts}
fuente: scripts/render_reports.py
---

# Inventario GioLens · Reporte

> Generado automáticamente · {ts} · {total} SKUs · NO editar a mano.
> Regenerar: `VAULT_ROOT=... python3 scripts/render_reports.py`

## Distribución por temperatura

{md_table(['Temperatura', 'SKUs'],
          [('activos (hot)', temp.get('activos', 0)),
           ('_agotados (cold)', temp.get('_agotados', 0)),
           ('_baja (cold)', temp.get('_baja', 0))])}

## Resumen por categoría

{md_table(['Categoría', 'SKUs', 'Unidades', 'Agotados', 'Bajas'], cat_rows)}

## Top 10 marcas por SKUs

{md_table(['Marca', 'SKUs'], top_marcas)}

## Stock crítico (≤ mínimo · activos)

{('Sin productos en stock crítico — `limite_minimo` está en 0 para todo el '
  'catálogo EOPTIS (cargar mínimos reales para activar esta alerta).'
  if not critico else
  md_table(['SKU', 'Producto', 'Stock', 'Mín', 'Marca'],
           [(p['sku'], p['desc'][:50], p['stock'], p['min'], p['marca'])
            for p in sorted(critico, key=lambda x: x['stock'])[:30]]))}

## Smart Glasses ({len(smart)}) · linkeados a GioVision

{md_table(['SKU', 'Producto', 'Stock'],
          [(p['sku'], p['desc'][:60], p['stock']) for p in smart])}

## Seguridad Z87 ({len(seg)}) · linkeados a SPY

{md_table(['SKU', 'Producto', 'Stock'],
          [(p['sku'], p['desc'][:60], p['stock']) for p in seg])}

## Agotados activos · revisar reorden ({len(ago_act)})

Primeros 50 de {len(ago_act)}:

{md_table(['SKU', 'Producto', 'Marca'],
          [(p['sku'], p['desc'][:55], p['marca'])
           for p in sorted(ago_act, key=lambda x: x['marca'])[:50]])}
"""

    report = OUT / 'inventario-resumen.md'
    report.write_text(doc, encoding='utf-8')
    print(f'OK · {report} · {total} SKUs procesados')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

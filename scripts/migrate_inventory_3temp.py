#!/usr/bin/env python3
"""Migración one-shot · arquitectura 50K FASE 1.

Mueve los 7,082 productos de _ENGINEERING/12_INVENTARIO/ a la RAÍZ del vault
GIOCORE/12_INVENTARIO/, subdividido en 3 temperaturas (mutuamente excluyentes):

  _baja      → estatus == 'Baja'           (cold · descatalogado)
  _agotados  → no-Baja AND stock == 0      (cold · sin stock, reordenable)
  activos    → no-Baja AND stock > 0       (hot · en stock)

PRECEDENCIA: _baja > _agotados > activos. (El brief asumía agotado/deprecated
disjuntos, pero ~806 productos son ambos → la precedencia los manda a _baja.)

También corrige el wikilink roto [[15_CONTACTOS_PIPELINE/X]] → [[X]]
(la carpeta 15_CONTACTOS_PIPELINE no existe; [[X]] resuelve a _ENGINEERING/Pipelines/X.md).

DRY_RUN=1 → solo cuenta y reporta, no mueve nada.
"""
import os, re, shutil, sys
from pathlib import Path

VAULT = Path.home() / 'Documents' / 'Claude' / 'OBSIDIAN' / 'GIOCORE'
SRC = VAULT / '_ENGINEERING' / '12_INVENTARIO'
DST = VAULT / '12_INVENTARIO'
DRY = os.environ.get('DRY_RUN', '') == '1'

WL_BROKEN = re.compile(r'\[\[15_CONTACTOS_PIPELINE/([^\]]+)\]\]')


def parse_frontmatter(text):
    """Devuelve (stock:int|None, estatus:str|None) leídos del frontmatter YAML."""
    m = re.match(r'^---\n(.*?)\n---', text, re.DOTALL)
    fm = m.group(1) if m else ''
    stock, estatus = None, None
    for line in fm.splitlines():
        if line.startswith('stock:'):
            try:
                stock = int(line.split(':', 1)[1].strip())
            except ValueError:
                stock = None
        elif line.startswith('estatus:'):
            estatus = line.split(':', 1)[1].strip()
    return stock, estatus


def temperature_of(stock, estatus):
    if estatus == 'Baja':
        return '_baja'
    if stock == 0:
        return '_agotados'
    return 'activos'


def main():
    if not SRC.exists():
        print(f'NADA QUE MIGRAR · {SRC} no existe (¿ya migrado?)')
        return 0

    stats = {'activos': 0, '_agotados': 0, '_baja': 0,
             'wikilinks_fixed': 0, 'errors': 0, 'unparsed': 0}
    mode = 'DRY-RUN' if DRY else 'REAL'
    print(f'=== migración inventario 3-temp · {mode} ===')

    for f in sorted(SRC.rglob('*.md')):
        if f.name.startswith('00_'):
            continue  # dashboard se mueve aparte
        try:
            text = f.read_text(encoding='utf-8')
            stock, estatus = parse_frontmatter(text)
            if stock is None and estatus is None:
                stats['unparsed'] += 1
            temp = temperature_of(stock, estatus)
            new_text, n = WL_BROKEN.subn(r'[[\1]]', text)
            stats['wikilinks_fixed'] += n
            stats[temp] += 1
            if not DRY:
                outdir = DST / temp
                outdir.mkdir(parents=True, exist_ok=True)
                (outdir / f.name).write_text(new_text, encoding='utf-8')
                f.unlink()
        except Exception as e:  # noqa: BLE001
            stats['errors'] += 1
            print(f'ERROR {f.name}: {e}')

    # dashboard
    dash = SRC / '00_INVENTARIO_DASHBOARD.md'
    if dash.exists() and not DRY:
        DST.mkdir(parents=True, exist_ok=True)
        shutil.move(str(dash), str(DST / '00_INVENTARIO_DASHBOARD.md'))

    # limpiar árbol fuente vacío
    if not DRY:
        for d in sorted(SRC.rglob('*'), reverse=True):
            if d.is_dir() and not any(d.iterdir()):
                d.rmdir()
        if SRC.exists() and not any(SRC.iterdir()):
            SRC.rmdir()

    total = stats['activos'] + stats['_agotados'] + stats['_baja']
    print(f"\n  activos:    {stats['activos']}")
    print(f"  _agotados:  {stats['_agotados']}")
    print(f"  _baja:      {stats['_baja']}")
    print(f"  TOTAL:      {total}")
    print(f"  wikilinks corregidos: {stats['wikilinks_fixed']}")
    print(f"  sin frontmatter parseable: {stats['unparsed']}")
    print(f"  errores: {stats['errors']}")
    return 1 if stats['errors'] else 0


if __name__ == '__main__':
    sys.exit(main())

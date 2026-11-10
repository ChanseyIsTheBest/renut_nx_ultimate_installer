#!/usr/bin/env python3
"""renut_nx_ultimate_installer: copies the ultimate base's own shader tools into py/ (run unchanged in Pyodide by the
page's GLSL workers, lib/py.js) and its translator header into release/shader_common.h, so the page's chain is the
base's. Run it after the base changes any of them, then rebuild wasm/renut_hlsl and wasm/uam
(wasm/src/translator/build_wasm_translator.sh, wasm/src/uam/build_wasm_uam.sh with BANJO_NX=<base>).

  python tools/sync_from_base.py [--base D:/renut-ultimate/base]

A port made from the base passes its own tree instead (its tools/ may have changed the passes or the lists).
"""
import argparse
import filecmp
import os
import shutil

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = ['deko3d_glsl.py', 'deko3d_glsl_opt.py', 'gpr32_shaders.txt', 'lightbranch_shaders.txt', 'nullps_shaders.txt',
      'skinonce_shaders.txt', 'early_alpha.py', 'renut_early_alpha.py']
COMMON = 'app/thirdparty/reblue-XenosRecomp/XenosRecomp/shader_common.h'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default='D:/renut-ultimate/base')
    a = ap.parse_args()
    pairs = [(os.path.join(a.base, 'tools', n), os.path.join(HERE, 'py', n)) for n in PY]
    pairs.append((os.path.join(a.base, COMMON), os.path.join(HERE, 'release', 'shader_common.h')))
    os.makedirs(os.path.join(HERE, 'py'), exist_ok=True)
    os.makedirs(os.path.join(HERE, 'release'), exist_ok=True)
    for src, dst in pairs:
        if not os.path.exists(src):
            raise SystemExit(f'not in the base: {src}')
        same = os.path.exists(dst) and filecmp.cmp(src, dst, shallow=False)
        if not same:
            shutil.copyfile(src, dst)
        print(f'{"same   " if same else "copied "} {os.path.relpath(dst, HERE)}')


if __name__ == '__main__':
    main()

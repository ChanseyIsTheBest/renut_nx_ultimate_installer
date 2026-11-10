#!/usr/bin/env python3
"""renut_nx_ultimate_installer: fills release/ from a port's tree (made from the ultimate base) for one build of its NRO.

  python tools/make_release.py --port <port root> --nro <NRO> --game <game folder> [--edition "Xbox 360 disc"]
      [--records <records.json>] [--pipeline-list <pipeline_list.bin>] [--file <src>[:<name>] ...] [--version 1.0.0]
      [--append]

Writes into release/:
  <game.json "nro">     the NRO (built with -DBANJO_RENUT_RELEASE_SHADERS=ON: no game shader in it; the page makes them)
  shader_common.h       the translator's header, from the port (app/thirdparty/reblue-XenosRecomp)
  variants.txt          with --pipeline-list: every shader variant the list names (the port's
                        tools/deko3d_variant_cache.py --export-variants, checked against the native GLSL), which the
                        page compiles into the console's DKSH cache
  pipeline_list.bin     with --pipeline-list: the console prebuilds those pipelines at start (only with the cache)
  <name>                each --file (the settings file a release carries, for example)
  manifest.json         per build: default.xex's SHA-256, the NRO's and every file's, and where the page finds each of
                        the port's shaders ("shaders": the containers of default.xex by SHA-256, and --records, the
                        ones in the game's own files)

The shaders are the port's out/renut_shader_dump (every container its native build translates, named by the XXH3 Renut
looks them up by). Each one must be in default.xex (found here in the port's decrypted image, out/renut_image.bin) or in
a record: a container that is in neither (a shader the PC runs captured, which the game makes at runtime) is one the
NRO must carry itself, and stops this. Records (--records): [{ "file", "offset", "stored", "size", "codec" (raw, cpdb,
zlib: lib/sources.js), "containers": [{ "at", "length", "sha256" }] }], made by the port's own tool;
katamari-nx's tools/katamari_shader_files.py's form ("archive", "compressed") is read too.

Then run test/full_node.mjs on the game with --reference: it makes the shader files as the page does and writes their
SHA-256 into the build's entry, so the page can say whether the player's are the release's.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REL = os.path.join(HERE, 'release')


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def find_shader_headers(data):
    """The port's tools/renut_shader_dump.py find_shader_headers (aligned), which made its dump."""
    hdrs = []
    for m in re.finditer(rb'\x10\x2a\x11', data):
        o = m.start()
        if o % 4 or o + 0x24 > len(data):
            continue
        virt, phys = struct.unpack_from('>II', data, o + 4)
        ct, dt, so = struct.unpack_from('>III', data, o + 0x10)
        if not (0x24 <= virt < 0x10000 and 0 < phys < 0x100000 and o + virt <= len(data)):
            continue
        if ct >= virt or dt >= virt or not (0x24 <= so < virt - 8):
            continue
        poff, psize = struct.unpack_from('>II', data, o + so)
        if poff + psize != phys:
            continue
        hdrs.append(o)
    return hdrs


def generic_records(raw):
    if isinstance(raw, dict):  # katamari_shader_files.py: { "image_sha256": [...], "files": [records] }
        raw = raw['files']
    out = []
    for r in raw:
        codec = r.get('codec') or ('cpdb' if r.get('compressed') else 'raw')
        out.append({'file': r.get('file') or r['archive'], 'offset': r['offset'], 'stored': r['stored'],
                    'size': r['size'], 'codec': codec,
                    'containers': [{'at': c['at'], 'length': c['length'], 'sha256': c['sha256']} for c in r['containers']]})
    return out


def main():
    import xxhash
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', required=True)
    ap.add_argument('--nro', required=True)
    ap.add_argument('--game', required=True)
    ap.add_argument('--edition', default='Xbox 360 disc')
    ap.add_argument('--version', default='1.0.0')
    ap.add_argument('--image', default=None, help='default: <port>/out/renut_image.bin')
    ap.add_argument('--dump', default=None, help='default: <port>/out/renut_shader_dump')
    ap.add_argument('--glsl', default=None, help='the native GLSL, for the variant export (default <port>/out/deko3d_shaders/glsl_opt)')
    ap.add_argument('--records', default=None)
    ap.add_argument('--pipeline-list', default=None)
    ap.add_argument('--file', action='append', default=[])
    ap.add_argument('--append', action='store_true', help='add this build to the manifest (another edition of the game)')
    a = ap.parse_args()
    game_cfg = json.load(open(os.path.join(HERE, 'game.json'), encoding='utf-8'))
    image = open(a.image or os.path.join(a.port, 'out', 'renut_image.bin'), 'rb').read()
    dump = a.dump or os.path.join(a.port, 'out', 'renut_shader_dump')
    os.makedirs(REL, exist_ok=True)

    # the build: default.xex and the NRO
    xex = open(os.path.join(a.game, 'default.xex'), 'rb').read()
    build = {'edition': a.edition, 'xex_sha256': sha256(xex), 'nro': game_cfg['nro']}
    nro = open(a.nro, 'rb').read()
    shutil.copyfile(a.nro, os.path.join(REL, game_cfg['nro']))
    build['nro_sha256'] = sha256(nro)

    # the shaders: every container of the dump, in default.xex or in a record
    if game_cfg.get('shaders'):
        wanted = {}
        for n in sorted(os.listdir(dump)):
            if re.fullmatch(r'(vs|ps)_[0-9a-f]{16}\.bin', n):
                wanted[n[:-4].lower()] = open(os.path.join(dump, n), 'rb').read()
        in_image = {}
        for o in find_shader_headers(image):
            virt, phys = struct.unpack_from('>II', image, o + 4)
            blob = image[o:o + virt + phys]
            kind = 'vs' if struct.unpack_from('>I', image, o)[0] & 1 else 'ps'
            name = f'{kind}_{xxhash.xxh3_64_hexdigest(blob)}'
            if name in wanted and wanted[name] == blob:
                in_image[name] = sha256(blob)
        records = generic_records(json.load(open(a.records, encoding='utf-8'))) if a.records else []
        in_records = {c['sha256'] for r in records for c in r['containers']}
        missing = [n for n, blob in wanted.items() if n not in in_image and sha256(blob) not in in_records]
        if missing:
            sys.exit(f'{len(missing)} of the {len(wanted)} shaders are neither in default.xex nor in a record '
                     f'(the NRO must carry those itself): {", ".join(missing[:8])}')
        build['shaders'] = {'image_sha256': sorted(set(in_image.values())), 'records': records}
        print(f'shaders: {len(wanted)}: {len(in_image)} in default.xex, {len(wanted) - len(in_image)} in '
              f'{len(records)} records of the game\'s files')
        common = os.path.join(a.port, 'app', 'thirdparty', 'reblue-XenosRecomp', 'XenosRecomp', 'shader_common.h')
        shutil.copyfile(common, os.path.join(REL, 'shader_common.h'))

    # the release files
    files = []
    if a.pipeline_list:
        variants = os.path.join(REL, 'variants.txt')
        glsl = a.glsl or os.path.join(a.port, 'out', 'deko3d_shaders', 'glsl_opt')
        subprocess.run([sys.executable, os.path.join(a.port, 'tools', 'deko3d_variant_cache.py'), '--list',
                        a.pipeline_list, '--glsl', glsl, '--export-variants', variants, '--dry-run',
                        '--out', os.path.join(REL, 'unused.bin')], check=True)
        if os.path.exists(os.path.join(REL, 'unused.bin')):
            os.remove(os.path.join(REL, 'unused.bin'))
        build['variants_sha256'] = sha256(open(variants, 'rb').read())
        shutil.copyfile(a.pipeline_list, os.path.join(REL, 'pipeline_list.bin'))
        files.append({'path': 'pipeline_list.bin', 'source': 'pipeline_list.bin', 'with_cache': True})
    for spec in a.file:
        src, _, name = spec.partition(':')
        name = name or os.path.basename(src)
        shutil.copyfile(src, os.path.join(REL, name))
        files.append({'path': name, 'source': name})
    for f in files:
        f['sha256'] = sha256(open(os.path.join(REL, f['source']), 'rb').read())
    build['files'] = files

    path = os.path.join(REL, 'manifest.json')
    manifest = {'version': a.version, 'builds': []}
    if a.append and os.path.exists(path):
        manifest = json.load(open(path, encoding='utf-8'))
        manifest['builds'] = [b for b in manifest['builds'] if b['xex_sha256'] != build['xex_sha256']]
    manifest['version'] = a.version
    if game_cfg.get('shaders'):
        manifest['shader_common_sha256'] = sha256(open(os.path.join(REL, 'shader_common.h'), 'rb').read())
    manifest['builds'].append(build)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(manifest, f, indent=2)
        f.write('\n')
    for n in sorted(os.listdir(REL)):
        print(f'  {n:24} {os.path.getsize(os.path.join(REL, n)):>12,} bytes')
    print(f'manifest.json: {len(manifest["builds"])} build(s), default.xex {build["xex_sha256"][:16]}, version {a.version}')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""renut_nx_ultimate_installer: checks a zip the page (or test/full_node.mjs) made against the game folder it was made
from, game.json and release/: the zip's CRCs, the NRO and every release file by the manifest's SHA-256, the shader files
(against the build's reference SHA-256 when the manifest has them), every game_root file byte for byte (the ones
game.json "skip" names left out), and every .lz4b entry's blocks decompressed and compared with the original.

  python test/check_zip.py <zip> <game folder>

Needs the lz4 module (pip's lz4). Game data: never commit or share the zip.
"""
import hashlib
import json
import os
import re
import struct
import sys
import zipfile

import lz4.block

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def file_sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for piece in iter(lambda: f.read(1 << 20), b''):
            h.update(piece)
    return h.hexdigest()


def entry_sha(z, name):
    h = hashlib.sha256()
    with z.open(name) as f:
        for piece in iter(lambda: f.read(1 << 20), b''):
            h.update(piece)
    return h.hexdigest()


def check_lz4b(z, info, original):
    with z.open(info) as f:
        magic, version, block, size, count, _ = struct.unpack('<8sIIQII', f.read(32))
        assert magic == b'RXLZ4BLK' and version == 1, 'header'
        assert size == os.path.getsize(original), f'holds {size} bytes, the original has {os.path.getsize(original)}'
        f.seek(info.file_size - 16)
        index_offset, end = struct.unpack('<Q8s', f.read(16))
        assert end == b'RXLZ4END', 'footer'
        f.seek(index_offset)
        sizes = struct.unpack(f'<{count}I', f.read(4 * count))
        assert 32 + sum(sizes) == index_offset, 'index'
        f.seek(32)
        with open(original, 'rb') as o:
            for i, stored in enumerate(sizes):
                length = block if i + 1 < count else size - i * block
                data = f.read(stored)
                raw = data if stored == length else lz4.block.decompress(data, uncompressed_size=length)
                if raw != o.read(length):
                    raise AssertionError(f'block {i} differs')
    return size, info.file_size, count


def main():
    zip_path, game = sys.argv[1], sys.argv[2]
    cfg = json.load(open(os.path.join(HERE, 'game.json'), encoding='utf-8'))
    manifest = json.load(open(os.path.join(HERE, 'release', 'manifest.json'), encoding='utf-8'))
    xex_sha = file_sha(os.path.join(game, 'default.xex'))
    build = next(b for b in manifest['builds'] if b['xex_sha256'] == xex_sha)
    root = f'switch/{cfg["package"]}/'
    lz4_res = [re.compile(f'^(?:{p})$', re.I) for p in cfg.get('lz4', [])]
    skip_res = [re.compile(f'^(?:{p})$', re.I) for p in cfg.get('skip', [])]
    with zipfile.ZipFile(zip_path) as z:
        bad = z.testzip()
        if bad:
            raise SystemExit(f'FAIL: {bad} has a wrong CRC')
        names = set(i.filename for i in z.infolist())
        print(f'{len(names)} entries, all CRCs right')
        release = {root + cfg['nro']: build['nro_sha256'], **{root + f['path']: f['sha256'] for f in build['files']
                                                              if not f.get('with_cache') or root + f['path'] in names}}
        for name, want in release.items():
            if entry_sha(z, name) != want:
                raise SystemExit(f'FAIL: {name} is not the release file')
        print(f'release files: {len(release)} as the manifest names them')
        if cfg.get('shaders'):
            for name, key in (('deko3d_glsl.bin', 'deko3d_glsl_sha256'), ('deko3d_shaders.bin', 'deko3d_shaders_sha256')):
                if root + name not in names:
                    if name == 'deko3d_glsl.bin':
                        raise SystemExit('FAIL: no deko3d_glsl.bin')
                    print(f'{name}: not in the zip (made without the cache)')
                    continue
                got = entry_sha(z, root + name)
                want = build.get(key)
                print(f'{name}: {z.getinfo(root + name).file_size:,} bytes' +
                      ('' if not want else ', the reference build\'s' if got == want else ' (not the reference build\'s)'))
                if want and got != want:
                    raise SystemExit(f'FAIL: {name} differs from the reference')
        count = packed_in = packed_out = 0
        for dirpath, _, files in os.walk(game):
            for f in sorted(files):
                original = os.path.join(dirpath, f)
                rel = os.path.relpath(original, game).replace(os.sep, '/')
                if any(r.match(rel) for r in skip_res):
                    if root + 'game_root/' + rel in names:
                        raise SystemExit(f'FAIL: {rel} should have been left out')
                    continue
                count += 1
                entry = root + 'game_root/' + rel
                if any(r.match(rel) for r in lz4_res):
                    if entry in names:
                        raise SystemExit(f'FAIL: {rel} is in the zip unpacked too')
                    size, packed, blocks = check_lz4b(z, z.getinfo(entry + '.lz4b'), original)
                    packed_in += size
                    packed_out += packed
                    print(f'{entry}.lz4b: {blocks} blocks equal {rel} ({packed / size * 100:.1f} %)')
                elif entry_sha(z, entry) != file_sha(original):
                    raise SystemExit(f'FAIL: {entry} differs from {rel}')
        print(f'game_root: {count} files right' +
              (f'; packed {packed_in / 1048576:.0f} MB -> {packed_out / 1048576:.0f} MB' if packed_in else ''))
    print('OK')


if __name__ == '__main__':
    main()

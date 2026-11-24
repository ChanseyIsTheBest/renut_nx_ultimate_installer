#!/usr/bin/env python3
"""renut_nx_ultimate_installer: checks a zip the page (or test/full_node.mjs) made against the game folder it was made
from, game.json and release/: the zip's CRCs, the NRO and every release file by the manifest's SHA-256, the shader files
(against the build's reference SHA-256 when the manifest has them), every game_root file byte for byte (the ones
game.json "skip" names left out), and every .lz4b entry's blocks decompressed and compared with the original.

  python test/check_zip.py <zip> <game folder>

Needs the lz4 module (pip's lz4). Game data: never commit or share the zip.
blur-nx (2026-11-18): with a third argument, the title update's extracted folder (when the build names one): its
default.xexp in game_root/ and its other files in update/, each the update's own.
  python test/check_zip.py <zip> <game folder> [<title update folder>]

2026-11-23 (the user: "re-encoding katamari's audio and video (ZXC compress the video) and L4Z/ZXC compressing the other
files"): each game file by lib/lz4b.js's codecFor (game.json "asis", "min_pack_size", "lz4_small", "zxc", "lz4"). A
version-1 entry (LZ4) is decoded here; a version-2 entry (ZXC) is written to a temporary file and read through the base's
block reader test (tools/test_lz4_blocks.cpp's exe: LZ4B_TEST, default rr6-nx's out/test_lz4_blocks.exe; Python has no
ZXC), as vivapinata-nx-installer's check does (credit it and sasrt-nx-installer). A sound file the page re-encoded is
NAME.xmop or NAME.xmop.lz4b: checked by test/xmop_check.mjs (every byte outside the sounds, every header, frame length,
last bit and tag). A movie the page re-encoded keeps its name as NAME.lz4b (ZXC) with another size: found, not compared
(the H.265 is checked by its own tests); a movie kept as WMV is compared.
"""
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile

import lz4.block

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
READER_TEST = os.environ.get('LZ4B_TEST', 'D:/ridge racer 6/rr6-nx/out/test_lz4_blocks.exe')


def fits(lst, path):
    return any(re.fullmatch(m, path, re.I) for m in lst or [])


def codec_for(cfg, path, size):
    """lib/lz4b.js's codecFor."""
    if fits(cfg.get('asis'), path) or size < cfg.get('min_pack_size', 0):
        return None
    if fits(cfg.get('lz4_small'), path):
        return 'lz4'
    if fits(cfg.get('zxc'), path):
        return 'zxc'
    return 'lz4' if fits(cfg.get('lz4'), path) else None


def lz4b_header(z, info):
    with z.open(info) as f:
        return struct.unpack('<8sIIQII', f.read(32))


def check_zxc(z, info, original):
    """A version-2 entry through the block reader: the whole file and 2,000 random reads compared with the original."""
    magic, version, block, size, count, _ = lz4b_header(z, info)
    assert magic == b'RXLZ4BLK' and version == 2, 'header'
    assert size == os.path.getsize(original), f'holds {size} bytes, the original has {os.path.getsize(original)}'
    fd, temp = tempfile.mkstemp(suffix='.lz4b')
    try:
        with os.fdopen(fd, 'wb') as out, z.open(info) as f:
            shutil.copyfileobj(f, out, 1 << 20)
        env = dict(os.environ)
        clang64 = r'C:/devkitPro/msys2/clang64/bin'
        if os.path.isdir(clang64):
            env['PATH'] = clang64 + os.pathsep + env.get('PATH', '')
        r = subprocess.run([READER_TEST, temp, original, '2000'], capture_output=True, text=True, env=env)
        if r.returncode != 0 or not r.stdout.startswith('OK'):
            raise AssertionError('block reader: ' + (r.stdout + r.stderr).strip()[-300:])
    finally:
        os.remove(temp)
    return size, info.file_size, count


def unpack_lz4b(z, info, out):
    """A version-1 entry's file written to `out`."""
    with z.open(info) as f:
        magic, version, block, size, count, _ = struct.unpack('<8sIIQII', f.read(32))
        assert magic == b'RXLZ4BLK' and version == 1, 'header'
        f.seek(info.file_size - 16)
        index_offset, end = struct.unpack('<Q8s', f.read(16))
        f.seek(index_offset)
        sizes = struct.unpack(f'<{count}I', f.read(4 * count))
        f.seek(32)
        for i, stored in enumerate(sizes):
            length = block if i + 1 < count else size - i * block
            data = f.read(stored)
            out.write(data if stored == length else lz4.block.decompress(data, uncompressed_size=length))


def check_xmop(z, entry, original):
    """NAME.xmop (or NAME.xmop.lz4b, LZ4) against NAME by test/xmop_check.mjs."""
    fd, temp = tempfile.mkstemp(suffix='.xmop')
    try:
        with os.fdopen(fd, 'wb') as out:
            if entry.endswith('.lz4b'):
                unpack_lz4b(z, z.getinfo(entry), out)
            else:
                with z.open(entry) as f:
                    shutil.copyfileobj(f, out, 1 << 20)
        r = subprocess.run(['node', os.path.join(HERE, 'test', 'xmop_check.mjs'), original, temp], capture_output=True,
                           text=True)
        if r.returncode:
            raise AssertionError((r.stdout + r.stderr).strip()[-300:])
    finally:
        os.remove(temp)


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
    update = sys.argv[3] if len(sys.argv) > 3 else None
    cfg = json.load(open(os.path.join(HERE, 'game.json'), encoding='utf-8'))
    manifest = json.load(open(os.path.join(HERE, 'release', 'manifest.json'), encoding='utf-8'))
    xex_sha = file_sha(os.path.join(game, 'default.xex'))
    build = next(b for b in manifest['builds'] if b['xex_sha256'] == xex_sha)
    root = f'switch/{cfg["package"]}/'
    movies = (cfg.get('movies') or {}).get('match')
    audio = (cfg.get('audio') or {}).get('match')
    reencoded = {'hevc': [0, 0], 'xmop': [0, 0]}
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
        placed = set()  # the title update's entries, which the game folder's "skip" does not concern
        if build.get('update'):
            if not update:
                raise SystemExit('FAIL: the build names a title update: pass its extracted folder as the third argument')
            want = {'default.xexp': root + 'game_root/default.xexp',
                    **{p: root + 'update/' + p for p in build['update']['files']}}
            for rel, entry in want.items():
                if entry not in names:
                    raise SystemExit(f'FAIL: no {entry} (the title update file {rel})')
                if entry_sha(z, entry) != file_sha(os.path.join(update, rel)):
                    raise SystemExit(f'FAIL: {entry} is not the title update file {rel}')
                placed.add(entry)
            print(f'title update: {len(want)} files right (default.xexp in game_root/, {len(want) - 1} in update/)')
        count = packed_in = packed_out = 0
        for dirpath, _, files in os.walk(game):
            for f in sorted(files):
                original = os.path.join(dirpath, f)
                rel = os.path.relpath(original, game).replace(os.sep, '/')
                if any(r.match(rel) for r in skip_res):
                    if root + 'game_root/' + rel in names and root + 'game_root/' + rel not in placed:
                        raise SystemExit(f'FAIL: {rel} should have been left out')
                    continue
                count += 1
                entry = root + 'game_root/' + rel
                size_o = os.path.getsize(original)
                if audio and fits([audio], rel):
                    found = [e for e in (entry + '.xmop.lz4b', entry + '.xmop') if e in names]
                    if found:
                        if entry in names or entry + '.lz4b' in names:
                            raise SystemExit(f'FAIL: {rel} is in the zip both re-encoded and as it is')
                        try:
                            check_xmop(z, found[0], original)
                        except AssertionError as e:
                            raise SystemExit(f'FAIL: {found[0]}: {e}')
                        reencoded['xmop'][0] += size_o
                        reencoded['xmop'][1] += z.getinfo(found[0]).file_size
                        continue
                if movies and fits([movies], rel) and entry + '.lz4b' in names:
                    held = lz4b_header(z, z.getinfo(entry + '.lz4b'))[3]
                    if held != size_o:
                        # re-encoded: H.265 in the movie's own ASF, another size
                        reencoded['hevc'][0] += size_o
                        reencoded['hevc'][1] += z.getinfo(entry + '.lz4b').file_size
                        print(f'{entry}.lz4b: re-encoded ({z.getinfo(entry + ".lz4b").file_size / size_o * 100:.1f} %), '
                              'not compared')
                        continue
                codec = codec_for(cfg, rel, size_o)
                if codec:
                    if entry in names:
                        raise SystemExit(f'FAIL: {rel} is in the zip unpacked too')
                    if entry + '.lz4b' not in names:
                        raise SystemExit(f'FAIL: no {entry}.lz4b')
                    check = check_lz4b if codec == 'lz4' else check_zxc
                    try:
                        size, packed, blocks = check(z, z.getinfo(entry + '.lz4b'), original)
                    except AssertionError as e:
                        raise SystemExit(f'FAIL: {entry}.lz4b: {e}')
                    packed_in += size
                    packed_out += packed
                    if size > (32 << 20):
                        print(f'{entry}.lz4b ({codec}): {blocks} blocks equal {rel} ({packed / size * 100:.1f} %)')
                elif entry_sha(z, entry) != file_sha(original):
                    raise SystemExit(f'FAIL: {entry} differs from {rel}')
        print(f'game_root: {count} files right' +
              (f'; packed {packed_in / 1048576:.0f} MB -> {packed_out / 1048576:.0f} MB' if packed_in else ''))
        for kind, (i, o) in reencoded.items():
            if i:
                print(f're-encoded ({kind}): {i / 1048576:.1f} MB -> {o / 1048576:.1f} MB ({o / i * 100:.1f} %)')
    print('OK')


if __name__ == '__main__':
    main()

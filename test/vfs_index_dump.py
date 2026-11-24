#!/usr/bin/env python3
"""renut_nx_ultimate_installer (2026-11-24): reads a VFS index (the base's sdk/src/filesystem/devices/host_path_index.cpp,
version 4: port 264), as the console writes it at cache/vfs_index_<game folder>.bin or as lib/vfs_index.js writes it into
the package, and prints or compares it.

  python test/vfs_index_dump.py INDEX                 the header and every entry
  python test/vfs_index_dump.py INDEX OTHER           the two compared: the host path, the flags, and per directory the
                                                      entries as a set (name, type, SD size, kinds, guest size, guest
                                                      name), the order and the timestamps left out
"""
import struct
import sys


class Reader:
    def __init__(self, b):
        self.b, self.at = b, 0

    def pod(self, fmt):
        v = struct.unpack_from('<' + fmt, self.b, self.at)
        self.at += struct.calcsize('<' + fmt)
        return v[0]

    def str(self):
        n = self.pod('I')
        s = self.b[self.at:self.at + n].decode('utf-8')
        self.at += n
        return s


def fnv1a(b):
    h = 0xcbf29ce484222325
    for x in b:
        h = ((h ^ x) * 0x100000001b3) & 0xFFFFFFFFFFFFFFFF
    return h


def load(path):
    d = open(path, 'rb').read()
    assert d[:8] == b'RXVFSIDX', 'not a VFS index'
    version, flags, count, size_body, h = struct.unpack_from('<IIQQQ', d, 8)
    body = d[40:]
    assert len(body) == size_body, 'body size'
    assert fnv1a(body) == h, 'checksum'
    r = Reader(body)
    host = r.str()
    entries = []

    def directory(prefix):
        complete, n = r.pod('B'), r.pod('I')
        kids = []
        for _ in range(n):
            t, name, size, kinds = r.pod('B'), r.str(), r.pod('Q'), r.pod('B')
            gsize, gname = (r.pod('Q'), r.str()) if kinds else (0, '')
            ct, at, wt = r.pod('Q'), r.pod('Q'), r.pod('Q')
            e = dict(path=prefix + name, type=t, size=size, kinds=kinds, gsize=gsize, gname=gname, times=(ct, at, wt))
            entries.append(e)
            kids.append(e)
            if t == 1:
                e['complete'], e['children'] = directory(prefix + name + '/')
        return complete, n

    root = directory('')
    assert r.at == len(body), 'trailing data'
    assert len(entries) == count, f'count {count} but {len(entries)} entries'
    return dict(version=version, flags=flags, count=count, host=host, root=root, entries=entries)


def key(e):
    return (e['path'], e['type'], e['size'], e['kinds'], e['gsize'], e['gname'])


a = load(sys.argv[1])
print(f'{sys.argv[1]}: version {a["version"]}, flags {a["flags"]}, {a["count"]} entries, host path {a["host"]!r}')
if len(sys.argv) == 2:
    for e in a['entries']:
        print(e['type'], e['path'], e['size'], e['kinds'], e['gsize'], e['gname'], e['times'][2])
    sys.exit(0)
b = load(sys.argv[2])
print(f'{sys.argv[2]}: version {b["version"]}, flags {b["flags"]}, {b["count"]} entries, host path {b["host"]!r}')
ka, kb = {key(e) for e in a['entries']}, {key(e) for e in b['entries']}
only_a, only_b = sorted(ka - kb), sorted(kb - ka)
print(f'entries the same: {len(ka & kb)}; only in the first {len(only_a)}, only in the second {len(only_b)}')
for x in only_a[:10]:
    print('  first only: ', x)
for x in only_b[:10]:
    print('  second only:', x)
ca = {e['path']: (e.get('complete'), e.get('children')) for e in a['entries'] if e['type'] == 1}
cb = {e['path']: (e.get('complete'), e.get('children')) for e in b['entries'] if e['type'] == 1}
bad = [p for p in ca if p in cb and ca[p] != cb[p]]
print('directories with another complete mark or count:', bad[:10], '; root', a['root'], b['root'])
sys.exit(1 if only_a or only_b or bad or a['root'] != b['root'] else 0)

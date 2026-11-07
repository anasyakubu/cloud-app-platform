#!/usr/bin/env python3
"""Read-only format validator: does not execute the artifact or extract it."""
import os, sys, tarfile, stat
filename, kind = sys.argv[1:3]
if os.path.getsize(filename) < 1024:
    raise SystemExit('File too small')
if kind == 'appimage':
    with open(filename, 'rb') as f:
        header = f.read(32)
    if header[:4] != b'\x7fELF' or header[8:11] not in (b'AI\x01', b'AI\x02'):
        raise SystemExit('Only Type 1/2 ELF AppImages are supported')
elif kind == 'tar.gz':
    cumulative = 0
    with tarfile.open(filename, 'r:gz') as tar:
        members = tar.getmembers()
        if len(members) > 5000: raise SystemExit('Too many archive entries')
        for m in members:
            components = m.name.split('/')
            if not m.name or m.name.startswith('/') or '..' in components or '\\' in m.name:
                raise SystemExit('Path traversal entry')
            if not (m.isdir() or m.isfile()): raise SystemExit('Links and special files forbidden')
            if m.mode & (stat.S_ISUID | stat.S_ISGID): raise SystemExit('Setuid/setgid file forbidden')
            cumulative += m.size
            if cumulative > 5 * 1024**3: raise SystemExit('Uncompressed archive over 5 GiB')
else: raise SystemExit('Unsupported file kind')
print('Format checks passed')

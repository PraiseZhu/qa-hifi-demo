import json
import os
import re
import subprocess
import sys

base = os.environ.get('CI_BASE', '')
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
if not re.fullmatch(r'[0-9a-f]{40}', base) or base == '0' * 40:
    parents = subprocess.check_output(['git', 'rev-list', '--parents', '-n', '1', head], text=True).split()
    base = parents[1] if len(parents) > 1 else ''
if base:
    subprocess.run(['git', 'cat-file', '-e', base], check=True)
    paths = subprocess.check_output(['git', 'diff', '--name-status', '-z', '--no-renames', base, head])
    pieces = paths.decode().split(chr(0))
    changed = [(pieces[i], pieces[i + 1]) for i in range(0, len(pieces) - 1, 2)]
else:
    changed = [('A', p) for p in subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', head], text=True).splitlines()]
pattern = re.compile(r'(^|/)(auth[.]json|credentials?[^/]*[.](json|ya?ml)|id_(rsa|ed25519)[^/]*|[.]env([.][^/]*)?)$|[.](pem|key|sqlite(-wal|-shm)?|token[.]json|auth[.]json)$', re.I)
backup = os.environ.get('CI_BACKUP') == '1'
hits = [p for status, p in changed if status != 'D' and (not backup or status == 'A')
        and pattern.search(p) and not p.endswith(('.example', '.sample', '.template'))]
if hits:
    print('Sensitive file names require removal or explicit repository policy:', json.dumps(hits))
    sys.exit(1)
if base:
    with open(os.environ['GITHUB_OUTPUT'], 'a') as stream:
        stream.write('base=' + base + chr(10))
print(f'Checked {len(changed)} changed paths; no credential payload was read.')

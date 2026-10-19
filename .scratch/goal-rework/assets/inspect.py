import json, collections, os, sys

os.chdir(os.path.dirname(os.path.abspath(__file__)))
files = ['recording-runA-success.jsonl', 'recording-runB-success-fresh.jsonl', 'recording-runC-failed-quota.jsonl']

for f in files:
    kinds = collections.Counter()
    types = collections.Counter()
    n = 0
    probe_lines = []
    for line in open(f, encoding='utf-8'):
        line = line.strip()
        if not line:
            continue
        n += 1
        d = json.loads(line)
        kinds[d.get('kind')] += 1
        for key in ('type', 'event', 'eventType'):
            v = d.get(key)
            if isinstance(v, str):
                types[v] += 1
            elif v is not None:
                types[str(key) + ':' + type(v).__name__] += 1
        joined = json.dumps(d).lower()
        if 'sessionget' in joined.replace('_', '') or d.get('kind') == 'sessionGet':
            probe_lines.append(d)
    print('===', f, 'lines:', n)
    print('  kinds:', dict(kinds))
    for t, c in types.most_common():
        print('    %3d  %s' % (c, t))
    print('  session.get probe lines:', len(probe_lines))
    for p in probe_lines[:2]:
        print('     ', json.dumps(p)[:400])
    print()

import json, os

os.chdir(os.path.dirname(os.path.abspath(__file__)))

for f in ['recording-runA-success.jsonl', 'recording-runB-success-fresh.jsonl', 'recording-runC-failed-quota.jsonl']:
    print('==========', f)
    for line in open(f, encoding='utf-8'):
        line = line.strip()
        if not line:
            continue
        d = json.loads(line)
        kind = d.get('kind')
        if kind == 'session.get.result':
            print('  --- session.get.result ---')
            print('   ', json.dumps(d)[:900])
            continue
        if kind != 'event':
            continue
        t = d.get('type')
        if t and (t.startswith('session.execution') or t.startswith('session.usage')):
            env = d.get('envelope') or d.get('data') or {}
            print('  ---', t, '---')
            print('     envelope keys:', sorted(d.keys()))
            if isinstance(env, dict):
                print('     data keys     :', sorted(env.keys()))
            print('     has location  :', 'location' in d)
            print('    ', json.dumps(d)[:700])
    print()

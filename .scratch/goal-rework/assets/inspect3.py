import json, os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
for f in ['recording-runA-success.jsonl', 'recording-runC-failed-quota.jsonl']:
    print('=====', f)
    for line in open(f, encoding='utf-8'):
        line = line.strip()
        if not line: continue
        d = json.loads(line)
        if d.get('kind') != 'event': continue
        t = d.get('type')
        if t in ('session.step.ended', 'session.step.failed', 'session.interrupted', 'session.execution.interrupted', 'session.deleted'):
            env = d.get('event') or {}
            print(' ---', t, ' dataKeys=', env.get('data') and sorted(env['data'].keys()))
            print('    ', json.dumps(env)[:520])
    print()

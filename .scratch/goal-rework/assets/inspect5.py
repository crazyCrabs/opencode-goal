import json, os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
for f in ['recording-runA-success.jsonl']:
    for line in open(f, encoding='utf-8'):
        line=line.strip()
        if not line: continue
        d=json.loads(line)
        if d.get('kind')!='event': continue
        env=d.get('event') or {}
        t=env.get('type')
        if t in ('session.inbox.enqueued','session.inbox.delivered','session.instructions.updated'):
            print('---',t)
            print('   ',json.dumps(env)[:700])

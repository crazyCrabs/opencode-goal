import json, os, collections
os.chdir(os.path.dirname(os.path.abspath(__file__)))
seen = {}
for f in ['recording-runA-success.jsonl', 'recording-runB-success-fresh.jsonl', 'recording-runC-failed-quota.jsonl']:
    for line in open(f, encoding='utf-8'):
        line = line.strip()
        if not line: continue
        d = json.loads(line)
        if d.get('kind') != 'event': continue
        env = d.get('event') or {}
        t = env.get('type')
        if not t: continue
        rec = seen.setdefault(t, {'n': 0, 'loc': 0, 'dataKeys': set(), 'order': len(seen)})
        rec['n'] += 1
        if 'location' in env: rec['loc'] += 1
        dk = env.get('data')
        if isinstance(dk, dict):
            rec['dataKeys'] |= set(dk.keys())
print('%-32s %4s %6s  %s' % ('event type', 'seen', 'w/loc', 'data keys'))
for t, r in sorted(seen.items(), key=lambda kv: kv[1]['order']):
    print('%-32s %4d %6s  %s' % (t, r['n'], '%d/%d' % (r['loc'], r['n']), ', '.join(sorted(r['dataKeys'])) or '-'))

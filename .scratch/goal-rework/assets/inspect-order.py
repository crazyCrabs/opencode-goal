"""Show the full picture for one session: tool names, step events, usage, and
the exact `created` millisecond of everything that matters."""
import io, json, sys

spy = sys.argv[1].rstrip('\\/') + '\\.opencode\\event-spy.jsonl'
log = sys.argv[2].rstrip('\\/') + '\\.opencode\\goal-log.jsonl'
want = sys.argv[3] if len(sys.argv) > 3 else None

print('=== goal mutations (ms) ===')
mutations = []
for l in io.open(log, encoding='utf-8'):
    try:
        o = json.loads(l)
    except Exception:
        continue
    g = o.get('goal', {}) or {}
    mutations.append((g.get('updatedAt'), o.get('operation'), g.get('revision'), g.get('id', '')[:8],
                      g.get('usage', {}).get('inputTokens'), g.get('usage', {}).get('outputTokens'), g.get('phase')))
for m in sorted(mutations, key=lambda x: x[0] or 0):
    print('  %-14s rev=%s id=%s usage=%s/%s phase=%s' % (m[1], m[2], m[3], m[4], m[5], m[6]))

print()
print('=== events (created ms, seq, type, tool, usage) ===')
rows = []
for l in io.open(spy, encoding='utf-8'):
    try:
        o = json.loads(l)
    except Exception:
        continue
    ev = o.get('event')
    if not isinstance(ev, dict):
        continue
    t = ev.get('type')
    if not t or not t.startswith('session.'):
        continue
    d = ev.get('data', {}) or {}
    sid = d.get('sessionID') or ev.get('durable', {}).get('aggregateID')
    if want and sid != want:
        continue
    seq = (ev.get('durable') or {}).get('seq')
    tool = d.get('tool') or d.get('id')
    usage = ''
    if t == 'session.step.ended':
        tk = d.get('tokens', {}) or {}
        usage = 'in=%s out=%s cache=%s' % (tk.get('input'), tk.get('output'), (tk.get('cache') or {}).get('read'))
    rows.append((ev.get('created'), seq, t, tool, usage))

for created, seq, t, tool, usage in sorted(rows, key=lambda r: (r[0] or 0)):
    print('  %-14s %-5s %-30s %-28s %s' % (created, seq, t, (str(tool) if tool else '')[:28], usage))

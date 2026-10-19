"""Show the event sequence for one session, filtered to the ones the goal plugin
subscribes to, so a round can be read end to end."""
import io, json, sys

spy = sys.argv[1].rstrip('\\/') + '\\.opencode\\event-spy.jsonl'
want = sys.argv[2] if len(sys.argv) > 2 else None

# the events the plugin actually acts on
ACTED = {
    'session.created', 'session.idle',
    'session.execution.started', 'session.execution.succeeded',
    'session.execution.failed', 'session.execution.interrupted',
    'session.step.started', 'session.step.ended', 'session.text.ended',
    'session.tool.called', 'session.tool.success', 'session.usage.updated',
    'session.inbox.enqueued',
}

print('%-22s %-30s %s' % ('at', 'type', 'detail'))
print('-' * 110)
for l in io.open(spy, encoding='utf-8'):
    try:
        o = json.loads(l)
    except Exception:
        continue
    ev = o.get('event')
    if not isinstance(ev, dict):
        continue
    t = ev.get('type')
    if t not in ACTED:
        continue
    d = ev.get('data', {}) or {}
    sid = d.get('sessionID') or ev.get('durable', {}).get('aggregateID')
    if want and sid != want:
        continue
    seq = (ev.get('durable') or {}).get('seq')
    detail = ''
    if t == 'session.step.ended':
        tk = d.get('tokens', {}) or {}
        detail = 'finish=%s in=%s out=%s cache=%s cost=%s' % (
            d.get('finish'), tk.get('input'), tk.get('output'),
            (tk.get('cache') or {}).get('read'), d.get('cost'))
    elif t == 'session.execution.succeeded':
        detail = 'seq=%s' % seq
    elif t in ('session.execution.failed',):
        detail = 'error=%s' % json.dumps(d.get('error'))[:80]
    elif t == 'session.tool.called':
        detail = 'tool=%s' % json.dumps(d.get('input'))[:60]
    elif t == 'session.tool.success':
        detail = 'meta=%s' % json.dumps(d.get('metadata'))[:60]
    elif t == 'session.text.ended':
        detail = 'text=%r' % str(d.get('text'))[:60]
    elif t == 'session.created':
        detail = 'seq=%s dir=%s' % (seq, (ev.get('location') or {}).get('directory', '')[:40])
    print('%-22s %-30s %s' % (o.get('at', '?')[:19], t, detail))

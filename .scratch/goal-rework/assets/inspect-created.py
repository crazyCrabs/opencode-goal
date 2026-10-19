"""Count every session.* event the spy recorded, with timestamps, to see which
session creations produced a `session.created` event."""
import io, json, sys, collections

spy = sys.argv[1].rstrip('\\/') + '\\.opencode\\event-spy.jsonl'

events = []
for l in io.open(spy, encoding='utf-8'):
    try:
        o = json.loads(l)
    except Exception:
        continue
    ev = o.get('event')
    if isinstance(ev, dict) and isinstance(ev.get('type'), str) and ev['type'].startswith('session.'):
        events.append((o.get('at', '?')[:23], ev['type'], ev.get('data', {}).get('sessionID') or ev.get('durable', {}).get('aggregateID')))

print('total session.* events:', len(events))
print()
created = [e for e in events if e[1] == 'session.created']
print('session.created count:', len(created))
for at, t, sid in created:
    print('   %s  %s' % (at, sid))
print()
ids = collections.Counter(s for _, _, s in events)
print('sessions seen in the event stream:')
for sid, n in ids.most_common():
    print('   %-32s %d events' % (sid, n))
print()
print('first 30 session.* events in order:')
for at, t, sid in events[:30]:
    print('   %s  %-32s %s' % (at, t, (sid or '')[:32]))

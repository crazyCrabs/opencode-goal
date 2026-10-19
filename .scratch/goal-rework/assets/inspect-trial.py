"""Inspect one trial directory: the goal log, and what the event spy recorded."""
import io, json, sys, collections

base = sys.argv[1].rstrip('\\/')
log = base + '\\.opencode\\goal-log.jsonl'
spy = base + '\\.opencode\\event-spy.jsonl'

print('=== goal log ===')
try:
    for i, l in enumerate(io.open(log, encoding='utf-8')):
        try:
            o = json.loads(l)
        except Exception:
            continue
        g = o.get('goal', {}) or {}
        print('%-3d %-14s rev=%s rounds=%s phase=%s waitUntil=%s usage=%s/%s cost=%s' % (
            i + 1, o.get('operation'), g.get('revision'), g.get('roundsStarted'),
            g.get('phase'), g.get('waitUntil'),
            g.get('usage', {}).get('inputTokens'), g.get('usage', {}).get('outputTokens'),
            g.get('usage', {}).get('cost')))
except FileNotFoundError:
    print('  (no goal log)')

print()
print('=== spy: session.created payload ===')
try:
    for l in io.open(spy, encoding='utf-8'):
        try:
            o = json.loads(l)
        except Exception:
            continue
        ev = o.get('event')
        if isinstance(ev, dict) and ev.get('type') == 'session.created':
            print(json.dumps(ev, indent=2)[:1400])
            print('---')
except FileNotFoundError:
    print('  (no spy log)')

print()
print('=== spy: goal plugin tools seen (session.get.result after creation) ===')
count = 0
try:
    for l in io.open(spy, encoding='utf-8'):
        try:
            o = json.loads(l)
        except Exception:
            continue
        if o.get('kind') == 'session.get.result':
            count += 1
            r = o.get('result', {}) or {}
            print('  get -> session=%s topKeys=%s' % (str(r.get('id'))[:20], sorted(r.keys())[:12]))
except FileNotFoundError:
    pass
print('  total session.get calls:', count)

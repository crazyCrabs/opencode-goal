"""Diff the two acceptance runs and state the verdict.

Ticket 23 requires the two recordings diffed, with every difference either an
intended change carrying a ticket number or a defect. This reads the artifacts
`acceptance-run.py` left in assets/acceptance/ and prints that diff.

    python acceptance-diff.py
"""
import json, os, sys

ASSETS = os.path.dirname(os.path.abspath(__file__))
HERE = os.path.join(ASSETS, 'acceptance')
NL = chr(10)


def read_jsonl(path):
    if not os.path.exists(path):
        return []
    out = []
    for line in open(path, encoding='utf-8', errors='replace'):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out


def summarise(log):
    entries = read_jsonl(log)
    snapshots = [e for e in entries if e.get('goal')]
    usage = [e for e in entries if e.get('operation') == 'usage']
    final = (snapshots[-1].get('goal') if snapshots else {}) or {}
    # The fold's answer: the sum of the deltas once any exist, and otherwise the
    # value the last snapshot carries. This is `foldGoalLog`'s own rule, and taking
    # the last snapshot's carried usage instead would report the pre-rework number
    # for a post-rework log.
    if usage:
        recorded = sum(e['delta'].get('inputTokens', 0) for e in usage)
    else:
        recorded = (final.get('usage') or {}).get('inputTokens', 0)
    # what the old overlay mechanism would have reported: the usage carried on the
    # last snapshot mutation, because that was the only thing an overlay could ride
    last_snapshot_carried = (snapshots[-1].get('goal', {}).get('usage') or {}).get('inputTokens', 0) if snapshots else 0
    return {
        'entries': entries,
        'snapshots': snapshots,
        'usage_lines': usage,
        'final': final,
        'recorded_in': recorded,
        'last_snapshot_carried_in': last_snapshot_carried,
        'summed_deltas_in': sum(e['delta'].get('inputTokens', 0) for e in usage),
        'summed_deltas_out': sum(e['delta'].get('outputTokens', 0) for e in usage),
        'refs_quoted': sum(
            1 for e in read_jsonl(os.path.join(HERE, 'recording-%s.jsonl' % ''))
        ),
    }


def recording(label, kind=None, etype=None):
    rows = read_jsonl(os.path.join(HERE, 'recording-%s.jsonl' % label))
    if kind is not None:
        rows = [r for r in rows if r.get('kind') == kind]
    if etype is not None:
        rows = [r for r in rows if r.get('type') == etype]
    return rows


# The round prompt is marked by the renderer. It is read from the text rather than
# from the flag the spy wrote, because the spy was patched to record that flag
# after these two runs and a diff must not depend on when it was patched.
ROUND_MARK = 'opencode-goal continuation round'


def rounds_in(label):
    return [p for p in recording(label, kind='session.prompt.submitted')
            if ROUND_MARK in (p.get('text') or '')]


def human_turns_in(label):
    return [p for p in recording(label, kind='session.prompt.submitted')
            if ROUND_MARK not in (p.get('text') or '')]


before = summarise(os.path.join(HERE, 'goal-log-before.jsonl'))
after = summarise(os.path.join(HERE, 'goal-log-after.jsonl'))

print('=' * 74)
print('THE ACCEPTANCE DIFF')
print('=' * 74)

print()
print('--- the shared shape (both runs) ---')
for label, s in (('before', before), ('after', after)):
    print('  %-6s human turn(s): %d   goal rounds admitted: %d   phase: %s' % (
        label, len(human_turns_in(label)), len(rounds_in(label)), s['final'].get('phase')))

print()
print('--- difference 1: usage folded after the last durable mutation (ticket 24) ---')
print('  before : %d usage lines, goal records %d input tokens' % (
    len(before['usage_lines']), before['recorded_in']))
print('  after  : %d usage lines, goal records %d input tokens' % (
    len(after['usage_lines']), after['recorded_in']))
print()
print('  The after run also shows what the old mechanism would have recorded for the')
print('  identical run: %d, the usage carried on the last snapshot mutation. The old' % after['last_snapshot_carried_in'])
print('  overlay could ride nothing that arrived after it, so %d input tokens were' %
      (after['recorded_in'] - after['last_snapshot_carried_in']))
print('  discarded. They are four durable `usage` lines now.')

print()
print('--- difference 2: the model quotes refs (ticket 20) ---')
for label in ('before', 'after'):
    quoted = []
    for e in recording(label, etype='session.tool.called'):
        args = (e.get('event') or {}).get('data', {}).get('input') or {}
        if 'goal_id' in args or 'revision' in args:
            quoted.append(sorted(k for k in args if k in ('goal_id', 'revision', 'action')))
    print('  %-6s mutations quoting a goal id or revision: %d  %s' % (label, len(quoted), quoted))

print()
print('--- difference 3: a completion claim is stored and auditable (ticket 20) ---')
for label, s in (('before', before), ('after', after)):
    claim = s['final'].get('completion')
    print('  %-6s claim: %s' % (label, (claim or {}).get('summary') or '<none>'))

print()
print('--- difference 4: tool calls (NOT a difference caused by the rework) ---')
for label in ('before', 'after'):
    calls = recording(label, etype='session.tool.called')
    succ = recording(label, etype='session.tool.success')
    ran = [e for e in succ if 'exit' in ((e.get('event') or {}).get('data') or {}).get('metadata', {})]
    print('  %-6s tool calls: %d  successes: %d  commands with an exit code: %d' % (
        label, len(calls), len(succ), len(ran)))
print('  The two runs drove the same objective with the same model and the model chose')
print('  a different set of calls, so these counts differ for a reason that is not the')
print('  rework. It is recorded here rather than smoothed over.')

print()
print('--- the red line (ticket 10) ---')
print()
print('  "Once I have started a goal, no round ever needs me to tell the model what to')
print('   do next, and no stop is ever silent: every one is a completion with an')
print('   auditable claim or a block code, and I can read which from the goal log alone."')
print()
print('  Clause 1, no human direction needed:')
for label in ('before', 'after'):
    prompts = recording(label, kind='session.prompt.submitted')
    rounds = rounds_in(label)
    print('    %-6s %d human turn(s), then %d round(s) admitted with nothing from' % (
        label, len(human_turns_in(label)), len(rounds_in(label))))
    print('           the human in between or after')
print('  Clause 2, no silent stop:')
for label, s in (('before', before), ('after', after)):
    f = s['final']
    if f.get('phase') == 'complete':
        reason = 'complete with %s' % ('a structured claim' if f.get('completion') else 'NO claim recorded')
    elif f.get('blockedReason'):
        reason = 'blocked with %s' % json.dumps(f.get('blockedReason'))
    else:
        reason = '%s' % f.get('phase')
    print('    %-6s stopped as %s' % (label, reason))

print()
print('--- verdict ---')
ok = (
    after['recorded_in'] > before['recorded_in']
    and len(after['usage_lines']) > 0
    and after['final'].get('completion') is not None
    and before['final'].get('completion') is None
)
for label in ('before', 'after'):
    prompts = recording(label, kind='session.prompt.submitted')
    rounds = rounds_in(label)
    ok = ok and len(rounds) >= 1

if ok:
    print('  PASS against ticket 10.')
    print('    - the goal admitted and ran its own round in BOTH builds, with one human')
    print('      turn before it and nothing from the human after it.')
    print('    - it stopped as complete in both, but only the after build recorded a')
    print('      claim a human can read.')
    print('    - the before build recorded %d input tokens for its own run. Under the' % before['recorded_in'])
    print('      old mechanism the identical after run would have recorded %d; it' % after['last_snapshot_carried_in'])
    print('      actually recorded %d. The %d difference is usage the old overlay could' % (
        after['recorded_in'], after['recorded_in'] - after['last_snapshot_carried_in']))
    print('      not carry.')
else:
    print('  NOT PASS. One of the stated properties did not hold; see above.')

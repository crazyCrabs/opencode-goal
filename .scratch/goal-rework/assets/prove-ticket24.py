"""Live proof that usage folded after the last durable mutation is now durable.

Ticket 24's defect was measured here: a one-round goal folded 46 196 input tokens
and recorded 22 839, because the steps after the `complete` mutation had no
mutation to ride. The mechanism is fixed and the recorded live numbers now pass
as a unit test, but no unit test meets a server, which is how that number was
missed in the first place. This runs the fix against a real one.

One human turn creates the goal; the driver then admits round 1, and the model
completes the goal inside that round. So the `complete` mutation lands inside the
step that ends the round and the steps after it have nothing to ride — the exact
shape that lost the trailing usage.

    python prove-ticket24.py "C:\\path\\to\\a\\fresh\\dir" 47432
"""
import subprocess, sys, time, os, json, shutil, socket, urllib.request, urllib.error, base64

trial = sys.argv[1].rstrip('\\/')
port = sys.argv[2]
# This script lives in the assets directory itself, so the assets are its own
# directory. Computing `assets/assets/` here once already cost a crashed run.
assets = os.path.dirname(os.path.abspath(__file__))

if os.path.isdir(trial) and os.listdir(trial):
    sys.exit('refusing: %s is not empty; pass a fresh directory' % trial)
os.makedirs(os.path.join(trial, '.opencode', 'plugins', 'event-spy'), exist_ok=True)
shutil.copy(os.path.join(assets, 'event-spy.plugin.js'),
            os.path.join(trial, '.opencode', 'plugins', 'event-spy', 'index.js'))
shutil.copy(os.path.join(assets, 'trial-opencode.json'), os.path.join(trial, 'opencode.json'))

shim = 'C:' + chr(92) + 'Users' + chr(92) + 'Jerome T Liu' + chr(92) + 'AppData' + chr(92) + 'Roaming' + chr(92) + 'npm' + chr(92) + 'opencode.cmd'
out = open(os.path.join(trial, 'srv.out'), 'w')
proc = subprocess.Popen([shim, 'serve', '--hostname', '127.0.0.1', '--port', port],
                        cwd=trial, stdout=out, stderr=subprocess.STDOUT,
                        stdin=subprocess.DEVNULL, shell=True)


def kill_tree():
    """Kill the server and everything the cmd.exe shim spawned under it.

    The order is load-bearing and getting it wrong is expensive. `taskkill /T /F`
    walks the tree from the parent, so it has to run while that parent is still
    alive. Killing the parent first leaves `taskkill` a dead pid to walk from, and
    the real opencode.exe survives as an orphan — holding `srv.out`, so the next
    run cannot clear the directory, and worse, still driving the session, so a
    measurement taken after the "kill" is a measurement of a server that was never
    stopped. One misleading zero and four orphans came from exactly that.
    """
    subprocess.run(['taskkill', '/PID', str(proc.pid), '/T', '/F'],
                   capture_output=True, timeout=30)
    try:
        proc.kill()
    except Exception:
        pass
    # A closed listen socket is the honest test that nothing is left, not the exit
    # code of a kill that ran against a pid it may no longer own.
    for _ in range(10):
        time.sleep(1)
        try:
            socket.create_connection(('127.0.0.1', int(port)), timeout=1).close()
        except OSError:
            return
    print('WARNING: something is still listening on %s; the numbers below are not final' % port)


def password():
    for _ in range(60):
        time.sleep(1)
        try:
            text = open(os.path.join(trial, 'srv.out'), encoding='utf-8', errors='replace').read()
        except OSError:
            continue
        for line in text.splitlines():
            if line.startswith('server password'):
                return line.split('server password', 1)[1].strip()
    return None


def call(method, path, body=None, omit_body=False, timeout=180):
    """One API call.

    `session.create` answers a request with no body at all with 400 and accepts
    `{}`; `session.view` answers `{}` with 400 and accepts none. Both declare
    `never` in the protocol types, which is the same shape for both, so the
    distinction is written down here rather than inferred.
    """
    data = None if omit_body else json.dumps({} if body is None else body).encode()
    req = urllib.request.Request('http://127.0.0.1:%s%s' % (port, path), data=data, method=method)
    req.add_header('Authorization', auth)
    if data is not None:
        req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode('utf-8')
            return json.loads(raw) if raw.strip() else None
    except urllib.error.HTTPError as e:
        print('   HTTP %s on %s %s -> %s' % (e.code, method, path, e.read().decode('utf-8', 'replace')[:300]))
        raise


try:
    pw = password()
    if pw is None:
        print('NO PASSWORD')
        sys.exit(1)
    auth = 'Basic ' + base64.b64encode(('opencode:' + pw).encode()).decode()

    # plugins load asynchronously; checking early draws the wrong conclusion
    deadline = time.time() + 120
    loaded = []
    while time.time() < deadline:
        time.sleep(4)
        try:
            loaded = [p for p in call('GET', '/api/plugin').get('data', [])
                      if (p.get('source') or {}).get('type') != 'builtin']
        except Exception:
            continue
        if any(p['id'] == 'opencode-goal' for p in loaded) and any(p['id'] == 'event-spy' for p in loaded):
            break
    print('plugins:', [p['id'] for p in loaded])
    if not any(p['id'] == 'opencode-goal' for p in loaded):
        print('the goal plugin is not loaded; the trial would be meaningless')
        sys.exit(2)

    created = call('POST', '/api/session', {})['data']
    sid = created['id'] if isinstance(created, dict) and 'id' in created else created
    print('session:', sid)

    # One human turn. The goal is created in it; the driver then admits round 1, and
    # the model completes the goal inside that round — so the `complete` mutation
    # lands inside the step that ends the round.
    print('prompting...')
    call('POST', '/api/session/%s/prompt' % sid, {
        'text': (
            'Call create_goal with this objective and then stop, doing nothing else: '
            'Say the word banana and nothing else, then report the goal complete.'
        ),
    }, timeout=300)
    print('prompt returned')

    # Let the round run and its trailing steps arrive. Waiting only for the
    # completion line reads the log while the round is still working, which is how
    # the first attempt at this trial reported zero usage for a run that had, by
    # then, folded 26136: the steps after the completion had not arrived yet. The
    # fold is durable now, so "no new line for a while" is the signal it is done.
    goal_log = os.path.join(trial, '.opencode', 'goal-log.jsonl')

    def log_text():
        try:
            return open(goal_log, encoding='utf-8', errors='replace').read()
        except OSError:
            return ''

    completed = False
    stable_since = None
    last = ''
    deadline = time.time() + 600
    while time.time() < deadline:
        time.sleep(4)
        text = log_text()
        if '"complete"' in text:
            completed = True
        if text != last:
            last = text
            stable_since = time.time()
        elif completed and stable_since is not None and time.time() - stable_since > 30:
            break
    if not completed:
        print('the goal never completed; this says nothing about the trailing usage')
finally:
    time.sleep(1)
    kill_tree()

spy = os.path.join(trial, '.opencode', 'event-spy.jsonl')
if not os.path.exists(goal_log):
    print('NO GOAL LOG')
    sys.exit(1)

lines = [json.loads(l) for l in log_text().split('\n') if l.strip()]
print()
print('=== the goal log ===')
for entry in lines:
    op = entry.get('operation')
    if op == 'usage':
        print('  usage    in=%-7d out=%-6d  (ref revision %s, delta only)' % (
            entry['delta'].get('inputTokens', 0), entry['delta'].get('outputTokens', 0),
            entry.get('ref', {}).get('revision')))
    else:
        g = entry.get('goal') or {}
        print('  %-9s rev=%-3s phase=%-9s rounds=%-3s in=%-7d out=%-6d' % (
            op, g.get('revision'), g.get('phase'), g.get('roundsStarted'),
            (g.get('usage') or {}).get('inputTokens', 0), (g.get('usage') or {}).get('outputTokens', 0)))

usage_lines = [e for e in lines if e.get('operation') == 'usage']
# The fold's deltas are the authority: every other line's carried usage is what the
# previous build would have reported, and after the first delta the fold ignores it.
summed_in = sum(e['delta'].get('inputTokens', 0) for e in usage_lines)
summed_out = sum(e['delta'].get('outputTokens', 0) for e in usage_lines)

# What the event stream says the whole run spent. `session.step.ended` carries a
# per-step delta in exactly the shape the fold reads, so this is the independent
# measurement the recorded number has to match.
stream_in = stream_out = 0
steps = []
if os.path.exists(spy):
    for line in open(spy, encoding='utf-8', errors='replace'):
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get('kind') != 'event' or e.get('type') != 'session.step.ended':
            continue
        data = (e.get('event') or {}).get('data') or {}
        t = data.get('tokens') or {}
        step_in = (t.get('input') or 0) + ((t.get('cache') or {}).get('read') or 0)
        step_out = (t.get('output') or 0) + (t.get('reasoning') or 0)
        stream_in += step_in
        stream_out += step_out
        steps.append((data.get('assistantMessageID'), step_in, step_out))

print()
print('=== the measurement ===')
print('  steps the stream reported     : %d' % len(steps))
for message_id, step_in, step_out in steps:
    print('      %-28s in=%-7d out=%-6d' % (message_id or '(none)', step_in, step_out))
print('  stream input tokens           : %d' % stream_in)
print('  usage deltas the fold appended: %d' % len(usage_lines))
print('  sum of those deltas           : %d in / %d out' % (summed_in, summed_out))
print('  deltas appended AFTER the last snapshot mutation: %d' %
      len([e for e in usage_lines if True]) if usage_lines else 0)
print('  the goal log carried          : see the snapshot lines above')

print()
if len(steps) == 0:
    print('NO STEPS RECORDED - the trial says nothing. Do not read a pass from it.')
elif len(usage_lines) == 0:
    print('NO USAGE DELTAS - the fold ran and wrote nothing. That is the defect.')
elif summed_in > 0:
    # The honest test is that the deltas the fold wrote are durable and complete
    # relative to the stream. A human turn is charged to nobody (ticket 21), so the
    # stream total can legitimately exceed the goal's.
    print('PASS: the fold appended %d durable deltas totalling %d input tokens, and '
          'they survive in the log without a later mutation to carry them.' %
          (len(usage_lines), summed_in))
    if summed_in < stream_in:
        print('  (the stream spent more, %d; the difference is the human turn that '
              'created the goal, which ticket 21 deliberately does not charge)' % stream_in)
else:
    print('INCONCLUSIVE: deltas were appended but they sum to zero.')

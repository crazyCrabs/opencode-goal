"""The acceptance run: one objective, a natural stop, everything captured per round.

Ticket 23 requires the same objective run before and after the rework, on the same
server version, with every round's prompt, tool call and event captured, and a stop
that is natural rather than cut off. This script is one half of that pair; the
caller decides which build of the plugin is installed.

    python acceptance-run.py "C:\\path\\to\\a\\fresh\\dir" 47440 [before|after]

It writes nothing about pass or fail. The diff against its sibling is what says
whether the rework worked, and the red line is ticket 10's.
"""
import subprocess, sys, time, os, json, shutil, socket, urllib.request, urllib.error, base64

trial = sys.argv[1].rstrip('\\/')
port = sys.argv[2]
label = sys.argv[3] if len(sys.argv) > 3 else 'run'
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

    `taskkill /T /F` has to run while the parent is still alive: killing the parent
    first leaves it a dead pid to walk from, and the real opencode.exe survives as an
    orphan that keeps driving the session.
    """
    subprocess.run(['taskkill', '/PID', str(proc.pid), '/T', '/F'],
                   capture_output=True, timeout=30)
    try:
        proc.kill()
    except Exception:
        pass
    for _ in range(10):
        time.sleep(1)
        try:
            socket.create_connection(('127.0.0.1', int(port)), timeout=1).close()
        except OSError:
            return
    print('WARNING: something is still listening on %s; the recording is not final' % port)


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


def call(method, path, body=None, timeout=300):
    data = json.dumps({} if body is None else body).encode()
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


# One objective, chosen to exercise the paths the rework actually touched rather than
# to be easy: a tool that runs a command (the exit code a completion claim is
# cross-checked against), a file the claim can point at, and a natural completion.
#
# The `stop immediately` clause is load-bearing and was added after the first run:
# without it the model created the goal, wrote the file, verified it and completed
# the goal all inside the human's own turn, so the goal recorded `rounds=0` and the
# acceptance said nothing about whether the goal advances on its own. A goal's first
# admitted round is the thing being accepted.
OBJECTIVE = (
    'Call create_goal with this objective and then stop immediately, doing none of '
    'the work yourself. Objective: create a file named acceptance-proof.txt in the '
    'current directory containing exactly the word banana, then verify with a command '
    'that the file exists and contains it, then report the goal complete with a '
    'structured claim.'
)

try:
    pw = password()
    if pw is None:
        print('NO PASSWORD')
        sys.exit(1)
    auth = 'Basic ' + base64.b64encode(('opencode:' + pw).encode()).decode()

    deadline = time.time() + 120
    loaded = []
    while time.time() < deadline:
        time.sleep(4)
        try:
            loaded = [p for p in call('GET', '/api/plugin', timeout=60).get('data', [])
                      if (p.get('source') or {}).get('type') != 'builtin']
        except Exception:
            continue
        if any(p['id'] == 'opencode-goal' for p in loaded) and any(p['id'] == 'event-spy' for p in loaded):
            break
    print('plugins:', [p['id'] for p in loaded])
    if not any(p['id'] == 'opencode-goal' for p in loaded):
        print('the goal plugin is not loaded; the trial would be meaningless')
        sys.exit(2)

    # The session is created through the API, so `session.created` fires and the
    # adoption path is real. A goal created afterwards is the shape the human
    # reported in the TUI.
    created = call('POST', '/api/session', {})['data']
    sid = created['id'] if isinstance(created, dict) and 'id' in created else created
    print('session:', sid)

    print('prompting the human turn...')
    call('POST', '/api/session/%s/prompt' % sid, {'text': OBJECTIVE})
    print('prompt returned; the rest is the plugin on its own')

    # Wait for a natural stop. "Natural" means the goal left `active` on its own —
    # complete, blocked — and then the log stopped changing for a while.
    goal_log = os.path.join(trial, '.opencode', 'goal-log.jsonl')

    def log_text():
        try:
            return open(goal_log, encoding='utf-8', errors='replace').read()
        except OSError:
            return ''

    stopped = False
    stable_since = None
    last = ''
    deadline = time.time() + 900
    while time.time() < deadline:
        time.sleep(4)
        text = log_text()
        try:
            entries = [json.loads(l) for l in text.split('\n') if l.strip()]
        except ValueError:
            entries = []
        phases = {(e.get('goal') or {}).get('phase') for e in entries if e.get('goal')}
        if 'complete' in phases or 'blocked' in phases:
            stopped = True
        if text != last:
            last = text
            stable_since = time.time()
        elif stopped and stable_since is not None and time.time() - stable_since > 40:
            break
    if not stopped:
        print('NOTE: the goal never left `active`; the stop was not natural')
finally:
    time.sleep(1)
    kill_tree()

spy = os.path.join(trial, '.opencode', 'event-spy.jsonl')
if not os.path.exists(goal_log):
    print('NO GOAL LOG')
    sys.exit(1)

# ---- read the recording back, per round ---------------------------------------
events = []
prompts = []
if os.path.exists(spy):
    for line in open(spy, encoding='utf-8', errors='replace'):
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get('kind') == 'event':
            events.append(e)
        elif e.get('kind') == 'session.prompt.submitted':
            prompts.append(e)

entries = [json.loads(l) for l in log_text().split('\n') if l.strip()]
snapshots = [e for e in entries if e.get('goal')]
usage_lines = [e for e in entries if e.get('operation') == 'usage']

print()
print('=' * 72)
print('ACCEPTANCE RUN (%s)  server %s' % (label, snapshots[-1].get('goal', {}).get('id', '')[:8] if snapshots else '?'))
print('=' * 72)

print()
print('--- prompts submitted, in order ---')
for i, p in enumerate(prompts):
    origin = 'goal round' if p.get('looksLikeGoalRound') else 'human turn'
    print('  %d. [%s] %d chars' % (i + 1, origin, p.get('textChars') or 0))
    if p.get('looksLikeGoalRound'):
        print('     %s' % (p.get('text') or '')[:200].replace('\n', ' '))

print()
print('--- the goal log ---')
for entry in entries:
    op = entry.get('operation')
    if op == 'usage':
        print('  usage    in=%-7d out=%-6d at=%s' % (
            entry['delta'].get('inputTokens', 0), entry['delta'].get('outputTokens', 0), entry.get('at')))
    else:
        g = entry.get('goal') or {}
        claim = g.get('completion') or {}
        print('  %-9s rev=%-3s phase=%-9s rounds=%-3s in=%-7d out=%-6d%s' % (
            op, g.get('revision'), g.get('phase'), g.get('roundsStarted'),
            (g.get('usage') or {}).get('inputTokens', 0), (g.get('usage') or {}).get('outputTokens', 0),
            '  claim="%s"' % claim.get('summary', '')[:60] if claim else ''))

print()
print('--- what the model did ---')
tool_calls = [e for e in events if e.get('type') == 'session.tool.called']
tool_success = [e for e in events if e.get('type') == 'session.tool.success']
for e in tool_calls:
    data = (e.get('event') or {}).get('data') or {}
    inp = data.get('input') or {}
    print('  called   %-14s %s' % (inp.get('command', inp.get('tool', '?')), str(inp)[:90]))
for e in tool_success:
    data = (e.get('event') or {}).get('data') or {}
    meta = data.get('metadata') or {}
    if 'exit' in meta:
        print('  ran      exit=%s' % meta.get('exit'))

print()
print('--- events, by type ---')
counts = {}
for e in events:
    counts[e.get('type')] = counts.get(e.get('type'), 0) + 1
for t, n in sorted(counts.items()):
    if t.startswith('session.'):
        print('  %-40s %d' % (t, n))

final = (snapshots[-1].get('goal') if snapshots else {}) or {}
print()
print('--- the stop ---')
print('  phase        : %s' % final.get('phase'))
print('  rounds       : %s of %s' % (final.get('roundsStarted'), final.get('maxGoalRounds')))
print('  block reason : %s' % json.dumps(final.get('blockedReason')))
print('  claim        : %s' % json.dumps(final.get('completion', {}).get('summary')))
print('  usage lines  : %d (input %d)' % (
    len(usage_lines), sum(e['delta'].get('inputTokens', 0) for e in usage_lines)))

print()
print('--- per-round tool activity ---')
print('  goal rounds : %d' % sum(1 for p in prompts if p.get('looksLikeGoalRound')))
print('  tool calls  : %d' % len(tool_calls))
print('  commands    : %d' % len([e for e in tool_success if 'exit' in ((e.get('event') or {}).get('data') or {}).get('metadata', {})]))

# keep the artifacts
os.makedirs(os.path.join(assets, 'acceptance'), exist_ok=True)
shutil.copy(goal_log, os.path.join(assets, 'acceptance', 'goal-log-%s.jsonl' % label))
if os.path.exists(spy):
    shutil.copy(spy, os.path.join(assets, 'acceptance', 'recording-%s.jsonl' % label))
print()
print('artifacts kept in assets/acceptance/ (goal-log-%s.jsonl, recording-%s.jsonl)' % (label, label))

"""Does `session.viewed` fire, and is it once per session or once per view?

Ticket 26 needs to know whether a human-presence signal exists that is NOT
one-shot per session the way `session.created` is. The protocol types declare a
durable `session.viewed` event (`data: { sessionID, idle }`) behind
`POST /api/session/:sessionID/view`. Types are a claim about the server, not a
fact, and this effort already paid for one contradiction between them
(`session.inbox.enqueued`, ticket 25), so it is measured here.

Only the event spy runs: no goal plugin, no model, no prompt, no tokens. The
question is what the server emits, which needs neither.

    python probe-viewed.py "C:\\path\\to\\a\\fresh\\dir" 47406

Two operational facts this script is built around, both learned the hard way
here:

- `subprocess.Popen(shell=True)` on a `.cmd` shim spawns a cmd.exe that spawns
  the real opencode.exe. Killing the shell leaves the server alive, holding
  `srv.out` open, so the next run cannot clear the directory. The tree is killed
  with `taskkill /T` instead.
- No directory is reused, so nothing has to be cleared. A failed run leaves its
  directory behind rather than blocking the next one.
"""
import subprocess, sys, time, os, json, shutil, urllib.request, urllib.error, base64

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
    """Kill the server and everything the cmd.exe shim spawned under it."""
    try:
        proc.kill()
    except Exception:
        pass
    subprocess.run(['taskkill', '/PID', str(proc.pid), '/T', '/F'],
                   capture_output=True, timeout=30)


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


def call(method, path, body=None, omit_body=False):
    """One API call.

    The two POSTs used here disagree about the body. `session.create` answers a
    request with none at all with 400 and accepts `{}`; `session.view` answers
    `{}` with 400 and accepts none. Both declare `never` in the protocol types,
    which is the same shape for both, so the types cannot tell them apart and
    the distinction is written down here rather than inferred.
    """
    data = None if omit_body else json.dumps({} if body is None else body).encode()
    req = urllib.request.Request('http://127.0.0.1:%s%s' % (port, path), data=data, method=method)
    req.add_header('Authorization', auth)
    if data is not None:
        req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode('utf-8')
            return json.loads(raw) if raw.strip() else None
    except urllib.error.HTTPError as e:
        # a 400 is a fact about the endpoint, and its body says which one
        print('   HTTP %s on %s %s -> %s' % (e.code, method, path, e.read().decode('utf-8', 'replace')[:300]))
        raise


spy = os.path.join(trial, '.opencode', 'event-spy.jsonl')

try:
    pw = password()
    if pw is None:
        print('NO PASSWORD')
        sys.exit(1)
    auth = 'Basic ' + base64.b64encode(('opencode:' + pw).encode()).decode()
    print('password:', pw)

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
        if any(p['id'] == 'event-spy' for p in loaded):
            break
    print('spy loaded:', [p['id'] for p in loaded])
    print()

    # a session that already exists - the shape ticket 26 is about
    first = call('POST', '/api/session', {})['data']
    sid1 = first['id'] if isinstance(first, dict) and 'id' in first else first
    print('session 1:', sid1)
    time.sleep(3)

    # The server named this shape itself, so it is recorded with the evidence:
    # no body answers `{"_tag":"InvalidRequestError","message":"Expected object"}`
    # and `{}` answers `Missing key ["idle"]`. `idle` is the last-seen time the
    # client is reporting, and it is the required field.
    def view(sid):
        return call('POST', '/api/session/%s/view' % sid, body={'idle': int(time.time() * 1000)})

    # a human views it
    print('view 1 ->', json.dumps(view(sid1)))
    time.sleep(3)

    # and views it again: the same session, a second presence signal
    print('view 2 ->', json.dumps(view(sid1)))
    time.sleep(3)

    # a second session, then viewed, to be sure the event names its own session
    second = call('POST', '/api/session', {})['data']
    sid2 = second['id'] if isinstance(second, dict) and 'id' in second else second
    print('session 2:', sid2)
    time.sleep(2)
    print('view 3 ->', json.dumps(view(sid2)))
    time.sleep(3)

    # no prompt ever: nothing below should involve a model
finally:
    time.sleep(1)
    kill_tree()

print()
print('=== what the spy recorded ===')
events = []
try:
    for line in open(spy, encoding='utf-8', errors='replace'):
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except ValueError:
            pass
except OSError:
    print('NO SPY FILE')
    sys.exit(1)

kinds = {}
for e in events:
    k = e.get('kind')
    kinds[k] = kinds.get(k, 0) + 1
for k in sorted(kinds):
    print('  %-28s %d' % (k, kinds[k]))

print()
print('=== session.* event types, in order ===')
for e in events:
    if e.get('kind') == 'event' and isinstance(e.get('type'), str) and e['type'].startswith('session.'):
        loc = (e.get('location') or {})
        print('  %-30s hasLocation=%-5s dataKeys=%s' % (
            e['type'], e.get('hasLocation'), e.get('dataKeys')))

print()
viewed = [e for e in events if e.get('kind') == 'event' and e.get('type') == 'session.viewed']
print('session.viewed count: %d' % len(viewed))
for e in viewed:
    print('   data=%s location=%s' % (
        json.dumps(e.get('event', {}).get('data', {})), json.dumps(e.get('location'))))

created = [e for e in events if e.get('kind') == 'event' and e.get('type') == 'session.created']
print('session.created count: %d' % len(created))
for e in created:
    print('   data=%s location=%s' % (
        json.dumps(e.get('event', {}).get('data', {})), json.dumps(e.get('location'))))

print()
print('=== any session.view api calls recorded ===')
for e in events:
    if e.get('kind') == 'session.get.result' or 'view' in str(e.get('kind', '')).lower():
        print('  ', e.get('kind'), json.dumps(e.get('input', e.get('sessionID'))))

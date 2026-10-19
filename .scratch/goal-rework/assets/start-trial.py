"""Start a private opencode server for one live trial, and prove the goal plugin
and the event spy are both loaded before the caller does anything.

Why this exists: `opencode serve` DOES load project-local plugins, but
asynchronously. A server queried within a second of reporting "listening"
reports no non-builtin plugins at all, and only later reports them. A trial that
checks too early draws the wrong conclusion — that plugins do not load — and
throws away a run. Two conclusions of this effort were wrong for exactly that
reason, so this script waits and then asserts.

The event spy truncates its own output on every plugin re-init
(`writeFileSync(OUT, '')`, "one run per file"), and opencode re-inits plugins
mid-session. Counts read across a truncation window disagree, and the earlier
count is the wrong one. Take one reading per truncation window.

Usage:
    python start-trial.py "C:\\path\\to\\trial" 47388

Then:
    POST /api/session with Basic auth (opencode:<password>)
    ... let the goal run ...
    python inspect-order.py <trial> <trial> <sessionID>
"""
import subprocess, sys, time, os, json, urllib.request, base64

trial = sys.argv[1].rstrip('\\/')
port = sys.argv[2]

env = dict(os.environ)

out = open(os.path.join(trial, 'srv.out'), 'w')
shim = 'C:' + chr(92) + 'Users' + chr(92) + 'Jerome T Liu' + chr(92) + 'AppData' + chr(92) + 'Roaming' + chr(92) + 'npm' + chr(92) + 'opencode.cmd'
proc = subprocess.Popen(
    [shim, 'serve', '--hostname', '127.0.0.1', '--port', port],
    cwd=trial, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, env=env, shell=True)


def server_password():
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


password = server_password()
if password is None:
    print('NO PASSWORD - the server did not report one')
    sys.exit(1)

auth = 'Basic ' + base64.b64encode(('opencode:' + password).encode()).decode()


def get(path):
    req = urllib.request.Request('http://127.0.0.1:%s%s' % (port, path))
    req.add_header('Authorization', auth)
    return json.loads(urllib.request.urlopen(req, timeout=30).read().decode('utf-8'))


print('password:', password)
print()

# The whole point of this script: wait for the plugins, do not just check once.
deadline = time.time() + 120
loaded = []
while time.time() < deadline:
    time.sleep(4)
    try:
        data = get('/api/plugin').get('data', [])
    except Exception:
        continue
    loaded = [p for p in data if (p.get('source') or {}).get('type') != 'builtin']
    if len(loaded) >= 3:
        break

print('non-builtin plugins loaded (%d):' % len(loaded))
for p in loaded:
    print('    %-16s %s' % (p['id'], (p.get('state') or {}).get('status')))
print()

have = {p['id'] for p in loaded}
missing = {'opencode-goal', 'event-spy'} - have
if missing:
    print('MISSING: %s' % ', '.join(sorted(missing)))
    print('The trial would be meaningless. Do not proceed.')
    proc.kill()
    sys.exit(2)

print('OK - both the goal plugin and the spy are live')
print('server pid: %d' % proc.pid)
print()
print('Now: POST /api/session, then wait, then read .opencode/goal-log.jsonl')

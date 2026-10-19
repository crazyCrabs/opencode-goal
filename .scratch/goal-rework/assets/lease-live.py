"""
Ticket 27's live proof: two opencode servers on one worktree.

The in-process test proves the lease closes the loop when one turn-completion
event reaches both drivers. That shape is deliberately more pessimistic than
reality — two `opencode serve` processes have separate event streams, so a turn
in one is not a turn-completion event in the other. What the lease has to survive
in reality is the other case: each process drives its OWN turn, and both see the
same goal log. Without a lease, both admit and both submit, so the goal runs two
prompts per round and the round cap burns at twice the rate.

    python lease-live.py <trial-dir> <port-a> <port-b>
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

TRIAL = sys.argv[1].rstrip('\\/')
PORT_A = int(sys.argv[2])
PORT_B = int(sys.argv[3])
LOG = os.path.join(TRIAL, '.opencode', 'goal-log.jsonl')
SHIM = os.path.join('C:' + chr(92), 'Users', 'Jerome T Liu', 'AppData', 'Roaming', 'npm', 'opencode.cmd')
# the pinned model, exactly as every other trial in this effort used it: without
# it the server picks its own and the turn fails on a provider error, which looks
# like a goal defect and is a configuration one
ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)))
# The objective is deliberately long. An earlier version asked for one file
# and the model completed the goal in round 1, which closed the window before
# the second process's turn could reach admission — and an earlier version still
# that forbade completing was simply ignored. Ten files across ten rounds keeps
# the goal active long enough for the second process to arrive, which is the
# only thing this run is trying to observe.
OBJECTIVE = (
    'Call create_goal with this objective and then stop immediately, doing none of '
    'the work yourself. Objective: create ten files named step-1.txt through '
    'step-10.txt, each containing its own number. Do not mark the goal complete '
    'until all ten exist.'
)


class Server:
    """One `opencode serve` process, with the password it reports on stdout."""

    def __init__(self, port):
        self.port = port
        self.out_path = os.path.join(TRIAL, f'srv-{port}.out')
        self.handle = open(self.out_path, 'w')
        self.proc = subprocess.Popen(
            [SHIM, 'serve', '--hostname', '127.0.0.1', '--port', str(port)],
            cwd=TRIAL, stdout=self.handle, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL, env=dict(os.environ), shell=True,
        )
        self.password = self._password()
        self.auth = 'Basic ' + base64.b64encode(('opencode:' + self.password).encode()).decode()

    def _password(self):
        for _ in range(60):
            time.sleep(1)
            try:
                text = open(self.out_path, encoding='utf-8', errors='replace').read()
            except OSError:
                continue
            for line in text.splitlines():
                if line.startswith('server password'):
                    return line.split('server password', 1)[1].strip()
        return ''

    def api(self, method, path, body=None, timeout=120):
        url = f'http://127.0.0.1:{self.port}{path}'
        data = None if body is None else json.dumps(body).encode('utf-8')
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header('Authorization', self.auth)
        if data is not None:
            req.add_header('content-type', 'application/json')
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read().decode('utf-8')
            return json.loads(raw) if raw.strip() else {}

    def stop(self):
        try:
            subprocess.run(['taskkill', '/PID', str(self.proc.pid), '/T', '/F'], capture_output=True)
        finally:
            self.handle.close()


def log_lines():
    if not os.path.exists(LOG):
        return []
    out = []
    for line in open(LOG, encoding='utf-8', errors='replace'):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out


def wait_for_lease(timeout=180):
    """Wait for a round to be claimed, rather than for it to finish.

    Waiting for the round to *settle* first made the second process's turn arrive
    after the goal had already blocked on a stall guard, so it rejected with
    `not-active` and the run proved nothing about the lease. Prompting while the
    first process's round is still in flight is the case the lease exists for.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        if any(l.get('kind') == 'goal/lease' for l in log_lines()):
            return True
        time.sleep(1)
    return False


def settle_log(stable_for=20, timeout=420):
    """A natural stop is a log that stops changing."""
    deadline = time.time() + timeout
    last = None
    last_change = time.time()
    while time.time() < deadline:
        lines = log_lines()
        stamp = (len(lines), json.dumps(lines[-1]) if lines else '')
        if stamp != last:
            last = stamp
            last_change = time.time()
        elif time.time() - last_change >= stable_for:
            return True
        time.sleep(1)
    return False


servers = []
try:
    os.makedirs(TRIAL, exist_ok=True)
    shutil.copy(os.path.join(ASSETS, 'trial-opencode.json'), os.path.join(TRIAL, 'opencode.json'))
    if os.path.exists(LOG):
        os.remove(LOG)

    # The second process starts FIRST, before any goal exists. Its store is born
    # with no goal, so `applyActivation` treats the goal that appears afterwards
    # as mutated-while-alive and arms it — which is the only way a second process
    # reaches the lease check at all. Started the other way round, the second
    # store is born beside the goal and reads `disarmed`, so it rejects with
    # `disarmed` before the lease is ever consulted and the run proves nothing.
    second = Server(PORT_B)
    first = Server(PORT_A)
    servers = [first, second]
    print('both servers up, the second one started first:', PORT_A, PORT_B)

    # The goal is created through the first server's session, so its plugin
    # adopts it and admits round 1
    created = first.api('POST', '/api/session', {}).get('data', {})
    session_id = created['id'] if isinstance(created, dict) and 'id' in created else created
    print('session:', session_id)
    first.api('POST', f'/api/session/{session_id}/prompt', {'text': OBJECTIVE})
    if not wait_for_lease():
        print('no round was ever claimed')
        sys.exit(1)
    rounds_after_first = len([l for l in log_lines() if l.get('operation') == 'continue'])
    print('a round is claimed and still in flight')

    # The second process opens a session of its own. Two servers do not share a
    # session — an earlier version of this script prompted the first process's
    # session id through the second and the turn simply never happened — so the
    # realistic two-process shape is two sessions and one goal log, which is also
    # the shape that produced the user's anomaly.
    second_session = second.api('POST', '/api/session', {}).get('data', {})
    second_id = second_session['id'] if isinstance(second_session, dict) and 'id' in second_session else second_session
    print('the second process opens its own session:', second_id)
    second.api('POST', f'/api/session/{second_id}/prompt', {
        'text': 'Keep working on the goal. Do not stop early.',
    })
    settle_log()
    print('the second process has driven a turn of its own')
    # Diagnostic: whether that turn actually ran in the second process. Without
    # it a missing deferral is indistinguishable from a missing turn, and the run
    # would be reporting a lease result it never measured.
    try:
        seen = second.api('GET', f'/api/session/{second_id}/message')
        rows = seen.get('data', seen) if isinstance(seen, dict) else seen
        kinds = [(r.get('type'), (r.get('error') or {}).get('message')) for r in rows] if isinstance(rows, list) else rows
        print('  the second process saw:', json.dumps(kinds)[:300])
    except Exception as exc:
        print('  could not read the second process session:', exc)
    settle_log()

    lines = log_lines()
    print()
    print('--- the goal log ---')
    for entry in lines:
        if entry.get('kind') == 'goal/lease':
            print('  lease     holder=%s... expires_at=%d' % (entry['holder'][:8], entry['expiresAt']))
            continue
        if entry.get('operation') == 'usage':
            delta = entry.get('delta') or {}
            print('  usage     delta in=%s out=%s' % (delta.get('inputTokens', 0), delta.get('outputTokens', 0)))
            continue
        goal = entry.get('goal') or {}
        why = goal.get('blockedReason') or ''
        print(
            '  %-9s rev=%-3s rounds=%-3s phase=%-9s in=%-6s out=%-4s %s' % (
                entry.get('operation'), goal.get('revision'), goal.get('roundsStarted'),
                goal.get('phase'), goal.get('usage', {}).get('inputTokens', 0),
                goal.get('usage', {}).get('outputTokens', 0),
                json.dumps(why)[:70] if why else '',
            ),
        )

    leases = [l for l in lines if l.get('kind') == 'goal/lease']
    rounds = [l for l in lines if l.get('operation') == 'continue']
    holders = {l['holder'] for l in leases}
    print()
    print('rounds after the first process :', rounds_after_first)
    print('rounds admitted in total       :', len(rounds))
    print('lease lines                    :', len(leases))
    print('distinct holders               :', len(holders), [h[:8] for h in holders])
    print()
    if len(holders) == 0:
        print('>>> NO lease was ever written: the lease is not in the path at all.')
    elif len(holders) == 1:
        print('>>> ONE holder owns the rounds; the other process deferred.')
    else:
        print('>>> BOTH processes claimed rounds. The lease did not hold.')
finally:
    for server in servers:
        server.stop()

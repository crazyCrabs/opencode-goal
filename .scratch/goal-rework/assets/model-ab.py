"""
Does a session created with a model use it, and does one created without fall
back to a model the account cannot use?

The goal's continuation prompt carries no model — `PromptInput.Prompt` is
`text/files/agents/skills` only, and the TUI's own call in the binary is
`{sessionID, text, files, agents, skills, delivery, gate, prepare}`. So the
server resolves the model per session. `session.create` DOES accept `model`
(and `agent`, `title`) — that is the difference this script measures.

    python model-ab.py <trial-dir> <port>
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.request

TRIAL = sys.argv[1].rstrip('\\/')
PORT = int(sys.argv[2])
SHIM = os.path.join('C:' + chr(92), 'Users', 'Jerome T Liu', 'AppData', 'Roaming', 'npm', 'opencode.cmd')
ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)))
WORKING = {'providerID': 'opencode', 'id': 'mimo-v2.6-flash-free'}


class Server:
    def __init__(self, port):
        self.port = port
        self.out = open(os.path.join(TRIAL, 'srv.out'), 'w')
        self.proc = subprocess.Popen(
            [SHIM, 'serve', '--hostname', '127.0.0.1', '--port', str(port)],
            cwd=TRIAL, stdout=self.out, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL, shell=True,
        )
        self.password = ''
        for _ in range(60):
            time.sleep(1)
            try:
                text = open(os.path.join(TRIAL, 'srv.out'), encoding='utf-8', errors='replace').read()
            except OSError:
                continue
            for line in text.splitlines():
                if line.startswith('server password'):
                    self.password = line.split('server password', 1)[1].strip()
            if self.password:
                break
        self.auth = 'Basic ' + base64.b64encode(('opencode:' + self.password).encode()).decode()

    def api(self, method, path, body=None, timeout=180):
        data = None if body is None else json.dumps(body).encode('utf-8')
        req = urllib.request.Request(f'http://127.0.0.1:{self.port}{path}', data=data, method=method)
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
            self.out.close()


server = None
try:
    os.makedirs(TRIAL, exist_ok=True)
    # Deliberately NO project opencode.json: the human has no model pinned
    # anywhere either, and pinning one here is what made the first run of this
    # script succeed for both arms and prove nothing.
    server = Server(PORT)
    print('server up')

    for label, body in (
        ('no model', {}),
        ('with a model', {'model': WORKING}),
    ):
        created = server.api('POST', '/api/session', body).get('data', {})
        sid = created['id'] if isinstance(created, dict) and 'id' in created else created
        print()
        print('=== session created %s ===' % label)
        print('  id:', sid)
        try:
            server.api('POST', f'/api/session/{sid}/prompt', {'text': 'Say the word banana and nothing else.'})
        except Exception as exc:
            print('  prompt raised:', exc)
        time.sleep(12)
        msgs = server.api('GET', f'/api/session/{sid}/message')
        rows = msgs.get('data', msgs) if isinstance(msgs, dict) else msgs
        for row in (rows if isinstance(rows, list) else []):
            err = row.get('error') or {}
            model = (row.get('model') or {}).get('id')
            print('  %-9s model=%-22s finish=%-8s %s' % (
                row.get('type'), model, row.get('finish'), (err.get('message') or '')[:80]))
finally:
    if server is not None:
        server.stop()

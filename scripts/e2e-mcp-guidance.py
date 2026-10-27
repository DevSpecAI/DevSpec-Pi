"""Real installed-Pi startup check (POSIX PTY); no models, network or user config.
Run: python3 scripts/e2e-mcp-guidance.py
"""
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import fcntl
import time

ROOT = Path(__file__).resolve().parents[1]
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)')
NOTICE = 'DevSpec MCP is disabled in Pi to avoid duplicate tools.'

with tempfile.TemporaryDirectory(prefix='devspec-mcp-guidance-') as directory:
    temp = Path(directory)
    home = temp / 'home'
    home.mkdir()
    project = temp / 'project'
    project.mkdir()
    shared = json.dumps({'mcpServers': {
        'devspec': {'url': 'https://api.devspec.ai/api/mcp', 'headers': {'Authorization': 'Bearer fixture-only'}},
        'supabase': {'url': 'https://mcp.supabase.com/mcp'},
    }})
    (project / '.mcp.json').write_text(shared)
    (project / '.pi').mkdir()
    native = {'mcpServers': {'devspec': json.loads(shared)['mcpServers']['devspec']}}
    (project / '.pi' / 'mcp.json').write_text(json.dumps(native))
    ready = temp / 'ready.ts'
    ready.write_text('export default function(pi) { pi.registerCommand("mcp-probe-ready", { description: "Test readiness", handler: async (_,ctx) => { ctx.ui.notify("MCP_PROBE_READY", "info"); } }); }')
    env = dict(os.environ, HOME=str(home), USERPROFILE=str(home), PI_CODING_AGENT_DIR=str(home / 'agent'),
               TERM='xterm-256color', NODE_OPTIONS='', DEVSPEC_DEBUG_REMOTE='', ROOM_PROBE_MODEL_MARKER=str(temp / 'unexpected-model'))
    for key in ('DEVSPEC_MCP_TOKEN', 'DEVSPEC_MCP_URL', 'DEVSPEC_ENV'):
        env.pop(key, None)
    base = [shutil.which('pi'), '--offline', '--no-session', '--no-extensions', '--no-skills',
            '--no-prompt-templates', '--no-context-files', '--no-themes', '--approve',
            '-e', str(ROOT / 'extensions/devspec-adapter-guard.ts'), '-e', 'builtin:mcp',
            '-e', str(ROOT / 'scripts/room-store-no-model-fixture.ts'), '-e', str(ready),
            '--provider', 'room-probe', '--model', 'no-model']

    def run(expected_notice):
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 45, 180, 0, 0))
        process = subprocess.Popen(base, cwd=project, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        text = ''
        sent_ready = False
        try:
            deadline = time.monotonic() + 40
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise AssertionError('Pi exited before readiness: ' + text[-3000:])
                if select.select([master], [], [], .1)[0]:
                    raw = os.read(master, 65536).decode(errors='replace')
                    if '\x1b[6n' in raw:
                        os.write(master, b'\x1b[1;1R')
                    text += ANSI.sub('', raw)
                    # The initial footer appears before extensions finish.
                    # The resolved provider footer follows session_start; typing
                    # earlier leaves the command queued in Pi's startup editor.
                    if not sent_ready and '(room-probe) no-model' in text:
                        os.write(master, b'/mcp-probe-ready\r')
                        sent_ready = True
                    if 'MCP_PROBE_READY' in text:
                        break
            else:
                raise AssertionError('Pi readiness timed out: ' + text[-3000:])
            assert (NOTICE in text) == expected_notice, text[-4000:]
            assert not (temp / 'unexpected-model').exists(), 'No model call is permitted'
            if expected_notice:
                assert 'Other agents’ settings and your other MCP servers are unchanged.' in text
            return text
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
            os.close(master)

    run(True)
    overlay = project / '.pi' / 'mcp.json'
    saved = overlay.read_text()
    expected = native
    expected['mcpServers']['devspec']['enabled'] = False
    assert json.loads(saved) == expected
    assert (project / '.mcp.json').read_text() == shared
    run(False)  # established override: no repeated user-facing announcement
    assert overlay.read_text() == saved
    assert (project / '.mcp.json').read_text() == shared
    (project / '.pi' / 'mcp.json').write_text(json.dumps({'mcpServers': {}}))
    run(False)
    print('PASS: actual Pi first-change notice, quiet saved-override and no-duplicate starts, shared config preserved, no model calls.')

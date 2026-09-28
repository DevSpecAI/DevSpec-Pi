"""Disposable real Pi keyboard/RPC smoke. Called only by e2e-project-choice.mjs."""
import os, pty, select, subprocess, termios, fcntl, struct, re, json, time, signal, uuid
from pathlib import Path
root=Path(os.environ['PROJECT_PROBE_ROOT']); temp=Path(os.environ['PROJECT_PROBE_TEMP'])
A=os.environ['PROJECT_PROBE_A']; B=os.environ['PROJECT_PROBE_B']
repo=temp/'repo'; repo.mkdir()
subprocess.run(['git','init','-q',str(repo)],check=True)
subprocess.run(['git','-C',str(repo),'remote','add','origin','https://github.com/example/shared.git'],check=True)
env=dict(os.environ, PI_CODING_AGENT_DIR=str(temp/'agent'), DEVSPEC_MCP_TOKEN='fixture-only-not-a-real-token', DEVSPEC_MCP_URL=os.environ['PROJECT_PROBE_ENDPOINT'], ROOM_PROBE_MODEL_MARKER=str(temp/'unexpected-model'), DEVSPEC_DEBUG_REMOTE='', TERM='xterm-256color', NODE_OPTIONS='')
base=['pi','--no-extensions','--no-skills','--no-prompt-templates','--no-themes','-e',str(root/'extensions/devspec-remote.ts'),'-e',str(root/'extensions/devspec-auth.ts'),'-e',str(root/'scripts/project-choice-runtime-fixture.ts'),'-e',str(root/'scripts/room-store-no-model-fixture.ts'),'--provider','room-probe','--model','no-model']
def session(name,cwd):
    path=temp/(name+'.jsonl')
    path.write_text(json.dumps({'type':'session','version':3,'id':str(uuid.uuid4()),'cwd':str(cwd),'timestamp':'2026-09-28T00:00:00.000Z'})+'\n')
    return path
ansi=re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)')
class Terminal:
    def __init__(self,path,cwd=repo,extra=[]):
        self.master,slave=pty.openpty(); fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',50,180,0,0))
        self.p=subprocess.Popen(base+['--session',str(path)]+extra,cwd=cwd,env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
        os.close(slave); self.text=''; self.counter=0
    def send(self,text): os.write(self.master,text.encode())
    def wait(self,needle,start=0,timeout=45):
        end=time.monotonic()+timeout
        while time.monotonic()<end:
            if needle in self.text[start:]: return
            if self.p.poll() is not None: raise AssertionError('Pi exited: '+self.text[-5000:])
            if select.select([self.master],[],[],0.1)[0]:
                try: raw=os.read(self.master,65536).decode(errors='replace')
                except OSError: raw=''
                if '\x1b[6n' in raw: self.send('\x1b[1;1R')
                self.text+=ansi.sub('',raw)
            if (temp/'unexpected-model').exists(): raise AssertionError('Unexpected model request')
        raise AssertionError('Timeout waiting for '+needle+'\n'+self.text[-9000:])
    def command(self,text,expect):
        start=len(self.text); self.send(text+'\r'); self.wait(expect,start)
    def probe(self,pid):
        self.counter+=1; nonce=str(self.counter)
        self.command('/project-probe '+nonce,'PROJECT-PROBE-PASS '+nonce+' '+pid)
    def close(self):
        if self.p.poll() is None:
            os.killpg(self.p.pid,signal.SIGTERM)
            try: self.p.wait(timeout=5)
            except subprocess.TimeoutExpired: os.killpg(self.p.pid,signal.SIGKILL); self.p.wait()
        os.close(self.master)
processes=[]
try:
    original=session('original',repo); p=Terminal(original); processes.append(p)
    p.wait('Which DevSpec project should this conversation use?')
    p.wait('Client Org'); assert 'Agency Org' in p.text
    p.send('\x1b[B\r'); p.wait('How should DevSpec remember this choice?'); p.send('\r')
    p.wait('auto-bonded as')
    assert A not in p.text and B not in p.text, 'ordinary picker/footer must not expose full project IDs'
    assert '(git_remote)' not in p.text and '(explicit)' not in p.text
    assert 'DevSpec: DevSpec' not in p.text, 'successful authentication must not add repeated branding'
    p.command('/footer-probe','Proud Eagle'); p.wait('Planning checkout'); p.wait('Improve checkout')
    p.command('/devspec.project','Project details')
    assert 'Choose project' in p.text
    p.send('\r'); p.wait('Project ID: '+B); p.wait('Selected by:')
    p.probe(B)
    pin=repo/'.devspec'/'project.json'; assert not pin.exists()
    p.command('/devspec.project remember','Remember for this folder?'); p.send('\r'); p.wait('Folder default saved to')
    assert json.loads(pin.read_text())['project_id']==B
    # A second terminal changing the folder cannot redirect this conversation.
    pin.write_text(json.dumps({'project_id':A}))
    p.probe(B)
    p.command('/devspec.project forget','Forget this folder default?'); p.send('\r'); p.wait('Folder default removed')
    assert not pin.exists(); p.probe(B)
    # Cross-org choice starts a native fresh conversation; no context is copied.
    start=len(p.text); p.send('/devspec.project choose\r'); p.wait('Which DevSpec project',start); p.send('\r')
    p.wait('Start a fresh conversation?',start); p.send('\r'); p.wait('auto-bonded as',start); p.probe(A)
    p.close(); processes.remove(p)
    # Resume the ORIGINAL local conversation with a conflicting pin.
    pin.write_text(json.dumps({'project_id':A}))
    resumed=Terminal(original); processes.append(resumed); resumed.wait('auto-bonded as'); resumed.probe(B)
    # A concurrent conversation in the exact same cwd deliberately chooses A.
    other=Terminal(session('other',repo),extra=['--devspec-project',A]); processes.append(other)
    other.wait('auto-bonded as'); other.probe(A); resumed.probe(B)
    other.close(); processes.remove(other); resumed.close(); processes.remove(resumed)
    # An unusable pin must not select a candidate; Escape leaves no bond.
    pin.write_text(json.dumps({'project_id':str(uuid.uuid4())}))
    cancelled=Terminal(session('cancel',repo)); processes.append(cancelled)
    cancelled.wait('Which DevSpec project'); cancelled.send('\x1b'); cancelled.wait('Project selection cancelled')
    cancelled.command('/devspec.project status','Not connected'); cancelled.close(); processes.remove(cancelled)
    # A genuine greenfield pin connects without a picker.
    green=temp/'greenfield'; (green/'.devspec').mkdir(parents=True); (green/'.devspec'/'project.json').write_text(json.dumps({'project_id':B}))
    ready=Terminal(session('green',green),cwd=green); processes.append(ready); ready.wait('auto-bonded as'); ready.probe(B)
    assert 'Which DevSpec project' not in ready.text
    ready.close(); processes.remove(ready)
    # RPC is non-interactive here: ambiguity responds without waiting for a dialog.
    rpc=subprocess.Popen(base+['--mode','rpc','--session',str(session('rpc',repo))],cwd=repo,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
    rpc.stdin.write((json.dumps({'id':'connect','type':'prompt','message':'/devspec.remote'})+'\n').encode()); rpc.stdin.flush()
    lines=[]; end=time.monotonic()+40; buffer=b''; complete=False
    while time.monotonic()<end and not complete:
        if select.select([rpc.stdout],[],[],0.1)[0]:
            buffer+=os.read(rpc.stdout.fileno(),65536)
            while b'\n' in buffer:
                line,buffer=buffer.split(b'\n',1)
                try: event=json.loads(line)
                except ValueError: continue
                lines.append(event)
                if event.get('type')=='response' and event.get('id')=='connect': complete=True
    if not complete:
        os.killpg(rpc.pid,signal.SIGTERM); rpc.wait(timeout=5)
        raise AssertionError('RPC ambiguity hung')
    assert not any(e.get('type')=='agent_start' or (e.get('type')=='extension_ui_request' and e.get('method')=='select') for e in lines)
    os.killpg(rpc.pid,signal.SIGTERM); rpc.wait(timeout=5)
    evidence={'arrowKeyChoice':True,'conversationOnlyDefault':True,'rememberConsent':True,'forgetPreservesConversation':True,'pinEditIsolation':True,'freshCrossOrgConversation':True,'resume':True,'concurrentSameFolder':True,'cancel':True,'greenfieldFastPath':True,'rpcNoDialog':True,'compactFooter':True,'projectDetailsMenu':True,'namesWithoutIds':True}
    (temp/'evidence.json').write_text(json.dumps(evidence)); print('Actual Pi keyboard and RPC scenarios passed',flush=True)
finally:
    for process in processes: process.close()

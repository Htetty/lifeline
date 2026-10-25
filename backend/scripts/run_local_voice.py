"""Run a disposable, isolated Convex + browser voice + dashboard exercise.

Never loads dashboard deployment credentials, deploys cloud functions, or resets
data. Ctrl-C stops only child processes started here. Local data is retained in
the printed temporary directory. Provider credentials are read privately.
"""
import json
import argparse
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

import httpx
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[2]


def main(args):
    ports=(args.convex_port,args.convex_site_port,args.api_port,args.dashboard_port)
    if len(set(ports))!=4 or any(port<1024 or port>65535 for port in ports):
        raise RuntimeError('Choose four distinct ports between 1024 and 65535')
    convex_url=f'http://127.0.0.1:{args.convex_port}'
    api_url=f'http://127.0.0.1:{args.api_port}'
    for port in ports:
        with socket.socket() as probe:
            if probe.connect_ex(('127.0.0.1',port))==0:
                raise RuntimeError(f'Port {port} is already in use; stop your existing local exercise first')
    node_modules=ROOT/'dashboard/node_modules'
    if not (node_modules/'convex/bin/main.js').exists():
        raise RuntimeError('Run npm ci in dashboard first')
    env={**os.environ, **{k:v for k,v in dotenv_values(ROOT/'backend/.env').items() if v}}
    root_env=dotenv_values(ROOT/'.env')
    missing=[key for key in ('ANTHROPIC_API_KEY','VOICE_BRIDGE_TOKEN') if not env.get(key)]
    if not (env.get('CARTESIA_API_KEY') or root_env.get('CARTESIA_API_KEY')):
        missing.append('CARTESIA_API_KEY')
    if missing:
        raise RuntimeError('Populate backend/.env locally: '+', '.join(missing))
    state=Path(tempfile.mkdtemp(prefix='lifeline-voice-'))
    state.chmod(0o700)
    shutil.copytree(ROOT/'dashboard/convex',state/'convex')
    (state/'node_modules').symlink_to(node_modules,target_is_directory=True)
    (state/'package.json').write_text(json.dumps({'name':'lifeline-local-voice','private':True,'dependencies':{'convex':'^1.48.0'}}))
    secret=secrets.token_urlsafe(32)
    secret_file=state/'backend-secret'
    secret_file.write_text(secret);secret_file.chmod(0o600)
    dispatcher=secrets.token_urlsafe(24)
    dispatcher_file=state/'dispatcher-token'
    dispatcher_file.write_text(dispatcher);dispatcher_file.chmod(0o600)
    local_env={k:v for k,v in os.environ.items() if 'CONVEX' not in k}
    local_env['CONVEX_AGENT_MODE']='anonymous'
    cli=['node',str(node_modules/'convex/bin/main.js')]
    children=[]
    try:
        print('Isolated state directory:',state,flush=True)
        children.append(subprocess.Popen(cli+['dev','--typecheck','disable','--codegen','disable',
            '--local-cloud-port',str(args.convex_port),'--local-site-port',str(args.convex_site_port)],cwd=state,env=local_env))
        deadline=time.monotonic()+180
        while True:
            if children[0].poll() is not None: raise RuntimeError('Local Convex stopped')
            try:
                if not (state/'.env.local').exists():
                    raise RuntimeError('Local Convex configuration is still being written')
                httpx.get(convex_url+'/version',timeout=2).raise_for_status()
                break
            except Exception:
                if time.monotonic()>deadline: raise RuntimeError('Local Convex did not become ready')
                time.sleep(.5)
        subprocess.run(cli+['env','set','BACKEND_SECRET','--from-file',str(secret_file)],cwd=state,env=local_env,check=True)
        subprocess.run(cli+['env','set','DISPATCHER_TOKEN','--from-file',str(dispatcher_file)],cwd=state,env=local_env,check=True)
        backend_env={**env,'CONVEX_URL':convex_url,'BACKEND_SECRET':secret}
        children.append(subprocess.Popen([sys.executable,'-m','uvicorn','app.main:app','--host','127.0.0.1',
            '--port',str(args.api_port),'--no-access-log'],cwd=ROOT/'backend',env=backend_env))
        children.append(subprocess.Popen(['npm','run','dev','--','--port',str(args.dashboard_port)],cwd=ROOT/'dashboard',
            env={**os.environ,'NEXT_PUBLIC_CONVEX_URL':convex_url}))
        for _ in range(100):
            try:
                if httpx.get(api_url+'/health').status_code==200: break
            except httpx.HTTPError: pass
            time.sleep(.1)
        else:
            raise RuntimeError('FastAPI did not become ready')
        print(f'\nVoice: {api_url}/voice\nDashboard: http://localhost:{args.dashboard_port}\n'
              'Use VOICE_BRIDGE_TOKEN from backend/.env in the voice page. No phone settings change.\n'
              f'Dashboard passcode is in {dispatcher_file}; enter it locally, never in chat.\n'
              'Ctrl-C stops this exercise; saved local incidents are retained in the state directory.',flush=True)
        while all(child.poll() is None for child in children): time.sleep(.5)
        raise RuntimeError('A local service stopped; check its output above')
    finally:
        for child in reversed(children):
            if child.poll() is None: child.send_signal(signal.SIGINT)
        for child in children:
            try: child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                child.terminate()
                try: child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill();child.wait()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--convex-port',type=int,default=3210)
    parser.add_argument('--convex-site-port',type=int,default=3211)
    parser.add_argument('--api-port',type=int,default=8010)
    parser.add_argument('--dashboard-port',type=int,default=3100)
    try: main(parser.parse_args())
    except KeyboardInterrupt: pass
    except Exception as exc:
        print(str(exc) if isinstance(exc,RuntimeError) else type(exc).__name__,file=sys.stderr)
        raise SystemExit(1)

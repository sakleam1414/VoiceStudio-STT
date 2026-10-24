"""Regression: closing the status window must not shut down the server's workers."""
import argparse
import json
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent

def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]

def main():
    with tempfile.TemporaryDirectory(prefix='stt-window-lifetime-') as directory:
        folder = Path(directory)
        for name in ['stt_server.py', 'vosk_models.json']:
            shutil.copyfile(ROOT/name, folder/name)
        stt, http = free_port(), free_port()
        while stt == http:
            http = free_port()
        # Replace only the UI event loop. It returns just as a closed Tk window does.
        # Run the production main and normal SystemExit in a separate interpreter.
        wrapper = folder/'simulate_window_close.py'
        wrapper.write_text('''import stt_server, sys
from pathlib import Path
def closed_window():
    Path(__file__).with_name('window-closed').write_text('closed')
stt_server.run_dashboard = closed_window
raise SystemExit(stt_server.main())
''', encoding='utf-8')
        process = subprocess.Popen([sys.executable, str(wrapper), '--dashboard', '--port', str(stt), '--http-port', str(http)], cwd=folder, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic()+20
            while not (folder/'window-closed').exists():
                if process.poll() is not None:
                    raise AssertionError('Server exited before the window closed')
                if time.monotonic()>deadline:
                    raise AssertionError('Window did not close')
                time.sleep(.05)
            # Both services and executor jobs must work after the UI already returned.
            for index in range(5):
                while True:
                    try:
                        with urllib.request.urlopen(f'http://127.0.0.1:{http}/status',timeout=7) as response:
                            data=json.load(response)
                        assert data['services']['stt']['state']=='active',data
                        break
                    except OSError:
                        if time.monotonic()>deadline:
                            log=(folder/'stt_server.log').read_text(encoding='utf-8',errors='replace')
                            raise AssertionError('Server workers failed after closing window:\n'+log[-3000:])
                        time.sleep(.1)
                time.sleep(.1)
            # Reopen/close a second window against the same background owner.
            duplicate=subprocess.run([sys.executable,str(wrapper),'--dashboard','--port',str(stt),'--http-port',str(http)],cwd=folder,timeout=10,capture_output=True)
            assert duplicate.returncode==0,duplicate.stderr
            with urllib.request.urlopen(f'http://127.0.0.1:{http}/status',timeout=7) as response:
                assert json.load(response)['services']['stt']['state']=='active'
            log=(folder/'stt_server.log').read_text(encoding='utf-8',errors='replace')
            assert 'cannot schedule new futures after shutdown' not in log,log
            print('PASS: server workers survive closing/reopening dashboards; HTTP stays healthy')
        finally:
            process.terminate()
            process.wait(timeout=10)

if __name__=='__main__':
    main()

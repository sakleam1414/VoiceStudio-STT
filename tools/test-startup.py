"""Startup migration tests run against an in-memory registry and temporary folders."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('startup_test', ROOT/'stt_server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

class Key:
    def __init__(self, name): self.name=name
    def __enter__(self): return self
    def __exit__(self, *_): pass

class Registry:
    HKEY_CURRENT_USER='HKCU'
    KEY_SET_VALUE=2
    REG_SZ=1
    REG_BINARY=3
    def __init__(self): self.values={}
    def OpenKey(self, _, name, *args):
        if name not in self.values: raise FileNotFoundError(name)
        return Key(name)
    def CreateKeyEx(self, _, name, *args):
        self.values.setdefault(name,{})
        return Key(name)
    def QueryValueEx(self, key, name):
        try: return self.values[key.name][name], self.REG_SZ
        except KeyError: raise FileNotFoundError(name)
    def SetValueEx(self, key, name, _, kind, value): self.values[key.name][name]=value

def main():
    registry=Registry()
    with tempfile.TemporaryDirectory(prefix='voice-startup-') as folder:
        root=Path(folder)
        app=root/'install';app.mkdir()
        (app/'stt_server.exe').write_bytes(b'test exe')
        startup=root/'Microsoft/Windows/Start Menu/Programs/Startup';startup.mkdir(parents=True)
        (startup/'bd_stt_server.bat').write_text(f'call "{app / "stt_server.bat"}"')
        (startup/'stt_server_autostart.bat').write_text('"%~dp0stt_server.py" from vosk import KaldiRecognizer, Model; websockets')
        unrelated=startup/'other.bat';unrelated.write_text('other app')
        with patch.dict(sys.modules,{'winreg':registry}), patch.object(server,'sys',SimpleNamespace(platform='win32')),patch.object(server,'APP_DIR',app),patch.dict(os.environ,{'APPDATA':str(root)}):
            server.ensure_autostart()
            assert registry.values[server.STARTUP_RUN_KEY]['Voice Studio']==f'"{app / "stt_server.exe"}" --background'
            assert sorted(p.name for p in startup.iterdir())==['other.bat']
            assert len(list((app/'.stt-startup-backup').iterdir()))==2
            assert server.get_autostart_status()['state']=='active'
            registry.values[server.STARTUP_APPROVAL_KEY]={'Voice Studio':bytes([3])+bytes(11)}
            server.ensure_autostart()
            assert server.get_autostart_status()['state']=='inactive' # Respect Task Manager.
            assert unrelated.read_text()=='other app'
            registry.values[server.STARTUP_RUN_KEY]['Voice Studio']='"C:\\other\\stt_server.exe" --background'
            server.ensure_autostart()
            assert registry.values[server.STARTUP_RUN_KEY]['Voice Studio'].startswith('"C:\\other')
            assert server.get_autostart_status()['state']=='unknown'
        # A previously disabled legacy entry remains disabled after migration.
        registry=Registry()
        (startup/'bd_stt_server.bat').write_text(f'call "{app / "stt_server.bat"}"')
        registry.values[r'Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder']={'bd_stt_server.bat':bytes([3])+bytes(11)}
        with patch.dict(sys.modules,{'winreg':registry}),patch.object(server,'sys',SimpleNamespace(platform='win32')),patch.object(server,'APP_DIR',app),patch.dict(os.environ,{'APPDATA':str(root)}):
            server.ensure_autostart()
            assert server.get_autostart_status()['state']=='inactive'
    print('PASS: one named EXE startup, legacy backup/cleanup, idempotence, Windows disable preserved, unrelated entries preserved')

if __name__=='__main__': main()

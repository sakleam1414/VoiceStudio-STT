"""Exercise real HTTP handlers with a mocked Tailscale CLI; no model loading."""
import asyncio
import importlib.util
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace
from unittest.mock import patch

source = Path(__file__).resolve().parent.parent / 'stt_server.py'
spec = importlib.util.spec_from_file_location('server_network_test', source)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

class Writer:
    def __init__(self, ip, local): self.ip, self.local, self.response = ip, local, b''
    def get_extra_info(self, name): return (self.local,8765) if name=='sockname' else (self.ip,12345)
    def write(self, data): self.response += data
    async def drain(self): pass
    def close(self): pass
    async def wait_closed(self): pass

async def request(path, ip='127.0.0.1', local='127.0.0.1'):
    reader=asyncio.StreamReader()
    reader.feed_data(f'GET {path} HTTP/1.1\r\nContent-Length: 0\r\n\r\n'.encode())
    reader.feed_eof()
    writer=Writer(ip,local)
    await server.handle_subtitle_http(reader,writer)
    header, body=writer.response.split(b'\r\n\r\n',1)
    return int(header.split()[1]),json.loads(body)

async def main():
    status={'BackendState':'Running','Self':{'TailscaleIPs':['100.77.9.1','fd7a:115c:a1e0::1']},
            'Peer':{'friend':{'HostName':'friend','Online':True,'TailscaleIPs':['100.77.1.2']}}}
    server.tailscale_peers_cache_at=0
    with patch.object(server.shutil,'which',return_value='tailscale.exe'), patch.object(Path,'is_file',return_value=True), patch.object(server.subprocess,'run',return_value=SimpleNamespace(stdout=json.dumps(status))):
        code, data = await request('/network')
        assert code==200 and data['addresses']==['100.77.9.1'] and data['port']==8765,data
        code,data=await request('/peers')
        assert code==200 and data['addresses']==['100.77.1.2'],data
    for remote in ['100.77.1.2','192.168.1.2']:
        assert (await request('/network',remote))[0]==403
    server.subtitle_user_id='12345'
    server.subtitle_last_seen=server.time.monotonic()
    with patch.object(server,'get_tailscale_peer_records',side_effect=RuntimeError('CLI unavailable')):
        assert (await request('/peers'))[0]==503
        code,data=await request('/ping','100.77.1.2')
        assert code==200 and data['userId']=='12345' # Manual connection survives discovery failure.
    assert (await request('/ping','192.168.1.2'))[0]==403
    assert server.is_tailscale_source(server.ipaddress.ip_address('100.77.1.2'))
    assert not server.is_tailscale_source(server.ipaddress.ip_address('8.8.8.8'))
    with patch.object(server,'get_radmin_self_addresses',return_value=['26.10.0.1']),patch.object(server,'get_tailscale_peer_records',side_effect=RuntimeError('Tailscale absent')):
        code,data=await request('/network')
        assert code==200 and data['addresses']==['26.10.0.1'] and data['networks']==[{'address':'26.10.0.1','vpn':'radmin'}],data
        assert (await request('/ping','26.10.0.2','26.10.0.1'))[0]==200
        assert (await request('/ping','26.10.0.2','192.168.1.2'))[0]==403
        assert (await request('/ping','8.8.8.8','26.10.0.1'))[0]==403
        for path in ['/status','/register','/inbox','/network','/peers']:
            assert (await request(path,'26.10.0.2','26.10.0.1'))[0]==403,path
    with patch.object(server,'get_radmin_self_addresses',return_value=[]):
        assert (await request('/ping','26.10.0.2','26.10.0.1'))[0]==403
    server.radmin_addresses_cache_at=0
    with patch.object(server,'sys',SimpleNamespace(platform='win32')),patch.object(server.subprocess,'run',return_value=SimpleNamespace(stdout='["26.10.0.1","8.8.8.8"]')) as run:
        assert server.get_radmin_self_addresses()==['26.10.0.1']
        assert server.get_radmin_self_addresses()==['26.10.0.1']
        assert run.call_count==1
        assert 'Radmin' in run.call_args.args[0][-1]
    print('PASS: Radmin manual ping, correct local adapter required, no Tailscale dependency, local admin APIs protected, adapter cache')
    print('PASS: self IP/port, peer discovery, local-only address API, manual ping during CLI failure, remote access boundary')

asyncio.run(main())

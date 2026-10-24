"""Discovery handshake, expiry, input filtering, local-only launch, Radmin-only peers."""
import asyncio
import importlib.util
import json
from pathlib import Path
import tempfile
import time
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('radmin_test',Path(__file__).resolve().parents[1]/'stt_server.py')
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)

class Transport:
    def __init__(self): self.sent=[];self.closed=False
    def sendto(self,data,remote):self.sent.append((data,remote))
    def close(self):self.closed=True

a=s.RadminDiscoveryProtocol('26.10.0.1',8765);ta=Transport();a.connection_made(ta)
b=s.RadminDiscoveryProtocol('26.10.0.2',9000);tb=Transport();b.connection_made(tb)
a.discover()
packet,remote=ta.sent[-1]
assert remote==('26.255.255.255',8766) and len(packet)<160
assert set(json.loads(packet))=={'app','v','type','nonce','port'}
b.datagram_received(packet,('26.10.0.1',8766))
assert len(tb.sent)==1
answer,target=tb.sent[-1]
assert target==('26.10.0.1',8766)
a.datagram_received(answer,('26.10.0.2',8766))
assert {x['address'] for x in s.get_radmin_discovered_peers()}=={'26.10.0.1','26.10.0.2:9000'}
b.datagram_received(packet,('26.10.0.1',8766));assert len(tb.sent)==1 # rate limited
before=dict(s.radmin_discovered_peers)
for data,ip in [(b'x'*513,'26.10.0.3'),(b'{}','26.10.0.3'),(b'[]','26.10.0.3'),(b'\xff','26.10.0.3'),(packet,'192.168.1.2'),(packet,'26.10.0.1'),(a.packet('announce','0'*24),'26.10.0.3'),(json.dumps(dict(json.loads(packet),port=True)).encode(),'26.10.0.3')]:
    a.datagram_received(data,(ip,8766))
assert s.radmin_discovered_peers==before
with patch.object(s.time,'monotonic',return_value=time.monotonic()+46):assert not s.get_radmin_discovered_peers()
a.nonce_at-=30;a.datagram_received(answer,('26.10.0.2',8766));assert not s.get_radmin_discovered_peers()

class Writer:
    def __init__(self,remote):self.remote=remote;self.data=b''
    def get_extra_info(self,name):return (self.remote if name=='peername' else '26.10.0.1',8765)
    def write(self,data):self.data+=data
    async def drain(self):pass
    def close(self):pass
    async def wait_closed(self):pass

async def request(method,path,remote='127.0.0.1'):
    reader=asyncio.StreamReader();reader.feed_data(f'{method} {path} HTTP/1.1\r\nContent-Length: 0\r\n\r\n'.encode());reader.feed_eof()
    writer=Writer(remote);await s.handle_subtitle_http(reader,writer)
    header,body=writer.data.split(b'\r\n\r\n',1)
    return int(header.split()[1]),json.loads(body)

async def main():
    s.radmin_discovered_peers['26.10.0.2']={'address':'26.10.0.2','seen':time.monotonic()}
    with patch.object(s,'get_tailscale_peer_records',side_effect=RuntimeError('Tailscale absent')),patch.object(s,'get_radmin_self_addresses',return_value=['26.10.0.1']):
        code,data=await request('GET','/peers')
        assert code==200 and data['addresses']==['26.10.0.2'],data
    with patch.object(s,'get_tailscale_peer_records',return_value=[{'address':'100.77.1.2'}]),patch.object(s,'get_radmin_self_addresses',return_value=['26.10.0.1']):
        code,data=await request('GET','/peers');assert data['addresses']==['100.77.1.2','26.10.0.2']
    with patch.object(s,'launch_radmin',return_value={'ok':True}) as launch:
        assert (await request('POST','/radmin/open'))[0]==200
        assert launch.call_count==1
        for ip in ['26.10.0.2','100.77.1.2','192.168.1.2']:
            assert (await request('POST','/radmin/open',ip))[0]==403
        assert launch.call_count==1
    with patch.object(s,'launch_radmin',side_effect=RuntimeError('Radmin missing')):
        code,data=await request('POST','/radmin/open');assert code==503 and data['error']=='Radmin missing'
    transports=[]
    async def endpoint(factory,**kwargs):
        protocol=factory();transport=Transport();protocol.connection_made(transport);transports.append(transport)
        assert kwargs['local_addr'][0]=='26.10.0.1' and kwargs['allow_broadcast']
        return transport,protocol
    with patch.object(s,'get_radmin_self_addresses',return_value=['26.10.0.1']),patch.object(asyncio.get_running_loop(),'create_datagram_endpoint',side_effect=endpoint):
        task=asyncio.create_task(s.run_radmin_discovery())
        for _ in range(100):
            if s.radmin_discovery_ready:break
            await asyncio.sleep(.01)
        assert s.radmin_discovery_ready=={'26.10.0.1'}
        task.cancel();await asyncio.gather(task,return_exceptions=True)
        assert transports[0].closed and not s.radmin_discovery_ready and not s.radmin_discovered_peers

asyncio.run(main())
with tempfile.TemporaryDirectory() as temp,patch.object(s,'APP_DIR',Path(temp)):
    assert s.load_radmin_settings()=={'name':'VoiceStudio','password':''}
    s.save_radmin_settings('TestNetwork','test-only-value')
    assert s.load_radmin_settings()=={'name':'TestNetwork','password':'test-only-value'}
    assert sorted(x.name for x in Path(temp).iterdir())==['stt_radmin.config.json']
print('PASS: Radmin discovery handshake, rate limit, expiry, invalid packets, Radmin-only/combined peers, protected launch, cancellation, local settings.')

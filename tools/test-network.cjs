const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {PeerNetwork, parsePeerAddress} = require('../stt_updates');

async function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-network-'));
    const originalFetch = global.fetch;
    try {
        assert.equal(parsePeerAddress(' http://100.77.3.4:8765/ ').address,'100.77.3.4');
        assert.equal(parsePeerAddress('100.127.3.4:9999').url,'http://100.127.3.4:9999');
        assert.equal(parsePeerAddress('26.10.3.4:9000').url,'http://26.10.3.4:9000');
        assert.throws(()=>parsePeerAddress('26.999.0.1'));
        for (const input of ['127.0.0.1','192.168.1.2','8.8.8.8','100.63.1.1','100.128.1.1','100.77.999.1','100.77.1.1:0','100.77.1.1:65536','http://evil.test','http://100.77.1.1/admin','http://user@100.77.1.1','100.77.1.1?foo']) {
            assert.throws(()=>parsePeerAddress(input), input);
        }
        const manager = new PeerNetwork(directory);
        const radmin = new PeerNetwork(path.join(directory,'unused'));
        const previousFetch=global.fetch;
        global.fetch=async()=>({ok:true,json:async()=>({addresses:['100.77.9.1','26.10.0.1'],networks:[{address:'100.77.9.1',vpn:'tailscale'},{address:'26.10.0.1',vpn:'radmin'}]})});
        assert.equal(await radmin.self('radmin'),'26.10.0.1');
        assert.equal(await radmin.self('tailscale'),'100.77.9.1');
        global.fetch=previousFetch;
        manager.save('100.77.1.2','111','Друг один');
        manager.save('100.77.1.3:9000','222','Друг два');
        assert.deepEqual(new PeerNetwork(directory).saved().map(p=>p.userId),['111','222']);
        let autoFailure = false, sends = [], wrongIdentity = false, failPrimary = false, probes=0;
        global.fetch = async (url, options={}) => {
            if(url.endsWith('/peers')) {
                if(autoFailure) throw new Error('Tailscale CLI unavailable');
                return {ok:true,json:async()=>({addresses:['100.77.1.4','100.77.1.4']})};
            }
            if(url.endsWith('/ping')) {
                probes++;
                const userId = url.includes('100.77.1.3') ? '222' : url.includes('100.77.1.2') && wrongIdentity ? '999' : '111';
                return {ok:true,json:async()=>({ok:true,userId,protocol:1})};
            }
            if(url.endsWith('/subtitle')) {
                if(url.includes('100.77.1.4') && failPrimary) throw new Error('Primary is offline');
                sends.push({url,body:JSON.parse(options.body)});
                return {ok:true,json:async()=>({ok:true})};
            }
            if(url.endsWith('/network')) return {ok:true,json:async()=>({addresses:['100.77.9.1'],port:8765})};
            throw new Error('Unexpected URL '+url);
        };
        assert.equal(await manager.self(),'100.77.9.1');
        const [scan, concurrent] = await Promise.all([manager.refresh(true),manager.refresh(true)]);
        assert.equal(scan,concurrent);
        assert.equal(probes,3);
        assert.equal(scan.peers.get('111')[0].source,'auto');
        assert.equal(scan.peers.get('222')[0].source,'manual');
        await manager.send({userId:'000',text:'hello'},['111','111','222','000']);
        assert.equal(sends.length,2); // One message per person, even if they have two addresses.
        assert(sends.some(s=>s.url==='http://100.77.1.3:9000/subtitle'));
        sends=[];failPrimary=true;
        await manager.send({userId:'000',text:'fallback'},['111']);
        assert.equal(sends.length,1);
        assert(sends[0].url.includes('100.77.1.2')); // Fallback after the automatic address fails.
        sends=[];autoFailure=true;
        const manualOnly=await manager.refresh(true);
        assert(manualOnly.discoveryError);
        assert.equal(manualOnly.peers.size,2);
        await manager.send({userId:'000',text:'manual only'},['222']);
        assert.equal(sends.length,1);
        assert.equal(sends[0].body.text,'manual only');
        wrongIdentity=true;
        await assert.rejects(manager.probe('100.77.1.2','111'),/другому Discord/);
        const mismatch=await manager.refresh(true);
        assert(!mismatch.peers.has('999'));
        assert(!mismatch.peers.has('111'));
        manager.remove('100.77.1.2');
        assert.deepEqual(manager.saved().map(p=>p.userId),['222']);
        fs.writeFileSync(manager.file,'broken JSON');
        assert.throws(()=>manager.save('100.77.1.5','333','another'));
        assert.equal(fs.readFileSync(manager.file,'utf8'),'broken JSON');
        // An unsaved Radmin address is discovered, verified, and used for delivery.
        const automaticRadmin = new PeerNetwork(path.join(directory,'radmin-auto'));
        const fetchBeforeRadmin = global.fetch;
        global.fetch=async(url,options={})=>{
            if(url.endsWith('/peers'))return {ok:true,json:async()=>({addresses:['26.10.0.2'],radmin:{available:true,discovery:true}})};
            if(url.endsWith('/ping'))return {ok:true,json:async()=>({ok:true,userId:'444',protocol:1})};
            if(url.endsWith('/subtitle')){sends.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({ok:true})};}
            throw Error('Unexpected Radmin endpoint');
        };
        sends=[];
        const discovered=await automaticRadmin.refresh(true);
        assert.equal(discovered.peers.get('444')[0].source,'auto');
        assert.equal(discovered.radmin.discovery,true);
        assert.deepEqual(automaticRadmin.saved(),[]);
        await automaticRadmin.send({userId:'000',text:'Radmin automatic'},['444','555']);
        assert.equal(sends.length,1);
        assert.equal(sends[0].url,'http://26.10.0.2:8765/subtitle');
        global.fetch=fetchBeforeRadmin;
        console.log('PASS: Tailscale validation, per-friend persistence, self address, discovery sharing, automatic/manual routing, deduplication, fallback, identity mismatch, damaged settings preservation');
    } finally {
        global.fetch=originalFetch;
        fs.rmSync(directory,{recursive:true,force:true});
    }
}
main().catch(error=>{console.error(error);process.exitCode=1;});

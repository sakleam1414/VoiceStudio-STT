// Shared networking source, bundled into both plugins by tools/bundle-network.py.
const fs = require('fs');
const path = require('path');

// Keep these exports for older plugins during an update; updates live in Voice Studio.
async function check() { return null; }
function panel() {
    const root = document.createElement('div');
    root.textContent = 'Обновления сервера, Microphone и Subtitles находятся в окне Voice Studio. Нажмите «Проверить», затем «Установить».';
    Object.assign(root.style, {padding:'16px', color:'#dbe4f4', background:'#10131e', borderRadius:'12px', font:'14px/1.6 Segoe UI, sans-serif'});
    return root;
}
function show() { BdApi.UI?.showToast?.('Обновления доступны в окне Voice Studio.', {type:'info'}); }

// Network addresses are personal data. They are stored separately from release files.
function parsePeerAddress(input) {
    const value = String(input || '').trim();
    const match = /^(?:http:\/\/)?((?:100|26)\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::(\d{1,5}))?\/?$/.exec(value);
    if (!match) throw new Error('Введите IP Tailscale (100.x.x.x) или Radmin VPN (26.x.x.x)');
    const parts = match[1].split('.').map(Number);
    if (parts.some(n => n > 255) || !(parts[0] === 26 || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127))) throw new Error('Нужен IPv4 Tailscale (100.64–100.127) или Radmin VPN (26.x.x.x).');
    const port = Number(match[2] || 8765);
    if (port < 1 || port > 65535) throw new Error('Порт должен быть от 1 до 65535.');
    const host = parts.join('.');
    return {address: port === 8765 ? host : `${host}:${port}`, url: `http://${host}:${port}`};
}

async function networkRequest(url, options = {}, timeoutMs = 2500) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {...options, signal: controller.signal});
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        return data;
    } finally { clearTimeout(timeout); }
}

class PeerNetwork {
    constructor(directory) {
        this.file = path.join(directory, 'stt_peers.json');
        this.snapshot = null;
        this.checkedAt = 0;
        this.pending = null;
        this.revision = 0;
    }

    saved() {
        if (!fs.existsSync(this.file)) return [];
        const data = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''));
        if (!Array.isArray(data.peers)) throw new Error('Не удалось прочитать stt_peers.json. Сохраните копию и проверьте файл.');
        return data.peers.map(peer => ({
            address: parsePeerAddress(peer.address).address,
            userId: /^\d{1,24}$/.test(peer.userId || '') ? peer.userId : null,
            name: String(peer.name || '').slice(0, 80)
        }));
    }

    write(peers) {
        const temp = `${this.file}.tmp`;
        fs.writeFileSync(temp, JSON.stringify({schema: 1, peers}, null, 2) + '\n', 'utf8');
        fs.renameSync(temp, this.file);
        this.revision++;
        this.checkedAt = 0;
        this.snapshot = null;
    }

    save(input, userId = null, name = '') {
        const address = parsePeerAddress(input).address;
        if (userId && !/^\d{1,24}$/.test(userId)) throw new Error('Некорректный Discord ID.');
        // Read before write: never overwrite a damaged personal file silently.
        const peers = this.saved().filter(p => p.address !== address && (!userId || p.userId !== userId));
        peers.push({address, userId, name: String(name).slice(0, 80)});
        this.write(peers);
        return address;
    }

    remove(address) { this.write(this.saved().filter(p => p.address !== address)); }

    async probe(input, expectedId = null) {
        const endpoint = parsePeerAddress(input);
        const peer = await networkRequest(endpoint.url + '/ping');
        if (!peer.ok || peer.protocol !== 1 || !/^\d{1,24}$/.test(peer.userId || '')) throw new Error('Сервер не подтвердил Discord-пользователя.');
        if (expectedId && peer.userId !== expectedId) throw new Error('Этот адрес принадлежит другому Discord-пользователю. Проверьте адрес друга.');
        return {userId: peer.userId, address: endpoint.address};
    }

    async self(vpn = null) {
        const data = await networkRequest('http://127.0.0.1:8765/network', {}, 6500);
        const address = vpn ? data.networks?.find(n => n.vpn === vpn)?.address || data.addresses?.find(ip => vpn === 'radmin' ? ip.startsWith('26.') : ip.startsWith('100.')) : data.addresses?.[0];
        if (!address) throw new Error('Нет адреса выбранной VPN. Подключите Tailscale или Radmin VPN.');
        return parsePeerAddress(`${address}:${data.port || 8765}`).address;
    }

    async refresh(force = false) {
        if (this.pending) {
            const revision = this.revision;
            const result = await this.pending;
            if (revision !== this.revision || result.revision !== this.revision) return this.refresh(true);
            return result;
        }
        if (!force && this.snapshot && Date.now() - this.checkedAt < 10000) return this.snapshot;
        const revision = this.revision;
        this.pending = (async () => {
            const manual = this.saved();
            let addresses = [], discoveryError = '', radmin = null;
            try {
                const data = await networkRequest('http://127.0.0.1:8765/peers', {}, 6500);
                if (!Array.isArray(data.addresses)) throw new Error('Сервер не вернул список устройств.');
                addresses = data.addresses.map(a => parsePeerAddress(a).address);
                radmin = data.radmin || null;
            } catch (error) { discoveryError = error.message; }
            const candidates = [...new Set([...addresses, ...manual.map(p => p.address)])];
            const peers = new Map(), states = new Map();
            // Bound concurrent probes, including large tailnets.
            let cursor = 0;
            await Promise.all(Array.from({length: Math.min(8, candidates.length)}, async () => {
                while (cursor < candidates.length) {
                    const address = candidates[cursor++];
                    const saved = manual.find(p => p.address === address);
                    try {
                        const peer = await this.probe(address, saved?.userId);
                        peer.source = addresses.includes(address) ? 'auto' : 'manual';
                        states.set(address, {ok: true, userId: peer.userId});
                        const items = peers.get(peer.userId) || [];
                        items.push(peer); peers.set(peer.userId, items);
                    } catch (error) { states.set(address, {ok: false, error: error.message}); }
                }
            }));
            for (const items of peers.values()) items.sort((a,b) => (a.source === 'manual') - (b.source === 'manual'));
            return {peers, states, addresses, discoveryError, revision, radmin};
        })();
        try {
            const result = await this.pending;
            if (this.revision === revision) { this.snapshot = result; this.checkedAt = Date.now(); }
            return result;
        } finally { this.pending = null; }
    }

    async send(payload, participantIds) {
        const result = await this.refresh();
        const recipients = new Set(participantIds);
        recipients.delete(payload.userId);
        await Promise.all([...recipients].map(async id => {
            const candidates = result.peers.get(id) || [];
            for (const peer of candidates) {
                try {
                    await networkRequest(parsePeerAddress(peer.address).url + '/subtitle', {
                        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload)
                    });
                    return;
                } catch (error) { console.warn('[Voice Studio] Адрес недоступен:', peer.address, error.message); }
            }
            if (candidates.length) this.checkedAt = 0;
        }));
    }
}

const networks = new Map();
function network(directory) {
    if (!networks.has(directory)) networks.set(directory, new PeerNetwork(directory));
    return networks.get(directory);
}

function showNetwork(directory, friend = {}) {
    const manager = network(directory);
    const backdrop = document.createElement('div');
    backdrop.dataset.voiceNetwork = 'true';
    Object.assign(backdrop.style, {position:'fixed', inset:'0', zIndex:'2147483646', background:'#000b', display:'grid', placeItems:'center', padding:'16px', boxSizing:'border-box'});
    const dialog = document.createElement('section');
    Object.assign(dialog.style, {display:'grid', gap:'12px', width:'min(520px,100%)', minWidth:'0', boxSizing:'border-box', maxHeight:'90vh', overflowY:'auto', padding:'22px', border:'1px solid #35415b', borderRadius:'16px', background:'#10131e', color:'#dbe4f4', font:'14px/1.5 Segoe UI, sans-serif', boxShadow:'0 24px 80px #0009'});
    dialog.setAttribute('role','dialog'); dialog.setAttribute('aria-modal','true'); dialog.setAttribute('aria-label','Связь с друзьями');
    const heading = document.createElement('strong'); heading.textContent = friend.userId ? `Адрес: ${friend.name || 'друг'}` : 'Связь с друзьями'; heading.style.fontSize = '20px';
    const hint = document.createElement('div'); hint.textContent = 'Tailscale и Radmin VPN: автоматический поиск друзей с Voice Studio. В Radmin один раз войдите в общую сеть VoiceStudio через «Сеть → Присоединиться к сети». Если друг не найден, добавьте его адрес вручную.'; hint.style.color='#9eacc4';
    const status = document.createElement('div'); status.setAttribute('role','status'); status.style.color='#93d3e2';
    function button(text, action) {
        const node = document.createElement('button'); node.type='button'; node.textContent=text;
        Object.assign(node.style,{padding:'9px 12px', color:'#e8edf8', background:'#202940', border:'1px solid #39496b', borderRadius:'8px', cursor:'pointer', font:'inherit'});
        node.onclick=action; return node;
    }
    const own = document.createElement('div'); Object.assign(own.style,{display:'flex', gap:'8px', flexWrap:'wrap', alignItems:'center'});
    const ownAddress = document.createElement('span'); ownAddress.textContent='Мой адрес: проверка…'; ownAddress.style.flex='1';
    let selfAddress = null;
    const vpnChoice=document.createElement('select'); vpnChoice.setAttribute('aria-label','VPN для моего адреса');
    vpnChoice.append(new Option('Tailscale','tailscale'),new Option('Radmin VPN','radmin'));
    Object.assign(vpnChoice.style,{padding:'9px',color:'#e8edf8',background:'#202940',border:'1px solid #39496b',borderRadius:'8px',font:'inherit'});
    vpnChoice.onchange=()=>{selfAddress=null;ownAddress.textContent='Мой адрес: проверка…';void manager.self(vpnChoice.value).then(value=>{selfAddress=value;ownAddress.textContent=`Мой адрес: ${value}`;}).catch(error=>{ownAddress.textContent=error.message;});};
    const copy = button('Скопировать мой адрес', async () => {
        try {
            selfAddress = await manager.self(vpnChoice.value);
            ownAddress.textContent=`Мой адрес: ${selfAddress}`;
            if (typeof DiscordNative !== 'undefined' && DiscordNative.clipboard?.copy) DiscordNative.clipboard.copy(selfAddress);
            else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(selfAddress);
            else require('electron').clipboard.writeText(selfAddress);
            status.textContent='Адрес скопирован. Отправьте его другу в сообщении.';
        } catch (error) { status.textContent=`Не удалось скопировать: ${error.message}`; }
    });
    const openRadmin=button('Radmin: запуск и адрес',async()=>{
        openRadmin.disabled=true;
        try {
            const data=await networkRequest('http://127.0.0.1:8765/radmin/open',{method:'POST'});
            status.textContent=data.message || 'Radmin открыт. Первый вход в общую сеть — вручную.';
            vpnChoice.value='radmin'; vpnChoice.onchange();
        } catch(error){status.textContent=`Radmin: ${error.message}`;}
        finally{openRadmin.disabled=false;}
    });
    own.append(openRadmin,vpnChoice,ownAddress,copy);
    const nameLabel=document.createElement('label'); nameLabel.textContent='Имя друга (для себя)';
    const name=document.createElement('input'); name.value=friend.name || ''; name.maxLength=80; name.setAttribute('aria-label','Имя друга'); nameLabel.append(name);
    let editingId=friend.userId || null, editingAddress=null;
    const participantLabel=document.createElement('label'); participantLabel.textContent='Участник голосового канала';
    const participant=document.createElement('select'); participant.setAttribute('aria-label','Участник голосового канала');
    participant.append(new Option('Определить по адресу друга', ''));
    try {
        const store=n=>BdApi.Webpack.getStore(n);
        const self=store('UserStore').getCurrentUser()?.id;
        const channel=store('SelectedChannelStore').getVoiceChannelId();
        const users=Object.values(store('VoiceStateStore').getVoiceStatesForChannel(channel) || {});
        const seen=new Set();
        for(const voice of users) {
            const id=voice.userId || voice.user?.id;
            if(!id || id===self || seen.has(id))continue;
            seen.add(id);
            const user=store('UserStore').getUser(id);
            participant.append(new Option(user?.globalName || user?.username || id,id));
        }
    } catch(_) {}
    if(friend.userId && ![...participant.options].some(o=>o.value===friend.userId)) participant.append(new Option(friend.name || 'Друг',friend.userId));
    participant.value=editingId || ''; participant.disabled=!!friend.userId;
    participant.onchange=()=>{
        editingId=participant.value || null; editingAddress=null;
        if(editingId)name.value=participant.selectedOptions[0].textContent;
        try{address.value=manager.saved().find(p=>p.userId===editingId)?.address || '';}catch(error){status.textContent=error.message;}
    };
    participantLabel.append(participant);
    const addressLabel=document.createElement('label'); addressLabel.textContent='Адрес друга в VPN';
    const address=document.createElement('input'); address.placeholder='100.x.x.x или 26.x.x.x'; address.setAttribute('aria-label','Адрес друга в VPN'); address.autocomplete='off'; address.maxLength=100; addressLabel.append(address);
    for (const input of [name,address,participant]) Object.assign(input.style,{display:'block', boxSizing:'border-box', width:'100%', marginTop:'5px', padding:'10px', borderRadius:'8px', border:'1px solid #39496b', color:'#fff', background:'#1b2232', font:'inherit'});
    try { if(friend.userId) {const saved=manager.saved().find(p=>p.userId===friend.userId);if(saved)address.value=saved.address;} }
    catch(error){status.textContent=error.message;}
    const actions=document.createElement('div'); Object.assign(actions.style,{display:'flex', flexWrap:'wrap', gap:'8px'});
    const list=document.createElement('div'); Object.assign(list.style,{display:'grid', gap:'8px'});
    let busy=false;
    async function refresh() {
        if (busy) return;
        busy=true;
        scan.disabled=true;
        try {
            const result=await manager.refresh(true);
            if (!backdrop.isConnected) return;
            list.replaceChildren();
            const total=result.peers.size;
            status.textContent=result.discoveryError ? 'Автопоиск сейчас недоступен. Добавьте адрес друга вручную; сохранённые адреса проверены.' : `Найдено друзей: ${total}. Можно также добавить адрес вручную.`;
            if(result.radmin?.available && !result.radmin.discovery)status.textContent+=' Поиск Radmin недоступен: используйте ручной адрес.';
            for(const peer of manager.saved()) {
                const row=document.createElement('div'); Object.assign(row.style,{padding:'10px', background:'#151a28', borderRadius:'8px', overflowWrap:'anywhere'});
                const state=result.states.get(peer.address);
                const text=document.createElement('div'); text.textContent=`${peer.name || 'Друг'} · ${peer.address} · ${state?.ok ? 'на связи' : (state?.error || 'проверка не выполнена')}`;
                const edit=button('Изменить',()=>{address.value=peer.address;name.value=peer.name;editingId=peer.userId;editingAddress=peer.address;participant.value=peer.userId || '';address.focus();});
                const remove=button('Удалить адрес',()=>{try{manager.remove(peer.address);if(editingAddress===peer.address){editingAddress=null;editingId=friend.userId || null;address.value='';}void refresh();}catch(error){status.textContent=error.message;}});
                edit.style.marginRight='6px';
                row.append(text,edit,remove);list.append(row);
            }
        } catch(error){status.textContent=error.message;}
        finally {busy=false;scan.disabled=false;}
    }
    const check=button('Проверить адрес',async()=>{
        check.disabled=true;
        try {const peer=await manager.probe(address.value,editingId);status.textContent=`Друг на связи · Discord ID ${peer.userId}. Можно сохранить адрес.`;}
        catch(error){status.textContent=`Проверка: ${error.message}`;}
        finally{check.disabled=false;}
    });
    const save=button('Сохранить адрес',async()=>{
        save.disabled=true;
        try {
            const normalized=parsePeerAddress(address.value).address;
            // A failed probe may mean an offline friend; preserve the expected Discord identity.
            let id=editingId;
            try {id=(await manager.probe(normalized,editingId)).userId;}
            catch(error) {
                if(error.message.includes('другому Discord')) throw error;
            }
            if(editingAddress && editingAddress!==normalized) {
                const peers=manager.saved().filter(p=>p.address!==editingAddress && p.address!==normalized && (!id || p.userId!==id));
                peers.push({address:normalized,userId:id,name:name.value});manager.write(peers);
            } else manager.save(normalized,id,name.value);
            await refresh();
            status.textContent='Адрес сохранён. Автопоиск остаётся включён; ручной адрес используется при необходимости.';
        } catch(error){status.textContent=error.message;}
        finally{save.disabled=false;}
    });
    const scan=button('Обновить поиск',()=>refresh());
    actions.append(check,save,scan);
    const previous=document.activeElement;
    function dismiss(){backdrop.remove();window.removeEventListener('keydown',keydown,true);previous?.focus();}
    function keydown(event){
        if(event.key==='Escape'){event.preventDefault();event.stopPropagation();dismiss();}
        if(event.key==='Tab'){
            const controls=[...dialog.querySelectorAll('button:not(:disabled),input,select:not(:disabled)')];const first=controls[0],last=controls[controls.length-1];
            if(event.shiftKey && document.activeElement===first){event.preventDefault();last?.focus();}
            else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}
        }
    }
    const close=button('Готово',dismiss);
    dialog.append(heading,hint,own,participantLabel,nameLabel,addressLabel,actions,status,list,close);backdrop.append(dialog);document.body.append(backdrop);
    backdrop.onclick=event=>{if(event.target===backdrop)dismiss();};window.addEventListener('keydown',keydown,true);address.focus();
    void manager.self().then(value=>{selfAddress=value;vpnChoice.value=value.startsWith('26.')?'radmin':'tailscale';ownAddress.textContent=`Мой адрес: ${value}`;}).catch(error=>{ownAddress.textContent=`Мой адрес: ${error.message}`;});
    void refresh();
}

module.exports = {check, panel, show, network, showNetwork, parsePeerAddress, PeerNetwork};

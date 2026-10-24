// Shared by both plugins. Downloads are verified and installed by stt_updater.ps1.
const fs = require('fs');
const path = require('path');
const {execFile} = require('child_process');
const DEFAULT_REPOSITORY = 'sakleam1414/VoiceStudio-STT';
const running = new Map();

function repository(directory) {
    try {
        const value = JSON.parse(fs.readFileSync(path.join(directory, 'stt_update.json'), 'utf8')).repository;
        if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return value;
    } catch (_) {}
    return DEFAULT_REPOSITORY;
}

function run(directory, component, install = false) {
    const key = `${directory}:${component}`;
    if (running.has(key)) return running.get(key);
    const operation = new Promise((resolve, reject) => {
        const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(directory, 'stt_updater.ps1'), '-Directory', directory, '-Component', component, '-Repository', repository(directory)];
        if (install) args.push('-Install');
        execFile(executable, args, {windowsHide: true, timeout: install ? 180000 : 45000, encoding: 'utf8'}, (error, stdout, stderr) => {
            if (error) return reject(new Error((stderr || error.message).trim().slice(0, 300)));
            try { resolve(JSON.parse(stdout.trim())); }
            catch (_) { reject(new Error('Не удалось прочитать ответ обновления.')); }
        });
    }).finally(() => running.delete(key));
    running.set(key, operation);
    return operation;
}

async function check(directory, component) {
    const result = await run(directory, component);
    if (result.available) {
        const key = `${component}:${result.version}`;
        window.__voiceStudioUpdateNotices ||= new Set();
        if (!window.__voiceStudioUpdateNotices.has(key)) {
            window.__voiceStudioUpdateNotices.add(key);
            BdApi.UI?.showToast?.(`Обновление ${component}: ${result.current} → ${result.version}. Откройте настройки плагина.`, {type: 'info', timeout: 10000});
        }
    }
    return result;
}

function panel(directory, component) {
    const root = document.createElement('div');
    Object.assign(root.style, {display:'grid', gap:'12px', color:'#dbe4f4', padding:'16px', border:'1px solid #35415b', borderRadius:'12px', background:'#10131e', font:'14px Segoe UI, sans-serif'});
    const heading = document.createElement('strong');
    heading.textContent = 'Обновление Voice Studio';
    const status = document.createElement('div');
    status.setAttribute('role', 'status');
    status.textContent = 'Проверка новой версии…';
    const source = document.createElement('a');
    source.href = `https://github.com/${repository(directory)}/releases`;
    source.textContent = 'Релизы на GitHub ↗';
    source.target = '_blank'; source.rel = 'noopener noreferrer'; source.style.color = '#93c8ff';
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = 'Проверить обновление';
    Object.assign(button.style, {padding:'9px 14px', color:'#fff', background:'#5865f2', border:'0', borderRadius:'8px', cursor:'pointer'});
    let available = false;
    async function refresh() {
        button.disabled = true;
        try {
            const result = await check(directory, component);
            available = result.available;
            status.textContent = available ? `${component}: ${result.current} → ${result.version}` : `${component} ${result.current} · установлена последняя версия`;
            button.textContent = available ? 'Установить обновление' : 'Проверить обновление';
        } catch (error) { status.textContent = `Не удалось проверить: ${error.message}`; }
        finally { button.disabled = false; }
    }
    button.onclick = async () => {
        if (!available) return refresh();
        button.disabled = true;
        status.textContent = 'Скачивание и проверка файлов…';
        try {
            const result = await run(directory, component, true);
            available = false;
            status.textContent = result.installed ? `Установлена версия ${result.version}. Если плагин ещё не обновился, выключите и включите его.` : 'Установлена последняя версия.';
            button.textContent = 'Проверить обновление';
        } catch (error) { status.textContent = `Обновление не установлено: ${error.message}`; }
        finally { button.disabled = false; }
    };
    root.append(heading, status, button, source);
    void refresh();
    return root;
}

function show(directory, component) {
    const backdrop = document.createElement('div');
    Object.assign(backdrop.style, {position:'fixed', inset:'0', zIndex:'2147483646', background:'#000b', display:'grid', placeItems:'center', padding:'20px'});
    const content = panel(directory, component);
    Object.assign(content.style, {width:'min(440px, 100%)', maxHeight:'85vh', overflowY:'auto'});
    const close = document.createElement('button');
    close.type = 'button'; close.textContent = 'Закрыть';
    const previous = document.activeElement;
    function dismiss() { backdrop.remove(); window.removeEventListener('keydown', keydown, true); previous?.focus(); }
    function keydown(event) {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
        if (event.key === 'Tab') {
            const controls = [...content.querySelectorAll('button:not(:disabled), a[href]')];
            const first = controls[0], last = controls[controls.length-1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
    }
    close.onclick = dismiss;
    backdrop.onclick = event => { if (event.target === backdrop) dismiss(); };
    content.setAttribute('role', 'dialog'); content.setAttribute('aria-modal', 'true'); content.setAttribute('aria-label', 'Обновление Voice Studio');
    content.append(close); backdrop.append(content); document.body.append(backdrop);
    window.addEventListener('keydown', keydown, true); close.focus();
}

// Network addresses are personal data. They are stored separately from release files.
function parsePeerAddress(input) {
    const value = String(input || '').trim();
    const match = /^(?:http:\/\/)?(100\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::(\d{1,5}))?\/?$/.exec(value);
    if (!match) throw new Error('Введите адрес Tailscale: 100.x.x.x или 100.x.x.x:8765');
    const parts = match[1].split('.').map(Number);
    if (parts.some(n => n > 255) || parts[1] < 64 || parts[1] > 127) throw new Error('Это не IPv4-адрес сети Tailscale (100.64–100.127).');
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

    async self() {
        const data = await networkRequest('http://127.0.0.1:8765/network', {}, 6500);
        const address = data.addresses?.[0];
        if (!address) throw new Error('Нет адреса Tailscale. Подключите Tailscale и повторите.');
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
            let addresses = [], discoveryError = '';
            try {
                const data = await networkRequest('http://127.0.0.1:8765/peers', {}, 6500);
                if (!Array.isArray(data.addresses)) throw new Error('Сервер не вернул список устройств.');
                addresses = data.addresses.map(a => parsePeerAddress(a).address);
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
            return {peers, states, addresses, discoveryError, revision};
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
    const hint = document.createElement('div'); hint.textContent = 'Tailscale ищет друзей автоматически. Если друг не найден, попросите его скопировать свой адрес и добавьте его здесь.'; hint.style.color='#9eacc4';
    const status = document.createElement('div'); status.setAttribute('role','status'); status.style.color='#93d3e2';
    function button(text, action) {
        const node = document.createElement('button'); node.type='button'; node.textContent=text;
        Object.assign(node.style,{padding:'9px 12px', color:'#e8edf8', background:'#202940', border:'1px solid #39496b', borderRadius:'8px', cursor:'pointer', font:'inherit'});
        node.onclick=action; return node;
    }
    const own = document.createElement('div'); Object.assign(own.style,{display:'flex', gap:'8px', flexWrap:'wrap', alignItems:'center'});
    const ownAddress = document.createElement('span'); ownAddress.textContent='Мой адрес: проверка…'; ownAddress.style.flex='1';
    let selfAddress = null;
    const copy = button('Скопировать мой адрес', async () => {
        try {
            selfAddress = await manager.self();
            ownAddress.textContent=`Мой адрес: ${selfAddress}`;
            require('electron').clipboard.writeText(selfAddress);
            status.textContent='Адрес скопирован. Отправьте его другу в сообщении.';
        } catch (error) { status.textContent=`Не удалось скопировать: ${error.message}`; }
    });
    own.append(ownAddress,copy);
    const nameLabel=document.createElement('label'); nameLabel.textContent='Имя друга (для себя)';
    const name=document.createElement('input'); name.value=friend.name || ''; name.maxLength=80; name.setAttribute('aria-label','Имя друга'); nameLabel.append(name);
    const addressLabel=document.createElement('label'); addressLabel.textContent='Адрес друга в Tailscale';
    const address=document.createElement('input'); address.placeholder='100.x.x.x или 100.x.x.x:8765'; address.setAttribute('aria-label','Адрес друга в Tailscale'); address.autocomplete='off'; address.maxLength=100; addressLabel.append(address);
    for (const input of [name,address]) Object.assign(input.style,{display:'block', boxSizing:'border-box', width:'100%', marginTop:'5px', padding:'10px', borderRadius:'8px', border:'1px solid #39496b', color:'#fff', background:'#1b2232', font:'inherit'});
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
            status.textContent=result.discoveryError ? `Автопоиск недоступен: ${result.discoveryError}. Ручные адреса проверены.` : `Найдено друзей: ${total}. Автопоиск включён.`;
            for(const peer of manager.saved()) {
                const row=document.createElement('div'); Object.assign(row.style,{padding:'10px', background:'#151a28', borderRadius:'8px', overflowWrap:'anywhere'});
                const state=result.states.get(peer.address);
                const text=document.createElement('div'); text.textContent=`${peer.name || 'Друг'} · ${peer.address} · ${state?.ok ? 'на связи' : (state?.error || 'проверка не выполнена')}`;
                const edit=button('Изменить',()=>{address.value=peer.address;name.value=peer.name;editingId=peer.userId;editingAddress=peer.address;address.focus();});
                const remove=button('Удалить адрес',()=>{try{manager.remove(peer.address);if(editingAddress===peer.address){editingAddress=null;editingId=friend.userId || null;address.value='';}void refresh();}catch(error){status.textContent=error.message;}});
                edit.style.marginRight='6px';
                row.append(text,edit,remove);list.append(row);
            }
        } catch(error){status.textContent=error.message;}
        finally {busy=false;scan.disabled=false;}
    }
    let editingId=friend.userId || null, editingAddress=null;
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
            const controls=[...dialog.querySelectorAll('button:not(:disabled),input')];const first=controls[0],last=controls[controls.length-1];
            if(event.shiftKey && document.activeElement===first){event.preventDefault();last?.focus();}
            else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}
        }
    }
    const close=button('Готово',dismiss);
    dialog.append(heading,hint,own,nameLabel,addressLabel,actions,status,list,close);backdrop.append(dialog);document.body.append(backdrop);
    backdrop.onclick=event=>{if(event.target===backdrop)dismiss();};window.addEventListener('keydown',keydown,true);address.focus();
    void manager.self().then(value=>{selfAddress=value;ownAddress.textContent=`Мой адрес: ${value}`;}).catch(error=>{ownAddress.textContent=`Мой адрес: ${error.message}`;});
    void refresh();
}

module.exports = {check, panel, run, repository, show, network, showNetwork, parsePeerAddress, PeerNetwork};

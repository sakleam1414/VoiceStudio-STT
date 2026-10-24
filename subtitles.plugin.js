/**
 * @name Subtitles
 * @author Codex
 * @version 1.11.0
 * @description Чистые субтитры. ЛКМ — окно субтитров, ПКМ — участники и автоматический поиск устройств.
 */
// BEGIN GENERATED VOICE STUDIO NETWORK
function createVoiceStudioNetwork() {
    const helperModule = {exports: {}};
    (function(require, module) {
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
            const hint = document.createElement('div'); hint.textContent = 'Tailscale: автоматический поиск или ручной адрес. Radmin VPN: вступите с другом в одну сеть и добавьте его адрес 26.x.x.x вручную.'; hint.style.color='#9eacc4';
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
            own.append(vpnChoice,ownAddress,copy);
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

    })(require, helperModule);
    return helperModule.exports;
}
// END GENERATED VOICE STUDIO NETWORK

module.exports = class Subtitles {
    start() {
        this.stop();
        this.shared = createVoiceStudioNetwork();
        window.__bdSubtitlesActive = (window.__bdSubtitlesActive || 0) + 1;
        this.isSubtitlePluginActive = true;
        const savedUsers = BdApi.Data.load("Subtitles", "selectedUsers");
        this.captionUsers = new Set(Array.isArray(savedUsers) ? savedUsers : []);
        this.participantProfiles = new Map();
        this.mutedUsers = new Set();
        this.userSubtitles = new Map();
        this.offlineUsers = new Set();
        this.subtitleServerState = "checking";
        this.subtitleServerMessage = "● Подключаюсь к серверу субтитров…";
        this.port = 8765;
        this.tailscalePeers = new Map();
        this.tailscalePeerAddresses = [];
        this.peerDiscoveryMessage = null;
        this.serviceError = null;

        this.button = document.createElement("button");
        this.button.type = "button";
        this.button.className = "subtitles-voice-button";
        this.button.title = "ЛКМ — Окно субтитров | ПКМ — Настройка участников в сети";
        this.button.setAttribute("aria-label", "Субтитры");
        this.button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="2" y="4" width="20" height="16" rx="3" stroke="currentColor" stroke-width="1.8"/>
            <path d="M6 12h4M13 12h5" stroke="#9295ff" stroke-width="2" stroke-linecap="round"/>
            <path d="M6 16h8M17 16h1" stroke="#54d6e5" stroke-width="2" stroke-linecap="round"/>
            <circle cx="20" cy="5" r="2.4" fill="#f56a9a" stroke="var(--background-secondary,#1e1f22)" stroke-width="1.3"/>
        </svg>`;

        this.button.addEventListener("click", event => {
            if (event.button === 0) this.togglePanel();
        });

        this.button.addEventListener("contextmenu", event => {
            event.preventDefault();
            this.toggleParticipantMenu();
        });

        this.onSubtitleEvent = event => {
            this.handleIncomingSubtitle(event.detail);
        };
        window.addEventListener("bd-subtitle-received", this.onSubtitleEvent);

        this.startSubtitleService();

        BdApi.DOM.addStyle("Subtitles", `
            .subtitles-voice-button {
                width: 30px; height: 30px; flex: 0 0 30px; padding: 3px;
                border: 0; border-radius: 8px; background: transparent;
                color: var(--interactive-normal, #b5bac1);
                display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
            }
            .subtitles-voice-button:hover { color: #fff; background: var(--background-modifier-hover, #80808022); }
            .subtitles-voice-button svg { display: block; pointer-events: none; }

            #subtitles-preview {
                position: fixed; z-index: 2147483001; left: 50%; bottom: 90px; transform: translateX(-50%);
                display: flex; flex-direction: column; gap: 9px; box-sizing: border-box;
                width: min(760px, calc(100vw - 32px)); max-height: calc(100vh - 32px); padding: 18px;
                color: #b7c1d6; background: #10131e; border: 1px solid #30394e; border-radius: 20px;
                box-shadow: 0 24px 80px #0009; font: 14px/1.5 "Segoe UI", system-ui, sans-serif; color-scheme: dark;
            }
            #subtitles-preview[data-dragging="true"] { cursor: grabbing; user-select: none; }
            #subtitles-preview[hidden] { display: none; }
            #subtitles-preview, #subtitles-preview * { box-sizing: border-box; }

            .subtitles-preview-rows { display: flex; flex-direction: column; gap: 9px; max-height: min(60vh, 520px); overflow-y: auto; }

            #subtitles-participant-menu {
                position: fixed; z-index: 2147483002; left: 50%; bottom: 90px; transform: translateX(-50%);
                display: flex; flex-direction: column; gap: 9px; box-sizing: border-box;
                width: min(580px, calc(100vw - 32px)); max-height: calc(100vh - 32px);
                overflow-y: auto; padding: 18px; color: #b7c1d6; background: #10131e;
                border: 1px solid #30394e; border-radius: 20px; box-shadow: 0 24px 80px #0009;
                font: 14px/1.5 "Segoe UI", system-ui, sans-serif; color-scheme: dark;
            }
            #subtitles-participant-menu[hidden] { display: none; }

            .subtitles-network-status { display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 8px 12px; border: 1px solid #394966; border-radius: 10px; background: #131826; }
            .subtitles-network-status-text { flex: 1; min-width: 0; font-size: 12px; overflow-wrap: anywhere; }
            .subtitles-network-status[data-state=\"ok\"] { border-color: #36d399; color: #36d399; }
            .subtitles-network-status[data-state=\"partial\"] { border-color: #92743b; color: #e8bf69; }
            .subtitles-network-status[data-state=\"checking\"] { color: #9bb8df; }
            .subtitles-network-status[data-state=\"error\"] { border-color: #ff5665; color: #ff6b7a; }
            .subtitles-server-status { min-height: 36px; padding: 9px 12px; border: 1px solid #394966; border-radius: 10px; background: #131826; font-size: 13px; font-weight: 600; }
            .subtitles-server-status[data-state=\"active\"] { border-color: #36d399; color: #36d399; }
            .subtitles-server-status[data-state=\"inactive\"] { border-color: #ff5665; color: #ff6b7a; }
            .subtitles-server-status[data-state=\"checking\"] { color: #9bb8df; }
            .subtitles-network-refresh { flex: 0 0 auto; padding: 5px 10px; border: 1px solid #394966; border-radius: 8px; color: #d5d9e4; background: #1b2232; font: inherit; font-size: 12px; cursor: pointer; }
            .subtitles-network-refresh:disabled { opacity: 0.4; cursor: default; }
            .subtitles-participant-row { display: flex; align-items: center; gap: 10px; min-height: 68px; padding: 12px; background: #151a28; border: 1px solid #252e42; border-radius: 12px; }
            .subtitles-participant-row[data-offline=\"true\"] { opacity: 0.55; }
            .subtitles-participant-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
            .subtitles-participant-name { font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .subtitles-participant-state { font-size: 12px; color: #82a5ca; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .subtitles-participant-state[data-state=\"online\"] { color: #36d399; }
            .subtitles-participant-state[data-state=\"offline\"] { color: #ff6b7a; }
            .subtitles-participant-state[data-state=\"checking\"] { color: #e8bf69; }
            .subtitles-participant-state[data-state=\"unknown\"] { color: #e8bf69; }
            .subtitles-presence { width: 20px; flex: 0 0 20px; text-align: center; font-size: 18px; font-weight: 700; }
            .subtitles-presence[data-status=\"online\"] { color: #36d399; }
            .subtitles-presence[data-status=\"offline\"] { color: #ff5665; }
            .subtitles-presence[data-status=\"unknown\"], .subtitles-presence[data-status=\"checking\"] { color: #e8bf69; }
            .subtitles-participant-avatar { width: 38px; height: 38px; border-radius: 50%; object-fit: cover; background: #30384a; flex: 0 0 38px; }
            .subtitles-participant-control { width: 36px; height: 36px; border: 1px solid #394966; border-radius: 10px; color: #82a5ca; background: #111827; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
            .subtitles-participant-control[aria-pressed="true"] { color: #fff; background: #5865f2; border-color: #8490ff; }
            .subtitles-participant-control:disabled { opacity: 0.3; cursor: not-allowed; }

            .subtitles-preview-line { display: flex; align-items: flex-start; gap: 12px; min-height: 72px; padding: 14px; background: #151a28; border: 1px solid #252e42; border-radius: 12px; font-size: 16px; color: #f3f4ff; }
            .subtitles-preview-avatar { width: 38px; height: 38px; border-radius: 50%; object-fit: cover; flex: 0 0 38px; }
            .subtitles-preview-text { flex: 1; white-space: pre-wrap; word-break: break-word; color: #e0e8f9; }
            #subtitles-participant-menu, #subtitles-participant-menu * { box-sizing: border-box; }
            .subtitles-head { display: flex; align-items: center; gap: 12px; padding: 0 0 14px; margin-bottom: 4px; border-bottom: 1px solid #252d40; }
            #subtitles-preview .subtitles-head { cursor: grab; touch-action: none; }
            .subtitles-heading { flex: 1; min-width: 0; }
            .subtitles-eyebrow { color: #88d5e5; font-size: 10px; font-weight: 700; letter-spacing: 1.8px; }
            .subtitles-title { color: #f3f4ff; font-size: 20px; font-weight: 650; letter-spacing: -.4px; }
            .subtitles-head-button { display: inline-flex; align-items: center; justify-content: center; min-width: 32px; height: 32px; padding: 0 9px; background: #1b2232; border: 1px solid #35415b; border-radius: 9px; color: #bac9e0; font: inherit; font-size: 12px; cursor: pointer; }
            .subtitles-close { font-size: 20px; }
            .subtitles-speaker { color: #93d3e2; font-size: 11px; font-weight: 650; letter-spacing: .2px; margin-bottom: 4px; }
            .subtitles-caption-body { min-width: 0; flex: 1; }
            .subtitles-empty { text-align: center; padding: 24px 16px; color: #929fb7; font-size: 13px; }
            .subtitles-empty-icon { display: block; margin-bottom: 12px; color: #88a0e4; }
            .subtitles-empty-title { margin-bottom: 5px; color: #e0e8f9; font-weight: 600; font-size: 15px; }
            .subtitles-menu-empty { padding: 16px; text-align: center; color: #929fb7; }
            .subtitles-hint { font-size: 11px; color: #8492ac; }
            #subtitles-preview :focus-visible, #subtitles-participant-menu :focus-visible, .subtitles-voice-button:focus-visible { outline: 2px solid #96b9ff; outline-offset: 3px; }
            .subtitles-head-button:hover, .subtitles-network-refresh:hover, .subtitles-participant-control:hover { background: #293550; }
            #subtitles-preview, #subtitles-participant-menu, .subtitles-preview-rows { scrollbar-width: thin; scrollbar-color: #3c4966 transparent; }
            @media (max-width: 480px) { #subtitles-preview, #subtitles-participant-menu { padding: 14px; } .subtitles-preview-line { font-size: 15px; } .subtitles-presence { width: 12px; flex-basis: 12px; } }
        `);

        this.createPreview();
        this.onPanelKeyDown = event => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            if (!this.participantMenu.hidden) { this.participantMenu.hidden = true; clearTimeout(this.participantRefreshTimer); }
            else if (!this.preview.hidden) this.preview.hidden = true;
        };
        window.addEventListener("keydown", this.onPanelKeyDown);
        this.onViewportResize = () => {
            if (!this.preview.hidden) this.keepInViewport(this.preview);
            if (!this.participantMenu.hidden) this.keepInViewport(this.participantMenu);
        };
        window.addEventListener("resize", this.onViewportResize);
        this.placeButton();
        this.voiceChannelId = this.getVoiceChannelId();
        this.observer = new MutationObserver(() => this.schedulePlacement());
        this.observer.observe(document.body, {childList: true, subtree: true});
        this.timer = setInterval(() => {
            this.placeButton();
            this.checkVoiceConnection();
        }, 1000);
    }

    startSubtitleService() {
        this.syncSubtitleService();
        this.refreshTailscalePeers().catch(error => this.reportServiceError(error));
        this.subtitleServiceTimer = setInterval(() => this.syncSubtitleService(), 2000);
        this.peerRefreshTimer = setInterval(() => {
            this.refreshTailscalePeers().catch(error => this.reportServiceError(error));
        }, 15000);
    }

    getSettingsPanel() {
        return this.shared.panel(__dirname);
    }

    async requestSubtitleService(path, options = {}, timeoutMs = 2500) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(`http://127.0.0.1:${this.port}${path}`, {
                ...options,
                signal: controller.signal
            });
        } finally {
            clearTimeout(timeout);
        }
    }

    async syncSubtitleService() {
        if (this.serviceSyncInProgress) return;
        this.serviceSyncInProgress = true;
        try {
            const userId = BdApi.Webpack.getStore("UserStore")?.getCurrentUser?.()?.id;
            if (!userId) throw new Error("Не удалось определить Discord-пользователя");
            const registered = await this.requestSubtitleService("/register", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userId })
            });
            if (!registered.ok) throw new Error(`stt_server.py не принял регистрацию (${registered.status})`);

            const pingResponse = await this.requestSubtitleService("/ping");
            const ping = await pingResponse.json();
            if (!pingResponse.ok || !ping?.ok || ping.userId !== userId || ping.protocol !== 1) {
                throw new Error("stt_server.py не подтвердил регистрацию плагина");
            }
            this.subtitleServerState = "active";
            this.subtitleServerMessage = "✓ Сервер субтитров: подключён";
            this.serviceError = null;
            this.renderSubtitleServerStatus();
            if (!this.initialPeerScanDone) {
                this.initialPeerScanDone = true;
                this.refreshTailscalePeers().catch(error => this.reportServiceError(error));
            }

            const inboxResponse = await this.requestSubtitleService("/inbox");
            if (!inboxResponse.ok) throw new Error(`Не удалось получить субтитры (${inboxResponse.status})`);
            const inbox = await inboxResponse.json();
            for (const message of inbox.messages || []) {
                if (this.isVoiceChannelParticipant(message?.userId)) {
                    this.handleIncomingSubtitle(message, true);
                }
            }
        } catch (error) {
            this.subtitleServerState = "inactive";
            this.subtitleServerMessage = "● Сервер субтитров: запусти или перезапусти stt_server.py";
            this.renderSubtitleServerStatus();
            this.reportServiceError(error);
        } finally {
            this.serviceSyncInProgress = false;
        }
    }

    reportServiceError(error) {
        const message = error?.message || String(error);
        if (this.serviceError === message) return;
        this.serviceError = message;
        console.warn("[Subtitles] Связь с сервером субтитров:", message);
    }

    async refreshTailscalePeers() {
        const result = await this.shared.network(__dirname).refresh();
        this.tailscalePeers = new Map([...result.peers].map(([id, peers]) => [id, peers.map(peer => peer.address)]));
        this.peerSources = new Map([...result.peers].map(([id, peers]) => [id, peers[0]?.source]));
        this.tailscalePeerAddresses = result.addresses;
        this.peerDiscoveryMessage = result.discoveryError && !result.peers.size
            ? "Автопоиск недоступен. Нажмите «Адрес» возле друга и вставьте его адрес Tailscale или Radmin VPN."
            : result.addresses.length && !result.peers.size
                ? "Устройства найдены, но серверы не отвечают. Проверьте сервер друга или укажите его адрес."
                : null;
    }

    renderSubtitleServerStatus() {
        const badge = this.participantMenu?.querySelector(".subtitles-server-status");
        if (!badge) return;
        badge.dataset.state = this.subtitleServerState;
        badge.textContent = this.subtitleServerMessage;
    }

    isVoiceChannelParticipant(userId) {
        if (typeof userId !== "string") return false;
        const channelId = this.getVoiceChannelId();
        if (!channelId) return false;
        const states = BdApi.Webpack.getStore("VoiceStateStore")?.getVoiceStatesForChannel?.(channelId);
        const voiceStates = states instanceof Map ? [...states.values()] : Object.values(states || {});
        return voiceStates.some(state => (state.userId || state.user_id) === userId);
    }

    handleIncomingSubtitle(payload, fromPeer = false) {
        if (!payload || typeof payload.text !== "string" || !payload.text.trim()) return;
        const userStore = BdApi.Webpack.getStore("UserStore");
        const currentUserId = userStore?.getCurrentUser?.()?.id;
        const targetId = (!payload.userId || payload.userId === "self") ? currentUserId : payload.userId;
        if (!targetId || this.offlineUsers.has(targetId)) return;

        this.userSubtitles.set(targetId, payload.text);

        if (!this.participantProfiles.has(targetId)) {
            const user = userStore?.getUser?.(targetId) || { id: targetId, globalName: payload.userName || "Участник", getAvatarURL: () => "" };
            this.participantProfiles.set(targetId, { user, channelId: this.getVoiceChannelId() });
        }
        this.renderSelectedAvatars();
        if (!fromPeer) this.sendSubtitleToPeers({ ...payload, userId: targetId });
    }

    async fetchPeerInfo(address) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1500);
        const base = address === "127.0.0.1" ? `http://127.0.0.1:${this.port}`
            : this.shared.parsePeerAddress(address).url;
        try {
            const response = await fetch(`${base}/ping`, { signal: controller.signal });
            if (!response.ok) return null;
            const peer = await response.json();
            return peer?.ok && peer.protocol === 1 && typeof peer.userId === "string"
                ? { userId: peer.userId, address }
                : null;
        } catch {
            return null;
        } finally {
            clearTimeout(timeout);
        }
    }

    async sendSubtitleToPeers(payload) {
        const channelId = this.getVoiceChannelId();
        if (!channelId) return;
        const states = BdApi.Webpack.getStore("VoiceStateStore")?.getVoiceStatesForChannel?.(channelId);
        const voiceStates = states instanceof Map ? [...states.values()] : Object.values(states || {});
        const ids = voiceStates.map(state => state.userId || state.user_id).filter(Boolean);
        try { await this.shared.network(__dirname).send(payload, ids); }
        catch(error) { this.reportServiceError(error); }
    }

    createPreview() {
        this.preview = document.createElement("section");
        this.preview.id = "subtitles-preview";
        this.preview.hidden = true;
        this.preview.setAttribute("aria-label", "Субтитры");
        this.preview.addEventListener("pointerdown", e => this.beginDrag(e));
        this.preview.addEventListener("pointermove", e => this.moveDrag(e));
        this.preview.addEventListener("pointerup", e => this.endDrag(e));
        this.preview.addEventListener("pointercancel", e => this.endDrag(e));

        this.preview.append(this.createPanelHeader("Субтитры", () => { this.preview.hidden = true; }, true));

        this.previewRows = document.createElement("div");
        this.previewRows.className = "subtitles-preview-rows";
        this.previewRows.setAttribute("aria-live", "polite");
        this.preview.append(this.previewRows);

        const savedPosition = BdApi.Data.load("Subtitles", "previewPosition");
        if (savedPosition && Number.isFinite(savedPosition.left) && Number.isFinite(savedPosition.top)) {
            this.preview.style.left = `${savedPosition.left}px`;
            this.preview.style.top = `${savedPosition.top}px`;
            this.preview.style.right = "auto";
            this.preview.style.bottom = "auto";
            this.preview.style.transform = "none";
        }
        document.body.append(this.preview);
        this.createParticipantMenu();
        this.renderSelectedAvatars();
    }

    createPanelHeader(title, close, settings = false) {
        const header = document.createElement("div");
        header.className = "subtitles-head";
        header.innerHTML = `<div class="subtitles-heading"><div class="subtitles-eyebrow">VOICE STUDIO</div><div class="subtitles-title"></div></div>`;
        header.querySelector(".subtitles-title").textContent = title;
        if (settings) {
            const participants = document.createElement("button");
            participants.type = "button";
            participants.className = "subtitles-head-button";
            participants.textContent = "Участники";
            participants.onclick = () => this.toggleParticipantMenu();
            header.append(participants);
        }
        const button = document.createElement("button");
        button.type = "button";
        button.className = "subtitles-head-button subtitles-close";
        button.setAttribute("aria-label", "Закрыть панель");
        button.textContent = "×";
        button.onclick = close;
        header.append(button);
        return header;
    }

    keepInViewport(panel) {
        const bounds = panel.getBoundingClientRect();
        panel.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - bounds.width - 8))}px`;
        panel.style.top = `${Math.max(8, Math.min(bounds.top, window.innerHeight - bounds.height - 8))}px`;
        panel.style.bottom = "auto";
        panel.style.transform = "none";
    }

    beginDrag(event) {
        if (event.button !== 0 || event.target.closest("button") || !event.target.closest(".subtitles-head")) return;
        const bounds = this.preview.getBoundingClientRect();
        this.drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: bounds.left, top: bounds.top };
        this.preview.style.left = `${bounds.left}px`;
        this.preview.style.top = `${bounds.top}px`;
        this.preview.style.right = "auto";
        this.preview.style.bottom = "auto";
        this.preview.style.transform = "none";
        this.preview.dataset.dragging = "true";
        this.preview.setPointerCapture(event.pointerId);
        event.preventDefault();
    }

    moveDrag(event) {
        if (!this.drag || event.pointerId !== this.drag.pointerId) return;
        this.preview.style.left = `${Math.max(8, Math.min(window.innerWidth - this.preview.offsetWidth - 8, this.drag.left + event.clientX - this.drag.startX))}px`;
        this.preview.style.top = `${Math.max(8, Math.min(window.innerHeight - this.preview.offsetHeight - 8, this.drag.top + event.clientY - this.drag.startY))}px`;
    }

    endDrag(event) {
        if (!this.drag || event.pointerId !== this.drag.pointerId) return;
        this.drag = null;
        delete this.preview.dataset.dragging;
        if (this.preview.hasPointerCapture(event.pointerId)) this.preview.releasePointerCapture(event.pointerId);
        try {
            BdApi.Data.save("Subtitles", "previewPosition", { left: this.preview.offsetLeft, top: this.preview.offsetTop });
        } catch (error) {
            console.error("[Subtitles] Could not save subtitle panel position", error);
        }
    }

    createParticipantMenu() {
        this.participantMenu = document.createElement("section");
        this.participantMenu.id = "subtitles-participant-menu";
        this.participantMenu.hidden = true;
        document.body.append(this.participantMenu);
    }

    toggleParticipantMenu() {
        if (!this.participantMenu) return;
        this.participantMenu.hidden = !this.participantMenu.hidden;
        if (!this.participantMenu.hidden) { this.refreshParticipants(); this.keepInViewport(this.participantMenu); }
        else clearTimeout(this.participantRefreshTimer);
    }

    async checkPeer(userId) {
        const currentUserId = BdApi.Webpack.getStore("UserStore")?.getCurrentUser?.()?.id;
        const address = userId === currentUserId ? "127.0.0.1" : (this.tailscalePeers.get(userId) || [])[0];
        if (!address) return "unknown";
        const peer = await this.fetchPeerInfo(address);
        return peer?.userId === userId ? "online" : "offline";
    }

    setParticipantState(row, state, text) {
        row.dataset.offline = String(state === "offline");
        const label = row.querySelector(".subtitles-participant-state");
        label.dataset.state = state;
        label.textContent = text;
    }

    renderNetworkStatus(counts, error = null) {
        const box = this.participantMenu.querySelector(".subtitles-network-status");
        if (!box) return;
        const text = box.querySelector(".subtitles-network-status-text");
        const { online, total, unknown, checking } = counts;
        if (checking) {
            box.dataset.state = "checking";
            text.textContent = "● Автоматически ищу устройства Tailscale…";
        } else if (error) {
            box.dataset.state = "partial";
            text.textContent = "● Добавьте адрес друга вручную кнопкой «Адрес» возле имени.";
        } else if (unknown > 0) {
            box.dataset.state = "partial";
            text.textContent = `● На связи: ${online}/${total} · для подключения нажмите «Адрес» возле друга`;
        } else if (online === total) {
            box.dataset.state = "ok";
            text.textContent = `✓ Субтитры в сети (${online}/${total})`;
        } else {
            box.dataset.state = "partial";
            text.textContent = `● Субтитры в сети: ${online} из ${total}`;
        }
    }

    async refreshParticipants() {
        if (!this.participantMenu) return;
        const refreshId = (this.participantRefreshId || 0) + 1;
        this.participantRefreshId = refreshId;
        clearTimeout(this.participantRefreshTimer);
        this.participantMenu.replaceChildren();
        this.participantMenu.append(this.createPanelHeader("Участники", () => {
            this.participantMenu.hidden = true;
            clearTimeout(this.participantRefreshTimer);
        }));
        const hint = document.createElement("div");
        hint.className = "subtitles-hint";
        hint.textContent = "Выберите, чью речь показывать в субтитрах.";
        this.participantMenu.append(hint);
        const network = document.createElement("button");
        network.type = "button"; network.className = "subtitles-network-refresh";
        network.textContent = "Мой адрес и адреса друзей";
        network.onclick = () => this.shared.showNetwork(__dirname);
        this.participantMenu.append(network);

        const serverStatus = document.createElement("div");
        serverStatus.className = "subtitles-server-status";
        this.participantMenu.append(serverStatus);
        this.renderSubtitleServerStatus();

        const status = document.createElement("div");
        status.className = "subtitles-network-status";
        const statusText = document.createElement("span");
        statusText.className = "subtitles-network-status-text";
        const refreshBtn = document.createElement("button");
        refreshBtn.type = "button";
        refreshBtn.className = "subtitles-network-refresh";
        refreshBtn.textContent = "Проверить";
        refreshBtn.onclick = () => this.refreshParticipants();
        status.append(statusText, refreshBtn);
        this.participantMenu.append(status);

        const getStore = name => { try { return BdApi.Webpack.getStore(name); } catch { return null; } };
        const userStore = getStore("UserStore");
        const currentUser = userStore?.getCurrentUser?.();
        const channelId = this.getVoiceChannelId();
        const states = channelId ? getStore("VoiceStateStore")?.getVoiceStatesForChannel?.(channelId) : null;
        const voiceStates = states instanceof Map ? [...states.values()] : Object.values(states || {});
        const users = voiceStates.map(state => userStore?.getUser?.(state.userId || state.user_id)).filter(Boolean);
        if (currentUser && !users.some(u => u.id === currentUser.id)) users.unshift(currentUser);

        for (const u of users) {
            this.participantProfiles.set(u.id, { user: u, channelId });
        }
        this.renderSelectedAvatars();

        if (!users.length) {
            const empty = document.createElement("p");
            empty.className = "subtitles-menu-empty";
            empty.textContent = "Участники голосового канала не найдены.";
            this.participantMenu.append(empty);
            statusText.textContent = "● Нет участников голосового канала";
            status.dataset.state = "partial";
            return;
        }

        const guildId = getStore("ChannelStore")?.getChannel?.(channelId)?.guild_id;
        const rows = new Map();
        for (const user of users) {
            const row = document.createElement("div");
            row.className = "subtitles-participant-row";
            const isSelf = user.id === currentUser?.id;

            const presence = document.createElement("span");
            presence.className = "subtitles-presence";
            presence.textContent = "";

            const avatar = document.createElement("img");
            avatar.className = "subtitles-participant-avatar";
            avatar.alt = "";
            const avatarUrl = user.getAvatarURL?.(guildId || undefined, 64, false);
            if (avatarUrl) avatar.src = avatarUrl; else avatar.hidden = true;

            const info = document.createElement("div");
            info.className = "subtitles-participant-info";
            const name = document.createElement("span");
            name.className = "subtitles-participant-name";
            name.textContent = (user.globalName || user.username || "Участник") + (isSelf ? " (вы)" : "");
            const stateLabel = document.createElement("span");
            stateLabel.className = "subtitles-participant-state";
            info.append(name, stateLabel);

            const captions = document.createElement("button");
            captions.type = "button";
            captions.className = "subtitles-participant-control";
            const isSelected = this.captionUsers.has(user.id);
            captions.setAttribute("aria-pressed", String(isSelected));
            captions.setAttribute("aria-label", `Субтитры: ${user.globalName || user.username || "Участник"}`);
            captions.textContent = isSelected ? "✓" : "○";
            captions.onclick = () => {
                if (captions.disabled) return;
                const next = captions.getAttribute("aria-pressed") !== "true";
                captions.setAttribute("aria-pressed", String(next));
                captions.textContent = next ? "✓" : "○";
                if (next) this.captionUsers.add(user.id);
                else this.captionUsers.delete(user.id);
                BdApi.Data.save("Subtitles", "selectedUsers", [...this.captionUsers]);
                this.renderSelectedAvatars();
            };

            row.append(presence, avatar, info);
            if (!isSelf) {
                const address = document.createElement("button");
                address.type = "button";
                address.className = "subtitles-network-refresh";
                address.textContent = "Адрес";
                address.setAttribute("aria-label", `Адрес друга: ${user.globalName || user.username || "Участник"}`);
                address.onclick = () => this.shared.showNetwork(__dirname, {userId: user.id, name: user.globalName || user.username || "Участник"});
                row.append(address);
            }
            row.append(captions);
            this.participantMenu.append(row);
            rows.set(user.id, { row, captions, presence });

            this.setParticipantState(row, "checking", isSelf ? "Проверка этого устройства…" : "Автоматический поиск устройства…");
            presence.textContent = "●";
            presence.dataset.status = "checking";
            captions.disabled = true;
        }

        const counts = { online: 0, total: users.length, unknown: 0, checking: true };
        this.renderNetworkStatus(counts);
        counts.checking = false;

        refreshBtn.disabled = true;
        refreshBtn.textContent = "Проверяю…";
        let peerDiscoveryError = null;
        try {
            await this.refreshTailscalePeers();
        } catch (error) {
            peerDiscoveryError = "Не удалось найти друга. Нажмите «Адрес» и вставьте его адрес Tailscale или Radmin VPN.";
            this.reportServiceError(error);
        }
        peerDiscoveryError ||= this.peerDiscoveryMessage;
        const results = await Promise.all(users.map(async user => ({
            user,
            state: await this.checkPeer(user.id)
        })));
        if (this.participantRefreshId !== refreshId || !this.participantMenu || this.participantMenu.hidden) return;
        refreshBtn.disabled = false;
        refreshBtn.textContent = "Проверить";

        counts.online = 0;
        counts.unknown = 0;
        const isSelfRow = user => user.id === currentUser?.id;
        for (const { user, state } of results) {
            const entry = rows.get(user.id);
            if (!entry) continue;
            const { row, captions, presence } = entry;
            const online = state === "online";
            if (online) counts.online++;
            if (state === "unknown") counts.unknown++;
            if (online) this.offlineUsers.delete(user.id);
            else this.offlineUsers.add(user.id);

            const labels = {
                online: isSelfRow(user) ? "Сервер субтитров работает на этом ПК" : (this.peerSources?.get(user.id) === "manual" ? "На связи · ручной адрес" : "На связи · найден автоматически"),
                offline: isSelfRow(user) ? "Сервер субтитров не отвечает на этом ПК" : "Устройство недоступно или сервер субтитров не запущен",
                unknown: isSelfRow(user)
                    ? "Не удалось проверить сервер на этом ПК"
                    : "Друг не найден. Нажмите «Адрес» и вставьте его адрес Tailscale или Radmin VPN."
            };
            this.setParticipantState(row, state, labels[state]);
            presence.textContent = online ? "✓" : state === "unknown" ? "●" : "×";
            presence.dataset.status = state === "unknown" ? "unknown" : (online ? "online" : "offline");
            captions.disabled = !online;
            captions.title = online ? "Включить/выключить субтитры" : "Недоступно: участник не в сети или адрес не задан";
        }
        counts.total = users.length;
        this.renderNetworkStatus(counts, peerDiscoveryError);
        this.renderSelectedAvatars();
        this.keepInViewport(this.participantMenu);

        this.participantRefreshTimer = setTimeout(() => {
            if (!this.participantMenu.hidden) this.refreshParticipants();
        }, 15000);
    }

    renderSelectedAvatars() {
        if (!this.previewRows) return;
        this.previewRows.replaceChildren();
        const selectedUsers = [...this.captionUsers]
            .map(id => this.participantProfiles.get(id))
            .filter(profile => profile && !this.offlineUsers.has(profile.user.id));

        if (!selectedUsers.length) {
            const empty = document.createElement("div");
            empty.className = "subtitles-empty";
            empty.innerHTML = `<span class="subtitles-empty-icon" aria-hidden="true">${this.button.innerHTML}</span><div class="subtitles-empty-title">Готовы слушать</div><div>Откройте «Участники» и выберите, чьи субтитры показывать.</div>`;
            this.previewRows.append(empty);
        }

        for (const profile of selectedUsers) {
            const line = document.createElement("div");
            line.className = "subtitles-preview-line";
            const avatar = document.createElement("img");
            avatar.className = "subtitles-preview-avatar";
            avatar.alt = "";
            const guildId = profile.channelId
                ? BdApi.Webpack.getStore("ChannelStore")?.getChannel?.(profile.channelId)?.guild_id
                : undefined;
            const avatarUrl = profile.user.getAvatarURL?.(guildId || undefined, 64, false);
            if (avatarUrl) avatar.src = avatarUrl; else avatar.hidden = true;

            const textSpan = document.createElement("span");
            textSpan.className = "subtitles-preview-text";
            const userName = profile.user.globalName || profile.user.username || "Участник";
            const currentText = this.userSubtitles.get(profile.user.id) || "Ожидание речи...";
            textSpan.textContent = currentText;

            const body = document.createElement("div");
            body.className = "subtitles-caption-body";
            const speaker = document.createElement("div");
            speaker.className = "subtitles-speaker";
            speaker.textContent = userName;
            body.append(speaker, textSpan);

            line.append(avatar, body);
            this.previewRows.append(line);
        }
        if (!this.preview.hidden) this.keepInViewport(this.preview);
    }

    togglePanel() {
        if (!this.preview) return;
        this.preview.hidden = !this.preview.hidden;
        if (!this.preview.hidden && this.participantMenu) {
            this.participantMenu.hidden = true;
            clearTimeout(this.participantRefreshTimer);
            this.keepInViewport(this.preview);
        }
    }

    getVoiceChannelId() {
        try {
            const userStore = BdApi.Webpack.getStore("UserStore");
            const userId = userStore?.getCurrentUser?.()?.id;
            return BdApi.Webpack.getStore("SelectedChannelStore")?.getVoiceChannelId?.()
                || BdApi.Webpack.getStore("RTCConnectionStore")?.getChannelId?.()
                || BdApi.Webpack.getStore("VoiceStateStore")?.getVoiceStateForUser?.(userId)?.channelId
                || null;
        } catch { return null; }
    }

    checkVoiceConnection() {
        const channelId = this.getVoiceChannelId();
        if (this.voiceChannelId && channelId === null) {
            if (this.preview) this.preview.hidden = true;
            if (this.participantMenu) this.participantMenu.hidden = true;
        }
        this.voiceChannelId = channelId;
    }

    placeButton() {
        if (!this.button) return;
        const panel = document.querySelector('[aria-label="Статус и настройки пользователя"], [aria-label="User status and settings"], [aria-label="User area"], [class*="panels_"]');
        const disconnect = panel && [...panel.querySelectorAll('button, [role="button"]')]
            .find(node => node !== this.button && node.getClientRects().length && /^(?:отключиться|disconnect)$/i.test([node.getAttribute("aria-label"), node.getAttribute("title")].filter(Boolean).join(" ")));
        if (!panel || !disconnect) {
            this.button.remove();
            document.querySelector("#bd-voice-plugin-toolbar:empty")?.remove();
            return;
        }
        let toolbar = panel.querySelector(":scope > #bd-voice-plugin-toolbar");
        if (!toolbar) {
            toolbar = document.createElement("div");
            toolbar.id = "bd-voice-plugin-toolbar";
            Object.assign(toolbar.style, { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "4px", width: "100%", minHeight: "34px", padding: "2px 8px", background: "#111214", borderRadius: "12px 12px 0 0" });
            panel.insertBefore(toolbar, panel.firstChild);
        }
        if (this.button.parentElement !== toolbar) toolbar.append(this.button);
    }

    schedulePlacement() {
        if (this.placementTimer) return;
        this.placementTimer = setTimeout(() => { this.placementTimer = null; this.placeButton(); }, 300);
    }

    stop() {
        if (this.isSubtitlePluginActive) {
            window.__bdSubtitlesActive = Math.max(0, (window.__bdSubtitlesActive || 1) - 1);
            this.isSubtitlePluginActive = false;
        }
        clearInterval(this.timer);
        clearInterval(this.subtitleServiceTimer);
        clearTimeout(this.placementTimer);
        this.observer?.disconnect();
        clearInterval(this.peerRefreshTimer);
        window.removeEventListener("bd-subtitle-received", this.onSubtitleEvent);
        window.removeEventListener("keydown", this.onPanelKeyDown);
        window.removeEventListener("resize", this.onViewportResize);
        this.preview?.remove();
        clearTimeout(this.participantRefreshTimer);
        this.participantMenu?.remove();
        this.button?.remove();
        document.querySelector("#bd-voice-plugin-toolbar:empty")?.remove();
        if (typeof BdApi !== "undefined") BdApi.DOM.removeStyle("Subtitles");
    }
};

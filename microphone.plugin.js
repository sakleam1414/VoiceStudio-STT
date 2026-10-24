/**
 * @name Microphone
 * @author Codex
 * @version 2.9.0
 * @description Локальная передача микрофона в Vosk, Whisper, wav2vec2 или GigaAM и отображение распознанной речи в субтитрах.
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

    })(require, helperModule);
    return helperModule.exports;
}
// END GENERATED VOICE STUDIO NETWORK
const fs = require("fs");
const path = require("path");
const VOSK_MODELS = JSON.parse(fs.readFileSync(path.join(__dirname, "vosk_models.json"), "utf8"));
const SPEECH_ENGINES = JSON.parse(fs.readFileSync(path.join(__dirname, "stt_engines.json"), "utf8"));
if (!Array.isArray(VOSK_MODELS) || VOSK_MODELS.length === 0) {
    throw new Error("The speech model catalog is missing or invalid: vosk_models.json");
}
if (!Array.isArray(SPEECH_ENGINES) || SPEECH_ENGINES.length === 0) {
    throw new Error("The speech engine directory is missing or invalid: stt_engines.json");
}
const VOSK_CATALOG_VERSION = 11;

module.exports = class Microphone {
    start() {
        this.stop();
        this.shared = createVoiceStudioNetwork();
        this.isRecording = false;
        this.audioContext = null;
        this.mediaStream = null;
        this.analyser = null;
        this.processor = null;
        this.sttSocket = null;
        this.catalogSocket = null;
        this.serverStatusSocket = null;
        this.serverStatusTimer = null;
        this.catalogConnectTimer = null;
        this.serverProcess = null;
        this.serverLaunchAttempted = false;
        this.autoConnectTimer = null;
        this.rafId = null;
        this.lastRecognizedText = "";
        this.catalogEngineFilter = null;
        this.installedCatalogModels = null;
        this.modelProgress = null;
        this.subtitleBridgePort = 8765;
        this.subtitleBridgePeers = [];
        this.subtitleBridgePeersAt = 0;
        this.subtitleBridgeRequest = null;

        this.selectedDeviceId = BdApi.Data.load("Microphone", "deviceId") || "default";
        this.sttUrl = "ws://127.0.0.1:5000";
        this.activeVosk = BdApi.Data.load("Microphone", "activeVosk");
        if (!VOSK_MODELS.some(model => model.id === this.activeVosk)) this.activeVosk = "vosk-model-small-ru-0.22";
        this.selectedCatalogModelId = this.activeVosk;

        this.button = document.createElement("button");
        this.button.type = "button";
        this.button.className = "microphone-voice-button";
        this.button.title = "ЛКМ — открыть панель микрофона | ПКМ — начать/остановить распознавание";
        this.button.setAttribute("aria-label", this.button.title);
        this.button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="9" y="2.5" width="6" height="12" rx="3" fill="#9295ff"/>
            <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5m-4 0h8" stroke="#54d6e5" stroke-width="1.8" stroke-linecap="round"/>
            <circle class="mic-status-dot" cx="19.5" cy="5" r="2.4" fill="#f56a9a" stroke="var(--background-secondary,#1e1f22)" stroke-width="1.2"/>
        </svg>`;

        this.button.addEventListener("click", this.onClick = event => {
            if (event.button === 0) this.togglePanel();
        });
        this.button.addEventListener("mousedown", this.onMouseDown = event => {
            if (event.button !== 2) return;
            event.preventDefault();
            this.toggleRecording();
        });
        this.button.addEventListener("contextmenu", this.onContextMenu = event => {
            event.preventDefault();
        });

        BdApi.DOM.addStyle("Microphone", `
            .microphone-voice-button {
                width: 30px; height: 30px; flex: 0 0 30px; padding: 3px;
                border: 0; border-radius: 8px; background: transparent; color: #b5bac1;
                display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
            }
            .microphone-voice-button:hover { color: #fff; background: var(--background-modifier-hover, #80808022); }
            .microphone-voice-button[data-recording="true"] { background: #36d39922; }
            .microphone-voice-button[data-recording="true"] .mic-status-dot { fill: #36d399; }
            .microphone-voice-button svg { display: block; pointer-events: none; }

            #microphone-panel {
                position: fixed; z-index: 2147483002; left: 50%; bottom: 90px; transform: translateX(-50%);
                display: flex; flex-direction: column; gap: 18px; box-sizing: border-box;
                width: min(460px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow-y: auto; padding: 22px;
                color: #b7c1d6; background: #10131e; border: 1px solid #30394e; border-radius: 20px;
                box-shadow: 0 24px 80px #0009; font: 14px/1.5 "Segoe UI", system-ui, sans-serif; color-scheme: dark;
            }
            #microphone-panel[data-dragging="true"] { cursor: grabbing; user-select: none; }
            #microphone-panel[hidden] { display: none !important; }
            #microphone-panel, #microphone-panel * { box-sizing: border-box; }

            .mic-panel-head { display: flex; align-items: center; gap: 12px; padding-bottom: 16px; border-bottom: 1px solid #252d40; cursor: grab; touch-action: none; }
            .mic-panel-title { font-size: 21px; font-weight: 650; letter-spacing: -.5px; color: #f3f4ff; }
            .mic-badge { padding: 3px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; background: #1b2232; border: 1px solid #394966; color: #9bb8df; }
            .mic-badge[data-active="true"] { background: #12312a; border-color: #36d399; color: #36d399; }
            .mic-service-status { display: grid; gap: 9px; padding: 12px; border: 1px solid #252d40; border-radius: 12px; background: #151a28; }
            .mic-service-badge { padding: 3px 9px; border: 1px solid #394966; border-radius: 999px; background: #1b2232; color: #aeb7c8; font-size: 11px; font-weight: 600; }
            .mic-service-badge[data-state="active"] { border-color: #36d399; background: #12312a; color: #36d399; }
            .mic-service-badge[data-state="inactive"] { border-color: #d83c4c; background: #351b24; color: #ff6b7a; }
            .mic-service-badge[data-state="unknown"] { border-color: #92743b; background: #302818; color: #e8bf69; }
            .mic-section { display: flex; flex-direction: column; gap: 6px; }
            .mic-label { font-size: 12px; color: #a7b4cb; font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
            .mic-select, .mic-input { width: 100%; font: inherit; color: #f3f4ff; background: #1b2232; border: 1px solid #394966; border-radius: 10px; padding: 8px 10px; outline: none; }
            .mic-meter-bg { width: 100%; height: 8px; background: #20283a; border: 0; border-radius: 999px; overflow: hidden; }
            .mic-meter-fill { height: 100%; width: 0%; border-radius: 999px; background: linear-gradient(90deg, #5865f2, #54d6e5, #36d399); transition: width 0.06s ease-out; }

            .mic-catalog-btn { flex: 1; padding: 7px 10px; border-radius: 9px; font-size: 13px; font-weight: 600; color: #d5d9e4; background: #1b2232; border: 1px solid #394966; cursor: pointer; }
            .mic-catalog-btn:hover { filter: brightness(1.15); border-color: #54d6e5; }
            .mic-catalog-list { display: flex; flex-direction: column; max-height: 160px; overflow-y: auto; padding: 5px; background: #0d101b; border: 1px solid #26314a; border-radius: 11px; }
            .mic-model-table-header, .mic-model-row { display: grid; grid-template-columns: 22px minmax(0, 1fr) 105px 58px 105px; align-items: center; gap: 7px; padding: 7px 8px; }
            .mic-model-table-header { position: sticky; top: 0; z-index: 1; color: #82a5ca; background: #131826; font-size: 11px; font-weight: 700; }
            .mic-model-row { border: 1px solid transparent; border-radius: 7px; cursor: pointer; }
            .mic-model-row[data-selected="true"] { border-color: #5865f2; background: #1e2540; }
            .mic-model-info { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
            .mic-model-name { font-size: 13px; font-weight: 600; color: #f3f4ff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .mic-model-compact-meta { display: none; color: #92a4c0; font-size: 10px; }
            .mic-model-meta { font-size: 11px; color: #82a5ca; }
            .mic-model-select { width: 24px; height: 24px; accent-color: #5865f2; }
            .mic-model-cell { color: #d5d9e4; font-size: 11px; white-space: nowrap; }
            .mic-installation-cell[data-installed="true"] { color: #36d399; }
            .mic-installation-cell[data-installed="false"] { color: #9299a8; }
            .mic-catalog-actions { display: flex; gap: 8px; }
            .mic-catalog-actions .mic-catalog-btn { text-align: center; text-decoration: none; }
            .mic-open-catalog { width: 100%; padding: 8px 10px; border-radius: 9px; font-size: 13px; font-weight: 600; color: #d5d9e4; background: #1b2232; border: 1px solid #394966; cursor: pointer; }
            .mic-open-catalog:hover { border-color: #54d6e5; }
            #microphone-model-modal, #microphone-engine-directory-modal { position: fixed; inset: 0; z-index: 2147483004; display: grid; place-items: center; padding: 20px; background: #05070dcc; }
            #microphone-model-modal[hidden], #microphone-engine-directory-modal[hidden] { display: none; }
            .mic-model-dialog { width: min(760px, calc(100vw - 32px)); max-height: calc(100vh - 40px); overflow-y: auto; padding: 24px; display: flex; flex-direction: column; gap: 16px; color: #b7c1d6; background: #10131e; border: 1px solid #30394e; border-radius: 20px; box-shadow: 0 24px 80px #000a; font: 14px/1.5 "Segoe UI", system-ui, sans-serif; color-scheme: dark; }
            .mic-model-dialog-head { display: flex; justify-content: space-between; align-items: center; color: #f3f4ff; font-weight: 700; font-size: 15px; }
            .mic-model-close { width: 30px; height: 30px; border: 0; border-radius: 8px; color: #d5d9e4; background: #1b2232; font-size: 19px; cursor: pointer; }
            .mic-model-dialog .mic-catalog-list { max-height: min(320px, 45vh); padding: 8px; }
            .mic-model-dialog .mic-model-table-header, .mic-model-dialog .mic-model-row { grid-template-columns: 30px minmax(0, 1fr) 100px 65px 105px; gap: 8px; padding: 10px 12px; }
            .mic-model-dialog .mic-model-table-header { font-size: 13px; }
            .mic-model-dialog .mic-model-name { font-size: 14px; }
            .mic-model-dialog .mic-model-cell { font-size: 13px; }
            .mic-model-dialog .mic-model-select { width: 24px; height: 24px; }
            .mic-model-dialog .mic-catalog-actions .mic-catalog-btn { padding: 9px 12px; }
            .mic-download-progress { display: flex; flex-direction: column; gap: 6px; }
            .mic-download-progress[hidden] { display: none; }
            .mic-download-progress-label { color: #9bb8df; font-size: 12px; }
            .mic-download-progress-track { height: 14px; overflow: hidden; padding: 2px; border: 1px solid #30384a; border-radius: 999px; background: #1b1f2d; }
            .mic-download-progress-fill { height: 100%; width: 0; border-radius: 999px; background: repeating-linear-gradient(90deg, #8294ff 0 20px, #1b1f2d 20px 23px); transition: width 0.15s ease-out; }
            .mic-download-progress-track[data-indeterminate="true"] .mic-download-progress-fill { width: 32%; animation: mic-download-progress 1.2s ease-in-out infinite alternate; }
            @keyframes mic-download-progress { from { transform: translateX(-25%); } to { transform: translateX(220%); } }
            .mic-catalog-search { width: 100%; }
            .mic-catalog-shortcuts { display: flex; gap: 8px; }
            .mic-engine-list { display: flex; flex-direction: column; gap: 8px; max-height: min(440px, 55vh); overflow-y: auto; padding: 2px; }
            .mic-engine-card { display: flex; align-items: center; gap: 12px; padding: 11px 12px; background: #131826; border: 1px solid #26314a; border-radius: 10px; }
            .mic-engine-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
            .mic-engine-name { color: #f3f4ff; font-size: 14px; font-weight: 650; }
            .mic-engine-status { color: #54d6e5; font-size: 12px; font-weight: 600; }
            .mic-engine-details { color: #9aaaca; font-size: 12px; }
            .mic-engine-actions { flex: 0 0 auto; display: flex; gap: 6px; }
            .mic-engine-link { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; padding: 6px 9px; border: 1px solid #394966; border-radius: 8px; color: #d5d9e4; background: #1b2232; font: inherit; font-size: 12px; text-decoration: none; cursor: pointer; }
            .mic-engine-link:hover { border-color: #54d6e5; }
            .mic-catalog-back { padding: 5px 9px; border: 1px solid #394966; border-radius: 8px; color: #d5d9e4; background: #1b2232; font: inherit; font-size: 12px; cursor: pointer; }
            .mic-catalog-back[hidden] { display: none; }

            .mic-preview-box { display: flex; align-items: flex-start; gap: 10px; min-height: 88px; max-height: 180px; overflow-y: auto; padding: 14px; background: #151a28; border: 1px solid #2b354b; border-radius: 12px; color: #e6ecf8; font-size: 14px; }
            .mic-preview-text { flex: 1; white-space: pre-wrap; word-break: break-word; }

            .mic-peers-box { padding: 8px 10px; background: #131826; border: 1px solid #2b3954; border-radius: 10px; font-size: 12px; color: #9bb8df; display: flex; justify-content: space-between; align-items: center; }
            .mic-btn { width: 100%; padding: 9px 14px; border-radius: 10px; font: inherit; font-weight: 650; border: 1px solid #394966; background: #1b2232; color: #d5d9e4; cursor: pointer; }
            .mic-btn-primary { padding: 12px 16px; background: #6470ee; border-color: #8590ff; color: #fff; box-shadow: 0 4px 18px #5865f225; }
            .mic-btn-primary[data-recording="true"] { background: #d83c4c; border-color: #ff6b7a; }
            .mic-heading { flex: 1; min-width: 0; }
            .mic-eyebrow { font-size: 10px; font-weight: 700; letter-spacing: 1.8px; color: #88d5e5; }
            .mic-heading-icon { display: grid; place-items: center; width: 42px; height: 42px; flex: 0 0 42px; border: 1px solid #39496b; border-radius: 13px; background: #232c47; color: #a3adff; }
            .mic-service-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 12px; color: #9eacc4; }
            .mic-service-row .mic-service-badge { text-align: right; font-size: 10px; }
            .mic-label-line { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
            .mic-section { gap: 8px; }
            .mic-caption { font-size: 11px; color: #8391aa; }
            .mic-footer { display: flex; justify-content: space-between; gap: 12px; font-size: 10px; color: #8290aa; }
            .mic-select:focus-visible, .mic-input:focus-visible { border-color: #8ba5ff; box-shadow: 0 0 0 3px #8490ff20; }
            #microphone-panel :focus-visible, .mic-model-dialog :focus-visible, .microphone-voice-button:focus-visible { outline: 2px solid #96b9ff; outline-offset: 3px; }
            #microphone-panel button, .mic-model-dialog button, .mic-model-dialog a { transition: background .15s, border-color .15s; }
            #microphone-panel button:hover, .mic-model-dialog button:hover { filter: brightness(1.12); }
            #microphone-panel button:disabled, .mic-model-dialog button:disabled { opacity: .5; cursor: not-allowed; }
            #microphone-panel, .mic-model-dialog, .mic-catalog-list, .mic-engine-list { scrollbar-width: thin; scrollbar-color: #3c4966 transparent; }
            .mic-model-dialog, .mic-model-dialog * { box-sizing: border-box; }
            .mic-model-row:hover { background: #1a2336; }
            .mic-model-row:focus-within { outline: 1px solid #96b9ff; outline-offset: -1px; }
            @media (max-width: 560px) {
                #microphone-panel { padding: 16px; gap: 14px; }
                .mic-model-dialog { padding: 16px; }
                .mic-model-dialog .mic-model-table-header, .mic-model-dialog .mic-model-row { grid-template-columns: 26px minmax(0, 1fr) 80px; gap: 6px; padding: 8px 4px; }
                .mic-model-table-header > :nth-child(3), .mic-model-table-header > :nth-child(4), .mic-model-row > :nth-child(3), .mic-model-row > :nth-child(4) { display: none; }
                .mic-model-compact-meta { display: block; }
                .mic-engine-card { align-items: flex-start; flex-direction: column; }
                .mic-model-dialog-head { flex-wrap: wrap; gap: 8px; }
            }
            @media (prefers-reduced-motion: reduce) { #microphone-panel *, .mic-model-dialog * { transition: none !important; animation: none !important; } }
        `);

        this.createPanel();
        this.onViewportResize = () => { if (!this.panel.hidden) this.keepInViewport(); };
        window.addEventListener("resize", this.onViewportResize);
        this.checkServerStatus();
        this.refreshAutostartStatus();
        this.serverStatusTimer = setInterval(() => {
            this.checkServerStatus();
            this.refreshAutostartStatus();
        }, 10000);
        this.placeButton();
        this.observer = new MutationObserver(() => this.schedulePlacement());
        this.observer.observe(document.body, {childList: true, subtree: true});
        this.timer = setInterval(() => this.placeButton(), 3000);
    }

    createPanel() {
        this.panel = document.createElement("section");
        this.panel.id = "microphone-panel";
        this.panel.setAttribute("aria-label", "Микрофон");
        this.panel.hidden = true;

        this.panel.addEventListener("pointerdown", e => this.beginDrag(e));
        this.panel.addEventListener("pointermove", e => this.moveDrag(e));
        this.panel.addEventListener("pointerup", e => this.endDrag(e));
        this.panel.addEventListener("pointercancel", e => this.endDrag(e));

        this.panel.innerHTML = `
            <div class="mic-panel-head">
                <div class="mic-heading-icon" aria-hidden="true">${this.button.innerHTML}</div>
                <div class="mic-heading"><div class="mic-eyebrow">VOICE STUDIO</div><div class="mic-panel-title">Микрофон</div></div>
                <button type="button" class="mic-model-close" id="mic-panel-close" aria-label="Закрыть панель микрофона">×</button>
            </div>
            <div class="mic-service-status">
                <div class="mic-service-row"><span>Voice Studio</span><span class="mic-service-badge" id="mic-server-badge" data-state="unknown">● Проверка…</span></div>
                <div class="mic-service-row"><span>Автозагрузка</span><span class="mic-service-badge" id="mic-autostart-badge" data-state="unknown">● Проверка…</span></div>
            </div>

            <div class="mic-section">
                <label class="mic-label" for="mic-device-select">Устройство ввода</label>
                <select class="mic-select" id="mic-device-select">
                    <option value="default">Микрофон по умолчанию</option>
                </select>
            </div>

            <div class="mic-section">
                <div class="mic-label">
                    <span>Уровень сигнала</span>
                    <span id="mic-volume-percent">0%</span>
                </div>
                <div class="mic-meter-bg">
                    <div class="mic-meter-fill" id="mic-meter-fill"></div>
                </div>
            </div>

            <div class="mic-catalog-shortcuts">
                <button type="button" class="mic-open-catalog" id="mic-open-engine-directory-btn">Модели распознавания · ${SPEECH_ENGINES.length} движков ↗</button>
            </div>

            <div class="mic-section">
                <div class="mic-label-line"><span class="mic-label">Распознанная речь</span><span class="mic-badge" id="mic-status-badge" data-active="false">● Ожидание</span></div>
                <div class="mic-preview-box">
                    <span class="mic-preview-text" id="mic-live-text" role="status" aria-live="polite">Здесь появится ваша речь. Включите микрофон, чтобы начать.</span>
                </div>
                <div class="mic-caption" id="mic-stt-state">Распознавание на этом устройстве</div>
            </div>

            <div class="mic-section">
                <label class="mic-label" for="mic-manual-input">Проверка субтитров <span class="mic-caption">Enter ↵</span></label>
                <input type="text" class="mic-input" id="mic-manual-input" placeholder="Введите короткую фразу…" maxlength="10000" />
            </div>

            <button type="button" class="mic-btn mic-btn-primary" id="mic-toggle-btn" data-recording="false">
                Начать распознавание
            </button>
            <button type="button" class="mic-btn" id="mic-network-btn">Мой адрес и адреса друзей</button>
            <div class="mic-footer"><span>Локальное распознавание</span><span>Microphone · 2.9.0</span></div>
        `;

        const savedPos = BdApi.Data.load("Microphone", "panelPosition");
        if (savedPos && Number.isFinite(savedPos.left) && Number.isFinite(savedPos.top)) {
            this.panel.style.left = `${savedPos.left}px`;
            this.panel.style.top = `${savedPos.top}px`;
            this.panel.style.transform = "none";
            this.panel.style.bottom = "auto";
        }

        document.body.append(this.panel);
        this.createModelModal();
        this.createEngineDirectoryModal();

        this.deviceSelect = this.panel.querySelector("#mic-device-select");
        this.meterFill = this.panel.querySelector("#mic-meter-fill");
        this.volumePercent = this.panel.querySelector("#mic-volume-percent");
        this.liveText = this.panel.querySelector("#mic-live-text");
        this.sttState = this.panel.querySelector("#mic-stt-state");
        this.statusBadge = this.panel.querySelector("#mic-status-badge");
        this.serverBadge = this.panel.querySelector("#mic-server-badge");
        this.autostartBadge = this.panel.querySelector("#mic-autostart-badge");
        this.toggleBtn = this.panel.querySelector("#mic-toggle-btn");
        this.manualInput = this.panel.querySelector("#mic-manual-input");
        this.panel.querySelector("#mic-panel-close").onclick = () => { this.panel.hidden = true; };

        this.manualInput.addEventListener("keydown", e => {
            if (e.key === "Enter" && this.manualInput.value.trim()) {
                this.publishSubtitle(this.manualInput.value.trim());
                this.manualInput.value = "";
            }
        });

        this.panel.querySelector("#mic-open-engine-directory-btn").onclick = () => this.toggleEngineDirectory(true);

        this.deviceSelect.onchange = () => {
            this.selectedDeviceId = this.deviceSelect.value;
            BdApi.Data.save("Microphone", "deviceId", this.selectedDeviceId);
            if (this.isRecording) { this.stopRecording(); this.startRecording(); }
        };

        this.toggleBtn.onclick = () => this.toggleRecording();
        this.panel.querySelector("#mic-network-btn").onclick = () => this.shared.showNetwork(__dirname);
        this.renderCatalog();
    }

    async refreshAutostartStatus() {
        if (!this.autostartBadge || this.autostartStatusPending) return;
        this.autostartStatusPending = true;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6500);
        try {
            const response = await fetch("http://127.0.0.1:8765/status", {signal: controller.signal});
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            const startup = data.services?.startup;
            if (!startup) throw new Error("Обновите сервер Voice Studio");
            if (!this.autostartBadge?.isConnected) return;
            this.autostartBadge.dataset.state = startup.state;
            this.autostartBadge.textContent = startup.state === "active" ? "✓ Включена · Voice Studio"
                : `● ${startup.text || "Проверка недоступна"}`;
        } catch (error) {
            if (this.autostartBadge?.isConnected) {
                this.autostartBadge.dataset.state = "unknown";
                this.autostartBadge.textContent = "● Запустите Voice Studio";
            }
        } finally {
            clearTimeout(timeout);
            this.autostartStatusPending = false;
        }
    }

    checkServerStatus() {
        if (!this.serverBadge || this.serverStatusSocket) return;
        const socket = new WebSocket(this.sttUrl);
        this.serverStatusSocket = socket;
        let receivedReady = false;
        socket.onmessage = event => {
            if (this.serverStatusSocket !== socket) return;
            try {
                const message = JSON.parse(event.data);
                if (message.type !== "ready") return;
                receivedReady = true;
                this.serverBadge.dataset.state = "active";
                this.serverBadge.textContent = "✓ STT-сервер: запущен";
                void this.registerSubtitlePeer();
                this.serverStatusSocket = null;
                socket.close();
            } catch (error) {
                console.error("[Microphone] Не удалось проверить ответ STT-сервера:", error);
                this.serverBadge.dataset.state = "inactive";
                this.serverBadge.textContent = "● STT-сервер: не запущен";
                this.serverStatusSocket = null;
                socket.close();
            }
        };
        socket.onerror = () => {
            if (this.serverStatusSocket !== socket) return;
            this.serverBadge.dataset.state = "inactive";
            this.serverBadge.textContent = "● STT-сервер: не запущен";
            this.serverStatusSocket = null;
            socket.close();
        };
        socket.onclose = () => {
            if (this.serverStatusSocket !== socket) return;
            this.serverStatusSocket = null;
            if (!receivedReady) {
                this.serverBadge.dataset.state = "inactive";
                this.serverBadge.textContent = "● STT-сервер: не запущен";
            }
        };
    }

    async registerSubtitlePeer(userId) {
        const userStore = BdApi.Webpack.getStore("UserStore");
        const currentUser = userStore?.getCurrentUser?.();
        const id = userId || currentUser?.id;
        if (typeof id !== "string" || !/^\d{1,24}$/.test(id)) return false;
        try {
            const response = await fetch(`http://127.0.0.1:${this.subtitleBridgePort || 8765}/register`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userId: id })
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return true;
        } catch (error) {
            console.warn("[Microphone] Не удалось зарегистрировать участника субтитров:", error.message);
            return false;
        }
    }

    getSettingsPanel() {
        return this.shared.panel(__dirname);
    }

    createModelModal() {
        this.modelModal = document.createElement("div");
        this.modelModal.id = "microphone-model-modal";
        this.modelModal.hidden = true;
        this.modelModal.innerHTML = `
            <section class="mic-model-dialog" role="dialog" aria-modal="true" aria-labelledby="mic-model-dialog-title">
                <div class="mic-model-dialog-head">
                    <span id="mic-model-dialog-title">Каталог моделей</span>
                    <button type="button" class="mic-catalog-back" id="mic-model-back-engines">Все движки</button>
                    <button type="button" class="mic-model-close" aria-label="Закрыть">×</button>
                </div>
                <div class="mic-model-meta">19 скачиваемых русских вариантов на шести движках и семи каталогах. Большие модели требуют времени, памяти и места на диске.</div>
                <input class="mic-input mic-catalog-search" id="mic-model-search" type="search" placeholder="Найти модель или язык..." aria-label="Поиск модели по имени или языку" />
                <div class="mic-catalog-list" id="mic-model-catalog-list"></div>
                <div class="mic-model-meta" id="mic-model-download-state">Выбранная модель будет загружена из её репозитория.</div>
                <div class="mic-download-progress" id="mic-download-progress" hidden>
                    <span class="mic-download-progress-label" id="mic-download-progress-label" aria-live="polite"></span>
                    <div class="mic-download-progress-track" id="mic-download-progress-track" role="progressbar" aria-label="Загрузка модели" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
                        <div class="mic-download-progress-fill" id="mic-download-progress-fill"></div>
                    </div>
                </div>
                <div class="mic-catalog-actions">
                    <button type="button" class="mic-catalog-btn" id="mic-install-model-btn">Скачать выбранную</button>
                    <a class="mic-catalog-btn" id="mic-model-source" target="_blank" rel="noopener noreferrer">Открыть ссылку</a>
                </div>
                <div class="mic-model-meta">Первое скачивание Whisper занимает время; большие варианты требуют несколько ГБ диска и памяти. Ссылка ведёт на точный репозиторий.</div>
            </section>
        `;
        document.body.append(this.modelModal);
        this.catalogList = this.modelModal.querySelector("#mic-model-catalog-list");
        this.catalogSearch = this.modelModal.querySelector("#mic-model-search");
        this.catalogSearch.oninput = () => this.renderCatalog();
        this.modelDownloadState = this.modelModal.querySelector("#mic-model-download-state");
        this.modelSource = this.modelModal.querySelector("#mic-model-source");
        this.modelInstallButton = this.modelModal.querySelector("#mic-install-model-btn");
        this.modelProgressElement = this.modelModal.querySelector("#mic-download-progress");
        this.modelProgressLabel = this.modelModal.querySelector("#mic-download-progress-label");
        this.modelProgressTrack = this.modelModal.querySelector("#mic-download-progress-track");
        this.modelProgressFill = this.modelModal.querySelector("#mic-download-progress-fill");
        this.modelInstallButton.onclick = () => this.installSelectedModel();
        this.modelModal.querySelector("#mic-model-back-engines").onclick = () => {
            this.toggleModelCatalog(false);
            this.toggleEngineDirectory(true);
        };
        this.modelModal.querySelector(".mic-model-close").onclick = () => this.toggleModelCatalog(false);
        this.modelModal.addEventListener("click", event => {
            if (event.target === this.modelModal) this.toggleModelCatalog(false);
        });
        this.onCatalogKeyDown = event => {
            const modal = !this.modelModal.hidden ? this.modelModal : !this.engineDirectoryModal.hidden ? this.engineDirectoryModal : null;
            if (modal && event.key === "Tab") {
                const controls = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), a[href]')].filter(node => node.getClientRects().length);
                const first = controls[0], last = controls[controls.length - 1];
                if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
            }
            if (event.key === "Escape") {
                if (modal) { event.preventDefault(); event.stopImmediatePropagation(); }
                if (!this.modelModal.hidden) this.toggleModelCatalog(false);
                else if (!this.engineDirectoryModal.hidden) this.toggleEngineDirectory(false);
                else this.panel.hidden = true;
            }
        };
        window.addEventListener("keydown", this.onCatalogKeyDown, true);
    }

    createEngineDirectoryModal() {
        this.engineDirectoryModal = document.createElement("div");
        this.engineDirectoryModal.id = "microphone-engine-directory-modal";
        this.engineDirectoryModal.hidden = true;
        this.engineDirectoryModal.innerHTML = `
            <section class="mic-model-dialog" role="dialog" aria-modal="true" aria-labelledby="mic-engine-directory-title">
                <div class="mic-model-dialog-head">
                    <span id="mic-engine-directory-title">Каталоги движков распознавания</span>
                    <button type="button" class="mic-model-close" aria-label="Закрыть">×</button>
                </div>
                <div class="mic-model-meta">Выбери движок, затем конкретную модель: её можно скачать и установить, если она поддерживается этим плагином.</div>
                <input class="mic-input mic-catalog-search" id="mic-engine-directory-search" type="search" placeholder="Найти движок..." aria-label="Поиск движка">
                <div class="mic-engine-list" id="mic-engine-directory-list"></div>
            </section>
        `;
        document.body.append(this.engineDirectoryModal);
        this.engineDirectoryList = this.engineDirectoryModal.querySelector("#mic-engine-directory-list");
        this.engineDirectorySearch = this.engineDirectoryModal.querySelector("#mic-engine-directory-search");
        this.engineDirectorySearch.oninput = () => this.renderEngineDirectory();
        this.engineDirectoryModal.querySelector(".mic-model-close").onclick = () => this.toggleEngineDirectory(false);
        this.engineDirectoryModal.addEventListener("click", event => {
            if (event.target === this.engineDirectoryModal) this.toggleEngineDirectory(false);
        });
        this.renderEngineDirectory();
    }

    renderEngineDirectory() {
        if (!this.engineDirectoryList) return;
        this.engineDirectoryList.replaceChildren();
        const query = this.engineDirectorySearch?.value.trim().toLocaleLowerCase() || "";
        const engines = SPEECH_ENGINES.filter(engine =>
            `${engine.name} ${engine.status} ${engine.details}`.toLocaleLowerCase().includes(query)
        );
        for (const engine of engines) {
            const card = document.createElement("article");
            card.className = "mic-engine-card";
            const info = document.createElement("div");
            info.className = "mic-engine-info";
            const name = document.createElement("span");
            name.className = "mic-engine-name";
            name.textContent = engine.name;
            const status = document.createElement("span");
            status.className = "mic-engine-status";
            status.textContent = engine.status;
            const details = document.createElement("span");
            details.className = "mic-engine-details";
            details.textContent = engine.details;
            info.append(name, status, details);
            const actions = document.createElement("div");
            actions.className = "mic-engine-actions";
            const modelCount = engine.backend
                ? VOSK_MODELS.filter(model => model.engine === engine.backend).length
                : 0;
            const openCatalog = document.createElement("button");
            openCatalog.type = "button";
            openCatalog.className = "mic-engine-link";
            openCatalog.textContent = modelCount ? `Модели · ${modelCount}` : "Каталог моделей";
            openCatalog.onclick = () => this.openEngineModels(engine);
            actions.append(openCatalog);
            const link = document.createElement("a");
            link.className = "mic-engine-link";
            link.href = engine.url;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = "Сайт ↗";
            actions.append(link);
            card.append(info, actions);
            this.engineDirectoryList.append(card);
        }
        if (engines.length === 0) {
            const empty = document.createElement("div");
            empty.className = "mic-model-meta";
            empty.textContent = "По запросу ничего не найдено.";
            this.engineDirectoryList.append(empty);
        }
    }

    openEngineModels(engine) {
        this.catalogEngineFilter = engine;
        this.catalogSearch.value = "";
        this.toggleEngineDirectory(false);
        this.toggleModelCatalog(true);
    }

    toggleEngineDirectory(show) {
        if (!this.engineDirectoryModal) return;
        if (show) this.engineDirectoryModal.returnFocus = document.activeElement;
        this.engineDirectoryModal.hidden = !show;
        if (show) { this.renderEngineDirectory(); this.engineDirectorySearch.focus(); }
        else this.restoreDialogFocus(this.engineDirectoryModal);
    }

    toggleModelCatalog(show) {
        if (!this.modelModal) return;
        if (show) this.modelModal.returnFocus = document.activeElement;
        this.modelModal.hidden = !show;
        if (show) {
            this.renderCatalog();
            this.refreshInstalledModels();
            this.catalogSearch.focus();
        } else this.restoreDialogFocus(this.modelModal);
    }

    restoreDialogFocus(modal) {
        const opener = modal.returnFocus;
        if (opener?.isConnected && opener.getClientRects().length) opener.focus();
        else this.panel?.querySelector("#mic-open-engine-directory-btn")?.focus();
    }

    setModelInstallStatus(status, message, progress) {
        if (arguments.length >= 3) this.modelProgress = progress;
        if (this.sttState) this.sttState.textContent = status;
        if (this.liveText) this.liveText.textContent = message;
        if (this.modelDownloadState) this.modelDownloadState.textContent = status;
        if (this.modelProgressElement) {
            const currentProgress = this.modelProgress;
            this.modelProgressElement.hidden = !currentProgress;
            if (currentProgress) {
                const isDeterminate = Number.isFinite(currentProgress.percent);
                const percent = isDeterminate ? Math.max(0, Math.min(100, currentProgress.percent)) : 0;
                this.modelProgressLabel.textContent = currentProgress.label || message || status;
                this.modelProgressTrack.dataset.indeterminate = String(!isDeterminate);
                if (isDeterminate) {
                    this.modelProgressTrack.setAttribute("aria-valuenow", String(percent));
                } else {
                    this.modelProgressTrack.removeAttribute("aria-valuenow");
                }
                this.modelProgressTrack.setAttribute("aria-valuetext", this.modelProgressLabel.textContent);
                this.modelProgressFill.style.width = isDeterminate ? `${percent}%` : "";
            }
        }
        if (this.modelInstallButton) {
            this.modelInstallButton.disabled = this.isInstallingModel;
            this.modelInstallButton.textContent = this.isInstallingModel ? "Загрузка..." : "Скачать выбранную";
        }
    }

    formatDownloadSize(bytes) {
        const megabytes = bytes / (1024 * 1024);
        return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} МБ`;
    }

    handleDownloadProgress(progress) {
        const modelName = this.selectedModelName();
        const hasBytes = Number.isFinite(progress.downloaded)
            && Number.isFinite(progress.total)
            && progress.total > 0;
        const percent = Number.isFinite(progress.percent) ? progress.percent : null;
        let label;
        if (progress.phase === "load") {
            label = "Файл скачан, загружаю модель в память...";
        } else if (progress.phase === "extract") {
            label = "Распаковка модели...";
        } else if (hasBytes) {
            label = `${modelName}: ${percent ?? 0}% (${this.formatDownloadSize(progress.downloaded)} / ${this.formatDownloadSize(progress.total)})`;
        } else {
            label = "Загружаю файлы модели...";
        }
        this.setModelInstallStatus(`Загрузка: ${modelName}`, label, { percent, label });
    }

    publishSubtitle(text) {
        if (!text) return;
        this.lastRecognizedText = text;
        if (this.liveText) this.liveText.textContent = text;

        const userStore = BdApi.Webpack.getStore("UserStore");
        const currentUser = userStore?.getCurrentUser?.();
        const payload = {
            userId: currentUser?.id || "self",
            userName: currentUser?.globalName || currentUser?.username || "Участник",
            text
        };

        window.dispatchEvent(new CustomEvent("bd-subtitle-received", { detail: payload }));
        // A speaker may only have Microphone enabled. In that case there is no
        // Subtitles listener to forward the event, so bridge it directly.
        if (!window.__bdSubtitlesActive) void this.bridgeSubtitleToPeers(payload);
    }

    async bridgeSubtitleToPeers(payload) {
        // Keep final phrases in order even while a peer is slow to respond.
        const previous = this.subtitleBridgeRequest || Promise.resolve();
        const operation = previous.catch(() => {}).then(async () => {
            await this.registerSubtitlePeer(payload.userId);
            const channelId = BdApi.Webpack.getStore("SelectedChannelStore")?.getVoiceChannelId?.();
            if (!channelId) return;
            const states = BdApi.Webpack.getStore("VoiceStateStore")?.getVoiceStatesForChannel?.(channelId);
            const voiceStates = states instanceof Map ? [...states.values()] : Object.values(states || {});
            const ids = voiceStates.map(state => state.userId || state.user_id).filter(Boolean);
            await this.shared.network(__dirname).send(payload, ids);
        }).catch(error => console.warn("[Microphone] Связь с друзьями:", error.message));
        this.subtitleBridgeRequest = operation;
        try { await operation; }
        finally { if(this.subtitleBridgeRequest === operation) this.subtitleBridgeRequest = null; }
    }

    async startRecording() {
        try {
            this.lastRecognizedText = "";
            this.serverLaunchAttempted = false;
            const constraints = {
                audio: this.selectedDeviceId && this.selectedDeviceId !== "default"
                    ? {deviceId: {exact: this.selectedDeviceId}}
                    : true
            };
            this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
            this.audioContext = new AudioContext({ sampleRate: 16000 });
            const source = this.audioContext.createMediaStreamSource(this.mediaStream);
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 256;
            source.connect(this.analyser);

            this.isRecording = true;
            this.updateUIState();
            this.animateMeter();
            this.connectSpeechEngine(source);
        } catch (err) {
            console.error("[Microphone] Не удалось запустить микрофон или аудиоконтекст:", err);
            this.stopRecording();
            if (this.liveText) this.liveText.textContent = "Не удалось запустить микрофон. Проверь разрешение и устройство.";
            if (this.sttState) this.sttState.textContent = "Ошибка запуска";
        }
    }

    connectSpeechEngine(source, attempt = 0) {
        if (!this.isRecording) return;
        const socket = new WebSocket(this.sttUrl);
        this.sttSocket = socket;
        if (this.sttState) this.sttState.textContent = attempt === 0
            ? "Подключение к локальному распознавателю..."
            : "Запускаю распознаватель автоматически...";
        if (this.liveText) this.liveText.textContent = attempt === 0
            ? "Проверяю локальный сервер..."
            : "Загружается локальный сервер. Подожди...";

        socket.onopen = () => {
            if (this.sttSocket !== socket || !this.isRecording) return;
            this.sttState.textContent = "Подключено, загружаю модель...";
            socket._audioSource = source;
        };

        socket.onmessage = event => {
            if (this.sttSocket !== socket) return;
            try {
                const result = JSON.parse(event.data);
                if (result.type === "ready") {
                    if (result.catalog_version !== VOSK_CATALOG_VERSION) {
                        this.sttState.textContent = "Нужно перезапустить сервер распознавания";
                        this.liveText.textContent = "Останови старый pythonw.exe со stt_server.py в Диспетчере задач, затем запусти распознавание снова.";
                        this.stopRecording();
                        return;
                    }
                    if (result.model_id !== this.activeVosk) {
                        this.isInstallingModel = true;
                        this.setModelInstallStatus("Подготовка выбранной модели...", `Загружаю модель ${this.selectedModelName()}.`, {
                            percent: null,
                            label: `Подготовка модели ${this.selectedModelName()}...`
                        });
                        socket.send(JSON.stringify({ type: "install_model", id: this.activeVosk }));
                    } else {
                        this.startAudioForwarding(socket, socket._audioSource);
                    }
                    return;
                }
                if (result.type === "download_progress") {
                    if (this.processor) this.processor.onaudioprocess = null;
                    this.handleDownloadProgress(result);
                    return;
                }
                if (result.type === "model_loaded") {
                    this.activeVosk = result.id;
                    this.selectedCatalogModelId = result.id;
                    if (!this.installedCatalogModels) this.installedCatalogModels = new Set();
                    this.installedCatalogModels.add(result.id);
                    this.isInstallingModel = false;
                    BdApi.Data.save("Microphone", "activeVosk", this.activeVosk);
                    this.renderCatalog();
                    this.setModelInstallStatus(`Модель загружена: ${result.name || "распознавания речи"}`, "Модель готова, запускаю распознавание.", null);
                    this.startAudioForwarding(socket, socket._audioSource);
                    return;
                }
                if (result.type === "error") {
                    this.isInstallingModel = false;
                    this.renderCatalog();
                    this.setModelInstallStatus("Ошибка загрузки модели", result.message || "Не удалось загрузить эту модель распознавания речи.", null);
                    if (this.processor && this.sttSocket === socket) this.startAudioForwarding(socket, socket._audioSource);
                    return;
                }
                const text = typeof result.text === "string" ? result.text.trim() : "";
                if (!text) return;
                if (result.final) this.publishSubtitle(text);
                else {
                    this.lastRecognizedText = text;
                    this.liveText.textContent = text;
                }
            } catch (err) {
                console.error("[Microphone] Ответ локального сервера распознавания не является корректным JSON:", err);
                this.sttState.textContent = "Ошибка ответа сервера";
            }
        };

        socket.onerror = () => {
            if (this.sttSocket !== socket) return;
            this.sttSocket = null;
            socket.close();
            if (!this.serverLaunchAttempted) {
                this.serverLaunchAttempted = true;
                try {
                    this.launchLocalServer();
                } catch (err) {
                    console.error("[Microphone] Не удалось автоматически запустить stt_server.bat:", err);
                    this.sttState.textContent = "Не удалось запустить сервер распознавания";
                    this.liveText.textContent = "Проверь, что stt_server.bat и stt_server.py находятся в папке плагинов.";
                    this.stopRecording();
                    return;
                }
            }

            if (attempt >= 120) {
                this.sttState.textContent = "Сервер распознавания не запустился";
                this.liveText.textContent = "Не удалось подключиться. Проверь Python, выбранную модель и порт 5000.";
                this.stopRecording();
                return;
            }

            this.autoConnectTimer = setTimeout(() => {
                this.autoConnectTimer = null;
                this.connectSpeechEngine(source, attempt + 1);
            }, 1000);
        };

        socket.onclose = () => {
            if (this.sttSocket !== socket) return;
            this.sttSocket = null;
            if (this.isRecording) {
                this.stopRecording();
                this.sttState.textContent = "Соединение с распознавателем закрыто";
                this.liveText.textContent = "Распознавание остановлено: локальный сервер отключился.";
            }
        };
    }

    launchLocalServer() {
        const path = require("path");
        const fs = require("fs");
        const { execFile } = require("child_process");
        const batchPath = path.join(__dirname, "stt_server.bat");
        if (!fs.existsSync(batchPath)) throw new Error(`Batch launcher not found: ${batchPath}`);

        const child = execFile(batchPath, [], {
            cwd: __dirname,
            detached: true,
            windowsHide: true,
            stdio: "ignore",
            env: { ...process.env, BD_AUTO_LAUNCH: "1" },
            shell: true
        });
        child.once("error", error => {
            console.error("[Microphone] Ошибка запуска stt_server.bat:", error);
            if (this.isInstallingModel) {
                this.sttState.textContent = "Не удалось запустить сервер";
                this.liveText.textContent = "Windows не смогла запустить stt_server.bat.";
                this.isInstallingModel = false;
            }
            if (this.isRecording) {
                this.sttState.textContent = "Не удалось запустить сервер распознавания";
                this.liveText.textContent = "Windows не смогла запустить stt_server.bat.";
                this.stopRecording();
            }
        });
        child.unref();
        this.serverProcess = child;
    }

    installSelectedModel() {
        if (this.isInstallingModel) return;
        if (this.catalogSocket) {
            const socket = this.catalogSocket;
            this.catalogSocket = null;
            socket.close();
        }
        if (this.catalogConnectTimer) {
            clearTimeout(this.catalogConnectTimer);
            this.catalogConnectTimer = null;
        }
        this.isInstallingModel = true;
        this.serverLaunchAttempted = false;
        const model = VOSK_MODELS.find(item => item.id === this.selectedCatalogModelId);
        if (!model) {
            this.isInstallingModel = false;
            return;
        }
        this.activeVosk = model.id;
        BdApi.Data.save("Microphone", "activeVosk", model.id);
        this.renderCatalog();
        this.setModelInstallStatus(`Подготовка загрузки: ${model.name}...`, "Подключаюсь к локальному загрузчику...", {
            percent: null,
            label: `Подготовка загрузки: ${model.name}...`
        });

        if (this.sttSocket?.readyState === WebSocket.OPEN && this.isRecording) {
            this.sttSocket.send(JSON.stringify({ type: "install_model", id: model.id }));
            return;
        }
        this.connectCatalogServer(0);
    }

    refreshInstalledModels() {
        if (this.isInstallingModel || this.catalogSocket || !this.catalogEngineFilter?.backend) return;
        if (this.catalogConnectTimer) {
            clearTimeout(this.catalogConnectTimer);
            this.catalogConnectTimer = null;
        }
        this.installedCatalogModels = null;
        this.renderCatalog();
        this.connectCatalogServer(0, "list_models");
    }

    connectCatalogServer(attempt, requestType = "install_model") {
        const socket = new WebSocket(this.sttUrl);
        this.catalogSocket = socket;
        socket.onopen = () => {
            if (this.sttState) this.sttState.textContent = "Связь с каталогом моделей установлена";
        };
        socket.onmessage = event => {
            if (this.catalogSocket !== socket || socket.readyState !== WebSocket.OPEN) return;
            let message;
            try {
                message = JSON.parse(event.data);
            } catch (error) {
                console.error("[Microphone] Некорректный ответ каталога моделей:", error);
                return;
            }
            if (message.type === "ready") {
                if (message.catalog_version !== VOSK_CATALOG_VERSION) {
                    this.sttState.textContent = "Нужно перезапустить сервер распознавания";
                    this.liveText.textContent = "Останови старый pythonw.exe со stt_server.py в Диспетчере задач, затем повтори запрос.";
                    this.isInstallingModel = false;
                    this.renderCatalog();
                    this.setModelInstallStatus("Нужен перезапуск сервера", "Перезапусти локальный сервер распознавания и повтори загрузку.", null);
                    socket.close();
                    this.catalogSocket = null;
                    return;
                }
                socket.send(requestType === "list_models"
                    ? JSON.stringify({ type: "list_models" })
                    : JSON.stringify({ type: "install_model", id: this.activeVosk }));
            } else if (message.type === "installed_models") {
                this.installedCatalogModels = new Set(
                    Array.isArray(message.ids) ? message.ids.filter(id => typeof id === "string") : []
                );
                this.renderCatalog();
                this.catalogSocket = null;
                socket.close();
            } else if (message.type === "download_progress") {
                this.handleDownloadProgress(message);
            } else if (message.type === "model_loaded") {
                this.activeVosk = message.id;
                this.selectedCatalogModelId = message.id;
                if (Array.isArray(message.installed_models)) {
                    this.installedCatalogModels = new Set(message.installed_models);
                } else {
                    if (!this.installedCatalogModels) this.installedCatalogModels = new Set();
                    this.installedCatalogModels.add(message.id);
                }
                BdApi.Data.save("Microphone", "activeVosk", this.activeVosk);
                this.renderCatalog();
                this.isInstallingModel = false;
                this.setModelInstallStatus("Модель установлена", `${message.name} готова. Нажми «Начать распознавание».`, null);
                this.catalogSocket = null;
                socket.close();
            } else if (message.type === "error") {
                this.isInstallingModel = false;
                if (requestType === "list_models") {
                    console.error("[Microphone] Не удалось получить список установленных моделей:", message.message);
                    this.renderCatalog();
                } else {
                    this.renderCatalog();
                    this.setModelInstallStatus("Ошибка установки", message.message || "Не удалось установить модель.", null);
                }
                this.catalogSocket = null;
                socket.close();
            }
        };
        socket.onerror = () => {
            if (this.catalogSocket !== socket) return;
            if (attempt >= 60) {
                this.sttState.textContent = "Не удалось подключиться к загрузчику";
                this.liveText.textContent = requestType === "list_models"
                    ? "Не удалось проверить установленные модели. Проверь, запущен ли локальный сервер."
                    : "Проверь Python и наличие stt_server.py рядом с плагином.";
                this.isInstallingModel = false;
                this.renderCatalog();
                if (requestType !== "list_models") {
                    this.setModelInstallStatus("Не удалось подключиться к загрузчику", this.liveText.textContent, null);
                }
                this.catalogSocket = null;
                socket.close();
                return;
            }

            if (!this.serverLaunchAttempted) {
                this.serverLaunchAttempted = true;
                try {
                    this.launchLocalServer();
                } catch (error) {
                    console.error("[Microphone] Не удалось запустить stt_server.bat:", error);
                    this.sttState.textContent = "Не удалось запустить сервер";
                    this.liveText.textContent = "Проверь, что stt_server.bat находится рядом с плагином.";
                    this.isInstallingModel = false;
                    this.renderCatalog();
                    this.setModelInstallStatus("Не удалось запустить сервер", this.liveText.textContent, null);
                    this.catalogSocket = null;
                    socket.close();
                    return;
                }
            }
            this.catalogSocket = null;
            socket.close();
            this.catalogConnectTimer = setTimeout(() => {
                this.catalogConnectTimer = null;
                this.connectCatalogServer(attempt + 1, requestType);
            }, 1000);
        };
        socket.onclose = () => {
            if (this.catalogSocket !== socket) return;
            this.catalogSocket = null;
            if (requestType === "list_models") {
                this.renderCatalog();
                return;
            }
            if (!this.isInstallingModel) return;
            this.sttState.textContent = "Соединение прервано";
            this.liveText.textContent = "Установка модели прервалась. Проверь, что локальный сервер запущен.";
            this.isInstallingModel = false;
            this.renderCatalog();
            this.setModelInstallStatus("Соединение прервано", this.liveText.textContent, null);
        };
    }

    startAudioForwarding(socket, source) {
        if (this.sttSocket !== socket || !this.isRecording || !source) return;
        this.sttState.textContent = "Локальный распознаватель подключен";
        this.liveText.textContent = "Говори — распознанная речь появится здесь.";
        if (!this.processor) {
            this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
            const silentGain = this.audioContext.createGain();
            silentGain.gain.value = 0;
            this.processor.connect(silentGain);
            silentGain.connect(this.audioContext.destination);
            this.processor._silentGain = silentGain;
            source.connect(this.processor);
        }
        this.processor.onaudioprocess = event => {
            if (this.sttSocket !== socket || socket.readyState !== WebSocket.OPEN) return;
            const pcm = this.toPcm16(event.inputBuffer.getChannelData(0), this.audioContext.sampleRate);
            socket.send(pcm.buffer);
        };
    }

    toPcm16(samples, sampleRate) {
        const targetLength = Math.max(1, Math.round(samples.length * 16000 / sampleRate));
        const pcm = new Int16Array(targetLength);
        for (let i = 0; i < targetLength; i++) {
            const position = i * sampleRate / 16000;
            const left = Math.floor(position);
            const fraction = position - left;
            const sample = left + 1 < samples.length
                ? samples[left] * (1 - fraction) + samples[left + 1] * fraction
                : samples[Math.min(left, samples.length - 1)];
            const value = Math.max(-1, Math.min(1, sample));
            pcm[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
        }
        return pcm;
    }

    stopRecording() {
        if (this.autoConnectTimer) clearTimeout(this.autoConnectTimer);
        this.autoConnectTimer = null;
        if (this.rafId) cancelAnimationFrame(this.rafId);
        this.rafId = null;
        if (this.processor) {
            this.processor.disconnect();
            this.processor._silentGain?.disconnect();
            this.processor.onaudioprocess = null;
            this.processor = null;
        }
        if (this.sttSocket) {
            const socket = this.sttSocket;
            this.sttSocket = null;
            if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
        }
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(t => t.stop());
            this.mediaStream = null;
        }
        if (this.audioContext) {
            this.audioContext.close().catch(err => console.error("[Microphone] Не удалось закрыть аудиоконтекст:", err));
            this.audioContext = null;
        }
        this.isRecording = false;
        this.updateUIState();
        if (this.sttState) this.sttState.textContent = "Локальный сервер: ws://127.0.0.1:5000";
    }

    animateMeter() {
        if (!this.isRecording || !this.analyser) return;
        const data = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const percent = Math.min(100, Math.round(((sum / data.length) / 128) * 100));

        if (this.meterFill) this.meterFill.style.width = `${percent}%`;
        if (this.volumePercent) this.volumePercent.textContent = `${percent}%`;

        if (!this.lastRecognizedText && this.liveText) {
            this.liveText.textContent = percent > 8
                ? "🎙️ Слышу голос..."
                : "🎙️ Микрофон активен...";
        }
        this.rafId = requestAnimationFrame(() => this.animateMeter());
    }

    updateUIState() {
        this.button?.setAttribute("data-recording", String(this.isRecording));
        if (this.toggleBtn) {
            this.toggleBtn.setAttribute("data-recording", String(this.isRecording));
            this.toggleBtn.textContent = this.isRecording ? "Остановить распознавание" : "Начать распознавание";
        }
        if (this.statusBadge) {
            this.statusBadge.setAttribute("data-active", String(this.isRecording));
            this.statusBadge.textContent = this.isRecording ? "✓ Активен" : "● Ожидание";
        }
        if (!this.isRecording) {
            if (this.meterFill) this.meterFill.style.width = "0%";
            if (this.volumePercent) this.volumePercent.textContent = "0%";
        }
    }

    activateVoskModel(modelId) {
        const model = VOSK_MODELS.find(item => item.id === modelId);
        if (!model) return;
        this.selectedCatalogModelId = model.id;
        this.activeVosk = model.id;
        BdApi.Data.save("Microphone", "activeVosk", this.activeVosk);
        this.renderCatalog();
        if (this.sttSocket?.readyState === WebSocket.OPEN) {
            this.isInstallingModel = true;
            this.setModelInstallStatus(`Загружаю модель: ${model.name}...`, `Подключаю модель ${model.name}.`);
            this.sttSocket.send(JSON.stringify({ type: "install_model", id: model.id }));
        } else if (this.sttState) {
            this.sttState.textContent = `Выбрана модель: ${model.name}`;
        }
    }

    selectedModelName() {
        return VOSK_MODELS.find(item => item.id === this.activeVosk)?.name || "модель";
    }

    renderCatalog() {
        if (!this.catalogList) return;
        this.catalogList.replaceChildren();
        const engineFilter = this.catalogEngineFilter;
        const engineModels = VOSK_MODELS.filter(model =>
            !engineFilter || model.engine === engineFilter.backend
        );
        const title = this.modelModal.querySelector("#mic-model-dialog-title");
        title.textContent = engineFilter ? `${engineFilter.name} · модели` : "Каталог моделей";
        this.modelModal.querySelector("#mic-model-back-engines").hidden = !engineFilter;
        const header = document.createElement("div");
        header.className = "mic-model-table-header";
        for (const title of ["", "Модель", "Язык", "Размер", "Установка"]) {
            const cell = document.createElement("span");
            cell.textContent = title;
            header.append(cell);
        }
        this.catalogList.append(header);

        const selectedModel = engineModels.find(model => model.id === this.selectedCatalogModelId)
            || engineModels.find(model => model.id === this.activeVosk)
            || engineModels[0];
        if (selectedModel) this.selectedCatalogModelId = selectedModel.id;
        if (this.modelSource) {
            this.modelSource.href = selectedModel?.url || engineFilter?.url || VOSK_MODELS[0].url;
        }
        if (engineFilter) {
            this.modelDownloadState.textContent = engineFilter.details;
        } else {
            this.modelDownloadState.textContent = "Выбранная модель будет загружена из её репозитория.";
        }
        this.modelInstallButton.disabled = this.isInstallingModel || !selectedModel;
        this.modelInstallButton.textContent = this.isInstallingModel
            ? "Загрузка..."
            : selectedModel ? "Скачать выбранную" : "Нет готовой установки";
        const query = this.catalogSearch?.value.trim().toLocaleLowerCase() || "";
        const filteredModels = engineModels.filter(model =>
            `${model.name} ${model.id} ${model.language}`.toLocaleLowerCase().includes(query)
        );
        for (const model of filteredModels) {
            const isSelected = this.selectedCatalogModelId === model.id;
            const row = document.createElement("div");
            row.className = "mic-model-row";
            row.dataset.selected = String(isSelected);

            const info = document.createElement("div");
            info.className = "mic-model-info";
            const name = document.createElement("span");
            name.className = "mic-model-name";
            name.textContent = model.name;
            name.title = model.name;
            info.append(name);
            const compactMeta = document.createElement("span");
            compactMeta.className = "mic-model-compact-meta";
            compactMeta.textContent = `${model.language} · ${model.size}`;
            info.append(compactMeta);
            const radio = document.createElement("input");
            radio.type = "radio";
            radio.name = "mic-model-selection";
            radio.className = "mic-model-select";
            radio.checked = isSelected;
            radio.disabled = this.isInstallingModel;
            radio.setAttribute("aria-label", `Выбрать модель ${model.name}`);
            radio.onchange = () => this.activateVoskModel(model.id);
            row.onclick = event => {
                if (!this.isInstallingModel && event.target !== radio) this.activateVoskModel(model.id);
            };

            const language = document.createElement("span");
            language.className = "mic-model-cell";
            language.textContent = model.language;
            const size = document.createElement("span");
            size.className = "mic-model-cell";
            size.textContent = model.size;
            const installation = document.createElement("span");
            installation.className = "mic-model-cell mic-installation-cell";
            const installed = this.installedCatalogModels?.has(model.id) ?? null;
            installation.dataset.installed = installed === null ? "unknown" : String(installed);
            installation.textContent = installed === null
                ? "Не проверено"
                : installed ? "✓ Установлена" : "Не установлена";
            row.append(radio, info, language, size, installation);
            this.catalogList.append(row);
        }
        if (filteredModels.length === 0) {
            const empty = document.createElement("div");
            empty.className = "mic-model-meta";
            empty.textContent = engineFilter
                ? `${engineFilter.name}: установщик моделей для этого движка ещё не подключён. Открой официальный сайт движка, чтобы посмотреть его модели.`
                : "По запросу ничего не найдено.";
            this.catalogList.append(empty);
        }
    }

    async refreshDevices() {
        if (!navigator.mediaDevices?.enumerateDevices) return;
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const mics = devices.filter(d => d.kind === "audioinput");
            this.deviceSelect.replaceChildren();
            for (const mic of mics) {
                const opt = document.createElement("option");
                opt.value = mic.deviceId;
                opt.textContent = mic.label || `Микрофон (${mic.deviceId.slice(0, 5)})`;
                this.deviceSelect.append(opt);
            }
            if (mics.some(m => m.deviceId === this.selectedDeviceId)) this.deviceSelect.value = this.selectedDeviceId;
        } catch (err) {
            console.error("[Microphone] Не удалось получить список устройств:", err);
        }
    }

    togglePanel() {
        if (!this.panel) return;
        this.panel.hidden = !this.panel.hidden;
        if (!this.panel.hidden) {
            this.keepInViewport();
            this.refreshDevices();
            this.renderCatalog();
        }
    }

    toggleRecording() {
        if (this.isRecording) this.stopRecording();
        else this.startRecording();
    }

    beginDrag(event) {
        if (event.button !== 0 || event.target.closest("button") || !event.target.closest(".mic-panel-head")) return;
        const bounds = this.panel.getBoundingClientRect();
        this.drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: bounds.left, top: bounds.top };
        this.panel.style.left = `${bounds.left}px`;
        this.panel.style.top = `${bounds.top}px`;
        this.panel.style.bottom = "auto";
        this.panel.style.transform = "none";
        this.panel.dataset.dragging = "true";
        this.panel.setPointerCapture(event.pointerId);
        event.preventDefault();
    }

    moveDrag(event) {
        if (!this.drag || event.pointerId !== this.drag.pointerId) return;
        this.panel.style.left = `${Math.max(8, Math.min(window.innerWidth - this.panel.offsetWidth - 8, this.drag.left + event.clientX - this.drag.startX))}px`;
        this.panel.style.top = `${Math.max(8, Math.min(window.innerHeight - this.panel.offsetHeight - 8, this.drag.top + event.clientY - this.drag.startY))}px`;
    }

    endDrag(event) {
        if (!this.drag || event.pointerId !== this.drag.pointerId) return;
        this.drag = null;
        delete this.panel.dataset.dragging;
        if (this.panel.hasPointerCapture(event.pointerId)) this.panel.releasePointerCapture(event.pointerId);
        BdApi.Data.save("Microphone", "panelPosition", { left: this.panel.offsetLeft, top: this.panel.offsetTop });
    }

    keepInViewport() {
        const bounds = this.panel.getBoundingClientRect();
        this.panel.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - bounds.width - 8))}px`;
        this.panel.style.top = `${Math.max(8, Math.min(bounds.top, window.innerHeight - bounds.height - 8))}px`;
        this.panel.style.bottom = "auto";
        this.panel.style.transform = "none";
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
        this.stopRecording();
        this.subtitleBridgePeers = [];
        this.subtitleBridgePeersAt = 0;
        this.subtitleBridgeRequest = null;
        if (this.catalogConnectTimer) clearTimeout(this.catalogConnectTimer);
        this.catalogConnectTimer = null;
        this.isInstallingModel = false;
        if (this.catalogSocket) {
            const socket = this.catalogSocket;
            this.catalogSocket = null;
            if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
        }
        clearInterval(this.timer);
        clearInterval(this.serverStatusTimer);
        this.serverStatusTimer = null;
        if (this.serverStatusSocket) {
            const socket = this.serverStatusSocket;
            this.serverStatusSocket = null;
            if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
        }
        clearTimeout(this.placementTimer);
        this.observer?.disconnect();
        this.panel?.remove();
        this.modelModal?.remove();
        this.engineDirectoryModal?.remove();
        if (this.onCatalogKeyDown) window.removeEventListener("keydown", this.onCatalogKeyDown, true);
        window.removeEventListener("resize", this.onViewportResize);
        this.button?.remove();
        document.querySelector("#bd-voice-plugin-toolbar:empty")?.remove();
        if (typeof BdApi !== "undefined") BdApi.DOM.removeStyle("Microphone");
    }
};

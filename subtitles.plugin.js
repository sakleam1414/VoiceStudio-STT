/**
 * @name Subtitles
 * @author Codex
 * @version 1.9.0
 * @description Чистые субтитры. ЛКМ — окно субтитров, ПКМ — участники и автоматический поиск устройств.
 */
const SUBTITLES_UPDATE_CHECK_TTL = 6 * 60 * 60 * 1000;

module.exports = class Subtitles {
    start() {
        this.stop();
        if (require.cache && require.resolve) delete require.cache[require.resolve("./stt_updates")];
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
        this.updateCheckTimer = null;
        this.lastUpdateInfo = null;

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
        void this.checkForUpdates();
        this.updateCheckTimer = setInterval(() => this.checkForUpdates(), SUBTITLES_UPDATE_CHECK_TTL);

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

    async checkForUpdates() {
        try {
            return await require("./stt_updates").check(__dirname, "subtitles");
        } catch (error) {
            console.debug("[Subtitles] Проверка обновления недоступна:", error.message);
            return null;
        }
    }

    getSettingsPanel() {
        return require("./stt_updates").panel(__dirname, "subtitles");
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
        const result = await require("./stt_updates").network(__dirname).refresh();
        this.tailscalePeers = new Map([...result.peers].map(([id, peers]) => [id, peers.map(peer => peer.address)]));
        this.peerSources = new Map([...result.peers].map(([id, peers]) => [id, peers[0]?.source]));
        this.tailscalePeerAddresses = result.addresses;
        this.peerDiscoveryMessage = result.discoveryError && !result.peers.size
            ? `Автопоиск: ${result.discoveryError}. Можно указать адрес друга вручную.`
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
            : require("./stt_updates").parsePeerAddress(address).url;
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
        try { await require("./stt_updates").network(__dirname).send(payload, ids); }
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
            box.dataset.state = "error";
            text.textContent = `● Автопоиск устройств: ${error}`;
        } else if (unknown > 0) {
            box.dataset.state = "partial";
            text.textContent = `● Субтитры доступны: ${online}/${total} · запусти плагин на остальных ПК`;
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
        const updates = document.createElement("button");
        updates.type = "button";
        updates.className = "subtitles-network-refresh";
        updates.textContent = "Обновление Subtitles · 1.9.0";
        updates.onclick = () => require("./stt_updates").show(__dirname, "subtitles");
        const network = document.createElement("button");
        network.type = "button"; network.className = "subtitles-network-refresh";
        network.textContent = "Мой адрес и адреса друзей";
        network.onclick = () => require("./stt_updates").showNetwork(__dirname);
        this.participantMenu.append(network, updates);

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
                address.onclick = () => require("./stt_updates").showNetwork(__dirname, {userId: user.id, name: user.globalName || user.username || "Участник"});
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
            peerDiscoveryError = error.message;
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
                    ? (peerDiscoveryError || "Не удалось проверить сервер на этом ПК")
                    : (peerDiscoveryError || "Друг не найден. Нажмите «Адрес» или проверьте его сервер.")
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
        clearInterval(this.updateCheckTimer);
        this.updateCheckTimer = null;
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

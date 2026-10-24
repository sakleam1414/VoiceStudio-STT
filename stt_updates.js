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

module.exports = {check, panel, run, repository, show};

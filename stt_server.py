import asyncio
import argparse
from collections import deque
import ipaddress
import json
import logging
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

HOST = "127.0.0.1"
PORT = 5000
SUBTITLE_HOST = "0.0.0.0"
SUBTITLE_PORT = 8765
SUBTITLE_MAX_BODY = 32 * 1024
CATALOG_VERSION = 11
APP_DIR = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", APP_DIR))
MODELS_DIR = APP_DIR / "models"
WHISPER_MODELS_DIR = MODELS_DIR / "whisper"
WAV2VEC_MODELS_DIR = MODELS_DIR / "wav2vec2"
GIGAAM_MODELS_DIR = MODELS_DIR / "gigaam"
CATALOG_FILE = APP_DIR / "vosk_models.json"
if not CATALOG_FILE.is_file() and getattr(sys, "frozen", False):
    CATALOG_FILE = RESOURCE_DIR / "vosk_models.json"
INSTALLED_MODELS_FILE = MODELS_DIR / "installed_catalog_models.json"
LOG_FILE = APP_DIR / "stt_server.log"
WHISPER_CHUNK_BYTES = 4 * 16000 * 2
WAV2VEC_CHUNK_BYTES = 5 * 16000 * 2
GIGAAM_CHUNK_BYTES = 5 * 16000 * 2
MMS_CHUNK_BYTES = 5 * 16000 * 2
NEMO_CHUNK_BYTES = 5 * 16000 * 2
SERVER_VERSION = "1.6.1"
DEFAULT_UPDATE_REPOSITORY = "sakleam1414/VoiceStudio-STT"
UPDATE_CONFIG_FILE = APP_DIR / "stt_update.json"
UPDATE_CHECK_TTL = 6 * 60 * 60
update_cache = None
update_cache_at = 0.0

DASHBOARD_HTML = r'''<!doctype html>
<html lang="ru">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Voice Studio · Сервер</title>
<style>
*{box-sizing:border-box} :root{color-scheme:dark;font:14px/1.5 "Segoe UI",system-ui,sans-serif;color:#e8edf8;background:#090c14}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}
main{width:min(800px,100%);min-height:192px;background:#10131e;border:1px solid #30394e;border-radius:12px;box-shadow:0 20px 70px #0006;overflow:hidden}
.content{display:grid;grid-template-columns:1fr 1.25fr;gap:24px;padding:20px 22px 12px}
h1{font-size:20px;line-height:1.3;letter-spacing:-.4px;margin:0 0 12px;font-weight:700}
.intro{color:#8f9bb1;font-size:11px;max-width:250px;margin:0}
.services{display:grid;gap:8px;align-content:start}
.service{min-width:0}
.service-top{display:flex;align-items:center;justify-content:space-between;gap:12px}
.name{font-size:12px;font-weight:650;color:#9ad8e5;white-space:nowrap}
.badge{display:inline-flex;align-items:center;gap:6px;border:1px solid #49516a;border-radius:30px;background:#222939;color:#b6c2d8;padding:3px 9px;font-size:10px;white-space:nowrap}
.badge:before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;flex-shrink:0}
.badge[data-state=active]{color:#80dec0;background:#16302b;border-color:#305b50}
.badge[data-state=inactive]{color:#ffa2b0;background:#331e2b;border-color:#694052}
.badge[data-state=unknown]{color:#e8bf69;background:#302818;border-color:#6e5930}
.detail{display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:5px;margin-top:4px;color:#8e9db6;font-size:10px}
.detail .badge{font-size:10px;padding:1px 7px}
footer{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:8px 22px 12px;font-size:10px;color:#8291ac}
.actions{display:flex;align-items:center;gap:14px}
button{font:inherit;font-size:11px;font-weight:600;color:#c7d5ee;background:#202940;border:1px solid #39496b;border-radius:8px;padding:6px 10px;cursor:pointer}
button:hover{background:#2d3a58}button:focus-visible{outline:2px solid #96b9ff;outline-offset:3px}button:disabled{opacity:.5;cursor:wait}
#message{margin:0;padding:0 22px 4px;color:#e8bf69;font-size:11px;overflow-wrap:anywhere}
#message:empty{display:none}
@media(max-width:600px){body{padding:12px}.content{grid-template-columns:1fr;gap:16px;padding:18px}.intro{max-width:none}h1{font-size:19px}footer{padding:8px 18px 14px;flex-wrap:wrap}.actions{flex-wrap:wrap}}
</style>
<main aria-label="Панель сервера Voice Studio">
 <div class="content">
  <header>
   <h1>Запуск и автозагрузка</h1>
   <p class="intro">Распознавание речи и субтитры</p>
  </header>
  <section class="services" aria-label="Состояния служб">
   <div class="service"><div class="service-top"><span class="name">stt_server.py</span><span class="badge" id="stt" data-state="unknown">Проверка…</span></div><div class="detail">Автозагрузка <span class="badge" id="startup" data-state="unknown">Проверка…</span></div></div>
   <div class="service"><div class="service-top"><span class="name">Tailscale</span><span class="badge" id="tailscale" data-state="unknown">Проверка…</span></div><div class="detail"><span id="tailscale-startup" hidden></span></div></div>
   <div class="service"><div class="service-top"><span class="name">Субтитры</span><span class="badge" id="subtitles" data-state="unknown">Проверка…</span></div></div>
  </section>
 </div>
 <p id="message" role="status" aria-live="polite"></p>
 <footer><span id="version">Версия 1.6.1</span><div class="actions"><span id="updated">Подключение…</span><button id="refresh" type="button">Обновить ↻</button></div></footer>
</main>
<script>
const refreshButton=document.getElementById('refresh');
let pending=false;
 function badge(id,state,text){const node=document.getElementById(id);if(!node)return;node.dataset.state=state;node.textContent=text}
async function refresh(){
 if(pending)return;pending=true;refreshButton.disabled=true;
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),6000);
 try{
  const response=await fetch('/status',{cache:'no-store',signal:controller.signal});
  if(!response.ok)throw new Error('Сервер не ответил');
  const data=await response.json();
  for(const [id,value] of Object.entries(data.services))badge(id,value.state,value.text);
  document.getElementById('version').textContent='Версия '+data.version;
  const update=data.update||{};
  document.getElementById('updated').textContent=update.state==='active'?'Доступна версия '+update.version:'Обновлено '+new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
  document.getElementById('message').textContent=update.message||data.message||'';
 }catch(error){
  for(const id of ['stt','startup','tailscale','tailscale-startup','subtitles'])badge(id,'unknown','Нет связи');
  document.getElementById('updated').textContent='Нет соединения';
  document.getElementById('message').textContent='Сервер недоступен. Запустите stt_server.bat и обновите страницу.';
 }finally{clearTimeout(timeout);pending=false;refreshButton.disabled=false}
}
refreshButton.addEventListener('click',refresh);refresh();setInterval(()=>{if(!document.hidden)refresh()},10000);
</script>
</html>'''

logging.basicConfig(
    filename=LOG_FILE,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    encoding="utf-8",
)
logging.getLogger("websockets").setLevel(logging.WARNING)
MODEL_CATALOG = {}
websockets = KaldiRecognizer = Model = None
startup_error = None
install_lock = asyncio.Lock()
subtitle_user_id = None
subtitle_last_seen = 0.0
subtitle_inbox = deque(maxlen=100)
tailscale_peers_cache = set()
tailscale_peers_cache_at = 0.0
tailscale_peer_records_cache = []
tailscale_self_addresses = []


def get_tailscale_peer_records():
    global tailscale_peers_cache, tailscale_peer_records_cache, tailscale_peers_cache_at, tailscale_self_addresses
    now = time.monotonic()
    if now - tailscale_peers_cache_at < 10:
        return tailscale_peer_records_cache

    candidates = [
        shutil.which("tailscale.exe"),
        shutil.which("tailscale"),
        str(Path(os.environ.get("ProgramFiles", "C:\\Program Files")) / "Tailscale" / "tailscale.exe"),
        "C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
        str(Path(os.environ.get("ProgramFiles", "C:\\Program Files")) / "Tailscale IPN" / "tailscale.exe"),
        str(Path(os.environ.get("LOCALAPPDATA", "")) / "Tailscale" / "tailscale.exe"),
    ]
    executable = next((candidate for candidate in candidates if candidate and Path(candidate).is_file()), None)
    if not executable:
        raise RuntimeError("Не найден tailscale.exe")

    result = subprocess.run(
        [executable, "status", "--json"],
        capture_output=True,
        check=True,
        text=True,
        timeout=5,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    status = json.loads(result.stdout)
    if status.get("BackendState") != "Running":
        raise RuntimeError(f"Tailscale не подключён ({status.get('BackendState', 'нет состояния')})")

    tailscale_self_addresses = []
    for address in (status.get("Self") or {}).get("TailscaleIPs", []):
        try:
            ip = ipaddress.ip_address(address)
            if ip.version == 4 and ip in ipaddress.ip_network("100.64.0.0/10"):
                tailscale_self_addresses.append(str(ip))
        except ValueError:
            pass

    peer_records = []
    peers = status.get("Peer") or {}
    if not isinstance(peers, dict):
        raise RuntimeError("Некорректный список устройств Tailscale")
    for peer in peers.values():
        peer_online = bool(peer.get("Online"))
        peer_name = str(peer.get("HostName") or peer.get("DNSName") or "")
        for address in peer.get("TailscaleIPs", []):
            if not isinstance(address, str):
                continue
            try:
                parsed_address = ipaddress.ip_address(address)
                if parsed_address.version == 4:
                    peer_records.append({"address": str(parsed_address), "online": peer_online, "name": peer_name})
            except ValueError:
                logging.warning("Ignoring invalid Tailscale peer address: %r", address)
    tailscale_peer_records_cache = peer_records
    tailscale_peers_cache = {record["address"] for record in peer_records if record["online"]}
    tailscale_peers_cache_at = now
    return peer_records


def get_online_tailscale_ips():
    return {record["address"] for record in get_tailscale_peer_records() if record["online"]}


def is_tailscale_source(address):
    if address is None:
        return False
    try:
        ip = ipaddress.ip_address(address)
        return ip in ipaddress.ip_network("100.64.0.0/10") or ip in ipaddress.ip_network("fd7a:115c:a1e0::/48")
    except ValueError:
        return False


def normalize_ip_address(address):
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
        if ip.version == 6 and ip.ipv4_mapped:
            return ip.ipv4_mapped
        return ip
    except ValueError:
        return None


def get_autostart_status():
    """Read Windows startup settings without changing the user's configuration."""
    if sys.platform != "win32":
        return {"state": "unknown", "text": "Только Windows"}
    import winreg

    startup = Path(os.environ.get("APPDATA", "")) / "Microsoft/Windows/Start Menu/Programs/Startup"
    target = str(APP_DIR / "stt_server.bat").casefold()
    states = []
    for name in ("bd_stt_server.bat", "stt_server_autostart.bat"):
        entry = startup / name
        if not entry.is_file() or target not in entry.read_text(encoding="utf-8", errors="replace").casefold():
            continue
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder") as key:
                value, _ = winreg.QueryValueEx(key, name)
            state = value[0] if isinstance(value, bytes) and value else None
            states.append("active" if state in (2, 6) else "inactive" if state in (3, 7) else "unknown")
        except FileNotFoundError:
            states.append("active")
    state = "active" if "active" in states else "inactive" if not states or all(s == "inactive" for s in states) else "unknown"
    return {"state": state, "text": {"active": "Включена", "inactive": "Выключена", "unknown": "Не удалось проверить"}[state]}


def set_autostart(enabled):
    if sys.platform != "win32":
        raise RuntimeError("Автозагрузка доступна только в Windows")
    import winreg

    directory = Path(os.environ["APPDATA"]) / "Microsoft/Windows/Start Menu/Programs/Startup"
    launcher = APP_DIR / "stt_server.bat"
    if not launcher.is_file():
        raise RuntimeError("Для автозагрузки нужен stt_server.bat рядом с программой")
    target = str(launcher).casefold()
    for name in ("bd_stt_server.bat", "stt_server_autostart.bat"):
        entry = directory / name
        if entry.exists() and target not in entry.read_text(encoding="utf-8", errors="replace").casefold():
            raise RuntimeError(f"Файл автозагрузки {name} относится к другой папке. Удалите старую запись в настройках Windows.")
    if enabled:
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "bd_stt_server.bat").write_text(f'@echo off\nchcp 65001 >nul\ncall "{launcher}" --background\n', encoding="utf-8")
    else:
        for name in ("bd_stt_server.bat", "stt_server_autostart.bat"):
            (directory / name).unlink(missing_ok=True)
    if enabled:
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder", 0, winreg.KEY_SET_VALUE) as key:
                for name in ("bd_stt_server.bat", "stt_server_autostart.bat"):
                    try:
                        winreg.DeleteValue(key, name)
                    except FileNotFoundError:
                        pass
        except FileNotFoundError:
            pass


def get_update_settings():
    settings = {"repository": DEFAULT_UPDATE_REPOSITORY}
    try:
        loaded = json.loads(UPDATE_CONFIG_FILE.read_text(encoding="utf-8-sig"))
        repository = loaded.get("repository", "")
        import re
        if re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
            settings["repository"] = repository
    except (OSError, ValueError, AttributeError):
        pass
    return settings


def run_component_update(install=False):
    updater = APP_DIR / "stt_updater.ps1"
    if not updater.is_file():
        raise RuntimeError("Рядом с сервером отсутствует stt_updater.ps1")
    executable = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    args = [str(executable), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(updater),
            "-Directory", str(APP_DIR), "-Component", "server", "-Repository", get_update_settings()["repository"]]
    if install:
        args.append("-Install")
        subprocess.Popen(args, cwd=APP_DIR, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return
    result = subprocess.run(args, capture_output=True, timeout=45, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", "replace").strip()[:180] or "GitHub недоступен")
    return json.loads(result.stdout.decode("utf-8-sig"))


def check_for_update(force=False):
    global update_cache, update_cache_at
    if not force and update_cache is not None and time.monotonic() - update_cache_at < UPDATE_CHECK_TTL:
        return update_cache
    repository = get_update_settings()["repository"]
    result = {"state": "unknown", "version": SERVER_VERSION, "repository": repository,
              "url": f"https://github.com/{repository}/releases", "message": "Проверка обновления…"}
    try:
        remote = run_component_update()
        result.update(remote)
        result["state"] = "active" if remote["available"] else "inactive"
        result["message"] = (f"Сервер: {remote['current']} → {remote['version']} · нажмите «Установить»"
                             if remote["available"] else "Установлена последняя версия сервера.")
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        result["message"] = f"Обновления: {error}"
    update_cache = result
    update_cache_at = time.monotonic()
    return result


def get_dashboard_status():
    stt_running = is_port_in_use(HOST, PORT)
    subtitles_connected = bool(subtitle_user_id and time.monotonic() - subtitle_last_seen <= 10)
    services = {
        "stt": {"state": "active" if stt_running else "inactive", "text": "Запущен" if stt_running else "Остановлен"},
        "subtitles": {"state": "active" if subtitles_connected else "unknown", "text": "Плагин подключён" if subtitles_connected else "Ожидание плагина"},
        "tailscale-startup": {"state": "unknown", "text": "Не удалось проверить"},
    }
    message = startup_error or ""
    try:
        services["startup"] = get_autostart_status()
    except OSError:
        services["startup"] = {"state": "unknown", "text": "Ошибка проверки"}
    try:
        get_online_tailscale_ips()
        services["tailscale"] = {"state": "active", "text": "Подключён"}
    except (OSError, RuntimeError, subprocess.SubprocessError, ValueError) as error:
        services["tailscale"] = {"state": "inactive", "text": "Недоступен"}
        message = message or str(error)
    if sys.platform == "win32":
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Services\Tailscale") as key:
                start, _ = winreg.QueryValueEx(key, "Start")
            services["tailscale-startup"] = {"state": "active" if start == 2 else "inactive", "text": "Автоматически" if start == 2 else "Вручную" if start == 3 else "Отключён" if start == 4 else "Другой режим"}
        except FileNotFoundError:
            services["tailscale-startup"] = {"state": "inactive", "text": "Служба не установлена"}
        except OSError:
            pass
    return {"version": SERVER_VERSION, "services": services, "message": message}



async def send_http_response(writer, status, payload, content_type="application/json"):
    body = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    reasons = {200: "OK", 204: "No Content", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 413: "Payload Too Large", 500: "Internal Server Error", 503: "Service Unavailable"}
    headers = [
        f"HTTP/1.1 {status} {reasons.get(status, 'Error')}",
        f"Content-Type: {content_type}",
        f"Content-Length: {len(body)}",
        "Access-Control-Allow-Origin: *",
        "Access-Control-Allow-Methods: GET, POST, OPTIONS",
        "Access-Control-Allow-Headers: Content-Type",
        "Access-Control-Allow-Private-Network: true",
        "Connection: close",
        "Cache-Control: no-store",
        "X-Content-Type-Options: nosniff",
        "",
        "",
    ]
    writer.write("\r\n".join(headers).encode("ascii") + body)
    await writer.drain()


async def handle_subtitle_http(reader, writer):
    global subtitle_user_id, subtitle_last_seen
    remote = writer.get_extra_info("peername")
    source_ip = normalize_ip_address(remote[0]) if remote else None
    is_loopback = bool(source_ip and source_ip.is_loopback)
    try:
        request_line = await asyncio.wait_for(reader.readline(), timeout=5)
        if len(request_line) > 8192:
            await send_http_response(writer, 400, {"error": "request line too long"})
            return
        method, target, _version = request_line.decode("ascii").strip().split(" ", 2)
        headers = {}
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=5)
            if line in (b"\r\n", b"\n", b""):
                break
            if len(line) > 8192:
                await send_http_response(writer, 400, {"error": "header too long"})
                return
            name, separator, value = line.decode("latin-1").partition(":")
            if not separator:
                await send_http_response(writer, 400, {"error": "invalid header"})
                return
            headers[name.strip().lower()] = value.strip()

        try:
            content_length = int(headers.get("content-length", "0"))
        except ValueError:
            await send_http_response(writer, 400, {"error": "invalid content length"})
            return
        if content_length < 0 or content_length > SUBTITLE_MAX_BODY:
            await send_http_response(writer, 413, {"error": "request body too large"})
            return
        body = await asyncio.wait_for(reader.readexactly(content_length), timeout=5) if content_length else b""
        path = urlsplit(target).path

        if method == "OPTIONS":
            if not is_loopback and not is_tailscale_source(source_ip):
                await send_http_response(writer, 403, {"error": "Tailscale peer required"})
                return
            await send_http_response(writer, 204, b"", "text/plain")
            return
        if path in ("/", "/status", "/register", "/inbox", "/peers", "/network") and not is_loopback:
            await send_http_response(writer, 403, {"error": "local access required"})
            return
        if path in ("/ping", "/subtitle") and not is_loopback:
            if not is_tailscale_source(source_ip):
                await send_http_response(writer, 403, {"error": "Tailscale peer required"})
                return

        if method == "GET" and path == "/":
            await send_http_response(writer, 200, DASHBOARD_HTML.encode("utf-8"), "text/html; charset=utf-8")
        elif method == "GET" and path == "/status":
            await send_http_response(writer, 200, await asyncio.to_thread(get_dashboard_status))
        elif method == "GET" and path == "/ping":
            if not subtitle_user_id or time.monotonic() - subtitle_last_seen > 10:
                await send_http_response(writer, 503, {"ok": False, "error": "plugin is not registered"})
                return
            await send_http_response(writer, 200, {"ok": True, "userId": subtitle_user_id, "protocol": 1})
        elif method == "GET" and path == "/peers":
            try:
                records = await asyncio.to_thread(get_tailscale_peer_records)
                addresses = sorted(record["address"] for record in records)
            except (OSError, RuntimeError, subprocess.SubprocessError, json.JSONDecodeError) as error:
                await send_http_response(writer, 503, {"error": str(error)})
                return
            await send_http_response(writer, 200, {"ok": True, "addresses": addresses})
        elif method == "GET" and path == "/network":
            try:
                await asyncio.to_thread(get_tailscale_peer_records)
                await send_http_response(writer, 200, {"ok": True, "addresses": tailscale_self_addresses, "port": SUBTITLE_PORT})
            except (OSError, RuntimeError, subprocess.SubprocessError, json.JSONDecodeError) as error:
                await send_http_response(writer, 503, {"error": str(error)})
        elif method == "GET" and path == "/inbox":
            messages = list(subtitle_inbox)
            subtitle_inbox.clear()
            await send_http_response(writer, 200, {"ok": True, "messages": messages})
        elif method == "POST" and path == "/register":
            try:
                data = json.loads(body)
            except (UnicodeDecodeError, json.JSONDecodeError):
                await send_http_response(writer, 400, {"error": "invalid JSON"})
                return
            user_id = data.get("userId") if isinstance(data, dict) else None
            if not isinstance(user_id, str) or not user_id.isdigit() or len(user_id) > 24:
                await send_http_response(writer, 400, {"error": "invalid Discord user ID"})
                return
            subtitle_user_id = user_id
            subtitle_last_seen = time.monotonic()
            await send_http_response(writer, 200, {"ok": True})
        elif method == "POST" and path == "/subtitle":
            try:
                data = json.loads(body)
            except (UnicodeDecodeError, json.JSONDecodeError):
                await send_http_response(writer, 400, {"error": "invalid JSON"})
                return
            if (
                not isinstance(data, dict)
                or not isinstance(data.get("userId"), str)
                or not isinstance(data.get("text"), str)
                or not data["text"].strip()
                or len(data["text"]) > 10000
            ):
                await send_http_response(writer, 400, {"error": "invalid subtitle"})
                return
            subtitle_inbox.append(data)
            await send_http_response(writer, 200, {"ok": True})
        else:
            await send_http_response(writer, 404, {"error": "not found"})
    except (asyncio.IncompleteReadError, asyncio.TimeoutError, UnicodeDecodeError, ValueError) as error:
        logging.debug("Invalid subtitle HTTP request: %s", error)
        try:
            await send_http_response(writer, 400, {"error": "invalid request"})
        except (ConnectionError, OSError):
            pass
    except (ConnectionError, OSError):
        pass
    except Exception:
        logging.exception("Subtitle HTTP handler failed")
        try:
            await send_http_response(writer, 500, {"error": "internal server error"})
        except (ConnectionError, OSError):
            pass
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except (ConnectionError, OSError):
            pass


def is_port_in_use(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) == 0


def is_model_folder(path: Path) -> bool:
    return all((path / folder).is_dir() for folder in ("am", "conf", "graph"))


def is_huggingface_model_cached(
    cache_dir: Path,
    model_name: str,
    required_files: tuple[str, ...],
    any_of_files: tuple[str, ...] = (),
) -> bool:
    repository_dir = cache_dir / f"models--{model_name.replace('/', '--')}"
    snapshots_dir = repository_dir / "snapshots"
    return snapshots_dir.is_dir() and any(
        all((snapshot / name).is_file() for name in required_files)
        and (
            not any_of_files
            or any((snapshot / name).is_file() for name in any_of_files)
        )
        for snapshot in snapshots_dir.iterdir()
        if snapshot.is_dir()
    )


def get_installed_model_ids():
    if INSTALLED_MODELS_FILE.is_file():
        try:
            with INSTALLED_MODELS_FILE.open(encoding="utf-8") as installed_file:
                installed_ids = json.load(installed_file)
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError(f"Не удалось прочитать список установленных моделей: {error}") from error
        if not isinstance(installed_ids, list) or any(
            not isinstance(model_id, str) or model_id not in MODEL_CATALOG
            for model_id in installed_ids
        ):
            raise ValueError(f"Некорректный список установленных моделей: {INSTALLED_MODELS_FILE}")
    else:
        installed_ids = []

    installed = set(installed_ids)
    installed.update(
        model_id
        for model_id, model_info in MODEL_CATALOG.items()
        if model_info.get("engine") == "vosk" and is_model_folder(MODELS_DIR / model_id)
    )
    for model_id, model_info in MODEL_CATALOG.items():
        engine = model_info.get("engine")
        model_name = model_info.get("model")
        if not model_name:
            continue
        if engine == "whisper" and is_huggingface_model_cached(
            WHISPER_MODELS_DIR, model_name, ("model.bin",)
        ):
            installed.add(model_id)
        elif engine == "wav2vec2" and is_huggingface_model_cached(
            WAV2VEC_MODELS_DIR,
            model_name,
            ("config.json",),
            ("pytorch_model.bin", "model.safetensors"),
        ):
            installed.add(model_id)
        elif engine == "mms" and is_huggingface_model_cached(
            MODELS_DIR / "mms",
            model_name,
            ("config.json",),
            ("pytorch_model.bin", "model.safetensors"),
        ):
            installed.add(model_id)
    if model_id_active and model is not None:
        installed.add(model_id_active)
    return sorted(installed)


def save_installed_model(model_id):
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    installed_ids = set(get_installed_model_ids())
    installed_ids.add(model_id)
    temporary_file = INSTALLED_MODELS_FILE.with_suffix(".tmp")
    with temporary_file.open("w", encoding="utf-8") as installed_file:
        json.dump(sorted(installed_ids), installed_file, ensure_ascii=False, indent=2)
        installed_file.write("\n")
    temporary_file.replace(INSTALLED_MODELS_FILE)


def download_and_extract(model_id, progress):
    model_info = MODEL_CATALOG[model_id]
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    destination = MODELS_DIR / model_id
    if is_model_folder(destination):
        progress(100, 0, 0, "complete")
        return destination

    with tempfile.TemporaryDirectory(prefix=f".{model_id}-", dir=MODELS_DIR) as temporary:
        temporary_path = Path(temporary)
        archive_path = temporary_path / "model.zip"
        request = urllib.request.Request(
            model_info["url"],
            headers={"User-Agent": "BetterDiscord-Microphone/1.5"},
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            total_size = int(response.headers.get("Content-Length", "0"))
            downloaded = 0
            last_percent = -1
            progress(0 if total_size else None, 0, total_size, "download")
            with archive_path.open("wb") as archive:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    archive.write(chunk)
                    downloaded += len(chunk)
                    if total_size:
                        percent = min(99, downloaded * 100 // total_size)
                        if percent >= last_percent + 1:
                            progress(percent, downloaded, total_size, "download")
                            last_percent = percent
                    elif downloaded == len(chunk) or downloaded % (5 * 1024 * 1024) < len(chunk):
                        progress(None, downloaded, 0, "download")

        progress(99, downloaded, total_size, "extract")
        extracted_path = temporary_path / "extracted"
        extracted_path.mkdir()
        with zipfile.ZipFile(archive_path) as archive:
            root = extracted_path.resolve()
            for entry in archive.infolist():
                target = (extracted_path / entry.filename).resolve()
                if not target.is_relative_to(root):
                    raise ValueError("The downloaded model archive contains an invalid path.")
            archive.extractall(extracted_path)

        model_folder = next(
            (candidate for candidate in extracted_path.rglob("am") if candidate.is_dir()
             and (candidate.parent / "conf").is_dir()
             and (candidate.parent / "graph").is_dir()),
            None,
        )
        if model_folder is None:
            raise ValueError("Downloaded archive does not contain a valid Vosk model.")
        extracted_model = model_folder.parent
        if destination.exists():
            shutil.rmtree(destination, ignore_errors=True)
        shutil.move(str(extracted_model), str(destination))
        progress(100, total_size, total_size, "complete")
        return destination


def load_whisper_model(model_name):
    try:
        from faster_whisper import WhisperModel
    except ImportError as error:
        raise RuntimeError(
            "Для русских Whisper-моделей установи faster-whisper: "
            "python -m pip install faster-whisper"
        ) from error

    return WhisperModel(
        model_name,
        device="cpu",
        compute_type="int8",
        download_root=str(WHISPER_MODELS_DIR),
    )


def transcribe_whisper_chunk(whisper_model, audio_bytes):
    import numpy as np

    audio = np.frombuffer(audio_bytes, dtype="<i2").astype(np.float32) / 32768.0
    segments, _ = whisper_model.transcribe(
        audio,
        language="ru",
        task="transcribe",
        beam_size=1,
        condition_on_previous_text=False,
        vad_filter=True,
    )
    return " ".join(segment.text.strip() for segment in segments).strip()


def load_wav2vec2_model(model_name):
    try:
        import torch
        from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor
    except ImportError as error:
        raise RuntimeError(
            "Для wav2vec2 установи torch и transformers: "
            "python -m pip install torch transformers"
        ) from error

    processor = Wav2Vec2Processor.from_pretrained(
        model_name,
        cache_dir=str(WAV2VEC_MODELS_DIR),
    )
    parametrizations = torch.nn.utils.parametrizations
    parametrized_weight_norm = parametrizations.weight_norm
    del parametrizations.weight_norm
    try:
        loaded_model = Wav2Vec2ForCTC.from_pretrained(
            model_name,
            cache_dir=str(WAV2VEC_MODELS_DIR),
        )
    finally:
        parametrizations.weight_norm = parametrized_weight_norm
    loaded_model.to("cpu")
    loaded_model.eval()
    torch.set_num_threads(min(4, max(1, torch.get_num_threads())))
    return processor, loaded_model


def transcribe_wav2vec2_chunk(wav2vec2_model, audio_bytes):
    import numpy as np
    import torch

    audio = np.frombuffer(audio_bytes, dtype="<i2").astype(np.float32) / 32768.0
    if audio.size == 0 or float(np.sqrt(np.mean(np.square(audio)))) < 0.008:
        return ""

    processor, loaded_model = wav2vec2_model
    inputs = processor(audio, sampling_rate=16000, return_tensors="pt", padding=True)
    with torch.inference_mode():
        logits = loaded_model(
            input_values=inputs.input_values,
            attention_mask=inputs.get("attention_mask"),
        ).logits
    predicted_ids = torch.argmax(logits, dim=-1)
    return processor.batch_decode(predicted_ids)[0].strip()


def load_gigaam_model(model_name):
    try:
        import gigaam
        import torch
        import torchaudio
    except ImportError as error:
        raise RuntimeError(
            "GigaAM не установлена для Python, который запускает сервер. "
            f"Выполни команду: \"{sys.executable}\" -m pip install "
            "git+https://github.com/salute-developers/GigaAM.git. "
            "Также нужны совместимые PyTorch и torchaudio версии 2.6 или новее. "
            "Инструкция: https://github.com/salute-developers/GigaAM#setup"
        ) from error

    def major_minor(version):
        return tuple(int(part) for part in version.split("+", 1)[0].split(".")[:2])

    if major_minor(torch.__version__) < (2, 6) or major_minor(torchaudio.__version__) < (2, 6):
        raise RuntimeError(
            "GigaAM требует PyTorch и torchaudio версии 2.6 или новее. "
            "Установи совместимые сборки по официальной инструкции GigaAM."
        )

    GIGAAM_MODELS_DIR.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(min(4, max(1, torch.get_num_threads())))
    return gigaam.load_model(
        model_name,
        device="cpu",
        download_root=str(GIGAAM_MODELS_DIR),
    )


def transcribe_gigaam_chunk(gigaam_model, audio_bytes):
    import numpy as np
    import torch

    audio = np.frombuffer(audio_bytes, dtype="<i2").astype(np.float32) / 32768.0
    if audio.size == 0 or float(np.sqrt(np.mean(np.square(audio)))) < 0.008:
        return ""

    waveform = torch.from_numpy(audio).unsqueeze(0)
    lengths = torch.tensor([audio.size], dtype=torch.long)
    with torch.inference_mode():
        encoded, encoded_lengths = gigaam_model(waveform, lengths)
        decoded = gigaam_model._decode(encoded, encoded_lengths, lengths)
    return decoded[0][0].strip()


def load_mms_model(model_name):
    try:
        import torch
        from transformers import AutoProcessor, Wav2Vec2ForCTC
    except ImportError as error:
        raise RuntimeError(
            "Для Meta MMS нужны PyTorch и Transformers: "
            "python -m pip install torch transformers"
        ) from error

    processor = AutoProcessor.from_pretrained(model_name, cache_dir=str(MODELS_DIR / "mms"))
    language = "rus"
    processor.tokenizer.set_target_lang(language)
    loaded_model = Wav2Vec2ForCTC.from_pretrained(
        model_name,
        cache_dir=str(MODELS_DIR / "mms"),
    )
    loaded_model.load_adapter(language)
    loaded_model.to("cpu")
    loaded_model.eval()
    torch.set_num_threads(min(4, max(1, torch.get_num_threads())))
    return processor, loaded_model


def transcribe_mms_chunk(mms_model, audio_bytes):
    import numpy as np
    import torch

    audio = np.frombuffer(audio_bytes, dtype="<i2").astype(np.float32) / 32768.0
    if audio.size == 0 or float(np.sqrt(np.mean(np.square(audio)))) < 0.008:
        return ""

    processor, loaded_model = mms_model
    inputs = processor(audio, sampling_rate=16000, return_tensors="pt", padding=True)
    with torch.inference_mode():
        logits = loaded_model(
            input_values=inputs.input_values,
            attention_mask=inputs.get("attention_mask"),
        ).logits
    predicted_ids = torch.argmax(logits, dim=-1)
    return processor.batch_decode(predicted_ids)[0].strip()


def load_nemo_model(model_name, progress):
    try:
        import nemo.collections.asr as nemo_asr
    except ImportError as error:
        raise RuntimeError(
            "Для NVIDIA NeMo установи NeMo ASR в Python сервера: "
            f"\"{sys.executable}\" -m pip install \"nemo_toolkit[asr]\""
        ) from error

    model_path = download_nemo_model(model_name, progress)
    loaded_model = nemo_asr.models.EncDecCTCModelBPE.restore_from(
        restore_path=str(model_path),
        map_location="cpu",
    )
    loaded_model.eval()
    return loaded_model


def download_nemo_model(model_name, progress):
    nemo_models_dir = MODELS_DIR / "nemo"
    nemo_models_dir.mkdir(parents=True, exist_ok=True)
    model_path = nemo_models_dir / f"{model_name}.nemo"
    if model_path.is_file():
        size = model_path.stat().st_size
        progress(100, size, size, "load")
        return model_path

    model_url = f"https://huggingface.co/nvidia/{model_name}/resolve/main/{model_name}.nemo"
    request = urllib.request.Request(
        model_url,
        headers={"User-Agent": "BetterDiscord-Microphone/1.5"},
    )
    with tempfile.TemporaryDirectory(prefix=f".{model_name}-", dir=nemo_models_dir) as temporary:
        temporary_path = Path(temporary) / f"{model_name}.nemo"
        with urllib.request.urlopen(request, timeout=60) as response:
            total_size = int(response.headers.get("Content-Length", "0"))
            downloaded = 0
            last_percent = -1
            progress(0 if total_size else None, 0, total_size, "download")
            with temporary_path.open("wb") as model_file:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    model_file.write(chunk)
                    downloaded += len(chunk)
                    if total_size:
                        percent = min(99, downloaded * 100 // total_size)
                        if percent >= last_percent + 1:
                            progress(percent, downloaded, total_size, "download")
                            last_percent = percent
                    elif downloaded == len(chunk) or downloaded % (5 * 1024 * 1024) < len(chunk):
                        progress(None, downloaded, 0, "download")
            if total_size and downloaded != total_size:
                raise OSError(
                    f"NeMo model download ended early: received {downloaded} of {total_size} bytes"
                )
        temporary_path.replace(model_path)
    progress(100, downloaded, total_size, "load")
    return model_path


def transcribe_nemo_chunk(nemo_model, audio_bytes):
    import os
    import tempfile
    import wave

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as audio_file:
        audio_path = audio_file.name
    try:
        with wave.open(audio_path, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(16000)
            wav_file.writeframes(audio_bytes)
        results = nemo_model.transcribe([audio_path], batch_size=1)
    finally:
        os.unlink(audio_path)

    result = results[0]
    return (result.text if hasattr(result, "text") else str(result)).strip()


async def load_catalog_model(websocket, model_id):
    global model, model_path, model_id_active, model_engine
    if not isinstance(model_id, str) or model_id not in MODEL_CATALOG:
        await websocket.send(json.dumps({"type": "error", "message": "Неизвестная модель в каталоге."}))
        return None

    async def run_with_download_progress(function, *args):
        loop = asyncio.get_running_loop()
        progress_queue = asyncio.Queue()

        def report_progress(percent, downloaded, total, phase):
            loop.call_soon_threadsafe(
                progress_queue.put_nowait,
                {
                    "percent": percent,
                    "downloaded": downloaded,
                    "total": total,
                    "phase": phase,
                },
            )

        download_task = asyncio.create_task(
            asyncio.to_thread(function, *args, report_progress)
        )

        async def send_progress(progress):
            await websocket.send(json.dumps({
                "type": "download_progress",
                **progress,
            }))

        while not download_task.done():
            try:
                await send_progress(await asyncio.wait_for(progress_queue.get(), timeout=0.5))
            except asyncio.TimeoutError:
                continue
        while not progress_queue.empty():
            await send_progress(progress_queue.get_nowait())
        return await download_task

    try:
        async with install_lock:
            model_info = MODEL_CATALOG[model_id]
            engine = model_info.get("engine", "vosk")
            if getattr(sys, "frozen", False) and engine != "vosk":
                raise RuntimeError("Переносной .exe поддерживает модели Vosk. Для Whisper и других движков запустите Python-версию через stt_install.bat и установите нужный движок.")
            if engine == "whisper":
                await websocket.send(json.dumps({
                    "type": "download_progress",
                    "percent": None,
                    "phase": "download",
                    "message": f"Загрузка {model_info['name']} ({model_info['size']}) с Hugging Face. При первом запуске подожди.",
                }))
                loaded_model = await asyncio.to_thread(load_whisper_model, model_info["model"])
            elif engine == "wav2vec2":
                await websocket.send(json.dumps({
                    "type": "download_progress",
                    "percent": None,
                    "phase": "download",
                    "message": f"Загрузка {model_info['name']} ({model_info['size']}) с Hugging Face. Первое скачивание может занять время.",
                }))
                loaded_model = await asyncio.to_thread(load_wav2vec2_model, model_info["model"])
            elif engine == "gigaam":
                await websocket.send(json.dumps({
                    "type": "download_progress",
                    "percent": None,
                    "phase": "download",
                    "message": f"Загрузка {model_info['name']} ({model_info['size']}). При первом запуске скачиваются файлы модели.",
                }))
                loaded_model = await asyncio.to_thread(load_gigaam_model, model_info["model"])
            elif engine == "mms":
                await websocket.send(json.dumps({
                    "type": "download_progress",
                    "percent": None,
                    "phase": "download",
                    "message": f"Загрузка {model_info['name']} ({model_info['size']}). MMS — большая мультиязычная модель; первое скачивание может занять время.",
                }))
                loaded_model = await asyncio.to_thread(load_mms_model, model_info["model"])
            elif engine == "nemo":
                await websocket.send(json.dumps({
                    "type": "download_progress",
                    "percent": None,
                    "phase": "download",
                    "message": f"Загрузка {model_info['name']} ({model_info['size']}) через NVIDIA NeMo.",
                }))
                loaded_model = await run_with_download_progress(load_nemo_model, model_info["model"])
            elif engine == "vosk":
                await websocket.send(json.dumps({
                    "type": "download_progress",
                    "percent": None,
                    "phase": "download",
                    "message": f"Подключение к загрузке {model_info['name']}...",
                }))
            else:
                raise ValueError(f"Unsupported speech engine: {engine}")

            if engine == "vosk":
                downloaded_path = await run_with_download_progress(download_and_extract, model_id)
                await websocket.send(json.dumps({
                    "type": "download_progress",
                    "percent": 100,
                    "phase": "load",
                    "message": f"Загрузка файлов завершена. Открываю {model_info['name']}...",
                }))
                loaded_model = await asyncio.to_thread(Model, str(downloaded_path))
                model_path = downloaded_path
            else:
                model_path = Path(model_info["model"])
            model_engine = engine
            model = loaded_model
            model_id_active = model_id
            await asyncio.to_thread(save_installed_model, model_id)
            await websocket.send(json.dumps({
                "type": "model_loaded",
                "id": model_id,
                "path": str(model_path),
                "name": model_info["name"],
                "installed_models": get_installed_model_ids(),
            }))
            return engine, model
    except Exception as error:
        await websocket.send(json.dumps({"type": "error", "message": f"Не удалось установить модель: {error}"}))
        return None


async def recognize(websocket):
    global model, model_path, model_id_active
    active_engine = model_engine
    active_model = model
    recognizer = KaldiRecognizer(model, 16000) if model is not None and active_engine == "vosk" else None
    whisper_buffer = bytearray()
    await websocket.send(json.dumps({
        "type": "ready",
        "catalog_version": CATALOG_VERSION,
        "path": str(model_path) if model_path else None,
        "model_id": model_id_active,
    }))
    async for message in websocket:
        if isinstance(message, str):
            try:
                command = json.loads(message)
            except json.JSONDecodeError:
                continue
            if not isinstance(command, dict):
                continue
            if command.get("type") == "list_models":
                try:
                    await websocket.send(json.dumps({
                        "type": "installed_models",
                        "ids": get_installed_model_ids(),
                    }))
                except (OSError, ValueError, RuntimeError) as error:
                    logging.exception("Failed to list installed speech models")
                    await websocket.send(json.dumps({
                        "type": "error",
                        "message": str(error),
                    }))
                continue
            if command.get("type") == "install_model":
                loaded = await load_catalog_model(websocket, command.get("id"))
                if loaded is not None:
                    active_engine, active_model = loaded
                    recognizer = KaldiRecognizer(active_model, 16000) if active_engine == "vosk" else None
                    whisper_buffer.clear()
            continue

        if not isinstance(message, bytes):
            continue

        if active_engine in ("whisper", "wav2vec2", "gigaam", "mms", "nemo") and active_model is not None:
            chunk_sizes = {
                "whisper": WHISPER_CHUNK_BYTES,
                "wav2vec2": WAV2VEC_CHUNK_BYTES,
                "gigaam": GIGAAM_CHUNK_BYTES,
                "mms": MMS_CHUNK_BYTES,
                "nemo": NEMO_CHUNK_BYTES,
            }
            chunk_size = chunk_sizes[active_engine]
            whisper_buffer.extend(message)
            while len(whisper_buffer) >= chunk_size:
                audio_chunk = bytes(whisper_buffer[:chunk_size])
                del whisper_buffer[:chunk_size]
                try:
                    if active_engine == "whisper":
                        text = await asyncio.to_thread(transcribe_whisper_chunk, active_model, audio_chunk)
                    elif active_engine == "wav2vec2":
                        text = await asyncio.to_thread(transcribe_wav2vec2_chunk, active_model, audio_chunk)
                    elif active_engine == "gigaam":
                        text = await asyncio.to_thread(transcribe_gigaam_chunk, active_model, audio_chunk)
                    elif active_engine == "mms":
                        text = await asyncio.to_thread(transcribe_mms_chunk, active_model, audio_chunk)
                    else:
                        text = await asyncio.to_thread(transcribe_nemo_chunk, active_model, audio_chunk)
                except Exception as error:
                    logging.exception("%s transcription failed", active_engine)
                    await websocket.send(json.dumps({
                        "type": "error",
                        "message": f"Ошибка {active_engine}: {error}",
                    }))
                    active_engine = None
                    break
                if text:
                    await websocket.send(json.dumps({"text": text, "final": True}))
            continue

        if active_engine != "vosk" or recognizer is None:
            continue

        if recognizer.AcceptWaveform(message):
            result = json.loads(recognizer.Result())
            if result.get("text"):
                await websocket.send(json.dumps({"text": result["text"], "final": True}))
        else:
            result = json.loads(recognizer.PartialResult())
            if result.get("partial"):
                await websocket.send(json.dumps({"text": result["partial"], "final": False}))


def open_dashboard():
    import webbrowser

    webbrowser.open(f"http://127.0.0.1:{SUBTITLE_PORT}/")


def run_dashboard():
    """Small native status window. Closing it leaves the server running."""
    import tkinter as tk
    from concurrent.futures import ThreadPoolExecutor

    root = tk.Tk()
    root.title("STT · Запуск и автозагрузка")
    root.configure(bg="#10131e")
    root.geometry("800x200")
    root.minsize(700, 200)
    root.resizable(True, False)
    root.option_add("*Font", ("Segoe UI", 10))
    content = tk.Frame(root, bg="#10131e")
    content.pack(fill="both", expand=True, padx=20, pady=(16, 8))
    content.columnconfigure(0, weight=1)
    content.columnconfigure(1, minsize=415)
    tk.Label(content, text="Запуск и автозагрузка", fg="#f3f4ff", bg="#10131e", font=("Segoe UI", 14, "bold")).grid(row=0, column=0, sticky="nw", pady=1)
    tk.Label(content, text="Сервер речи и субтитров", fg="#8997af", bg="#10131e", font=("Segoe UI", 9)).grid(row=1, column=0, sticky="nw", pady=(0, 4))
    services = tk.Frame(content, bg="#10131e")
    services.grid(row=0, column=1, rowspan=4, sticky="ne")
    canvases = {}
    for row, (key, title) in enumerate((("stt", "stt_server.py"), ("tailscale", "Tailscale"), ("subtitles", "Субтитры"))):
        tk.Label(services, text=title, fg="#9ad8e5", bg="#10131e", font=("Segoe UI", 10, "bold")).grid(row=row, column=0, sticky="e", padx=(0, 12), pady=3)
        canvas = tk.Canvas(services, width=280, height=26, bg="#10131e", highlightthickness=0)
        canvas.grid(row=row, column=1, pady=3)
        canvases[key] = canvas

    def paint(key, state, text):
        canvas = canvases[key]
        canvas.delete("all")
        foreground, background, border = {
            "active": ("#80dec0", "#16302b", "#305b50"),
            "inactive": ("#ffa2b0", "#331e2b", "#694052"),
            "unknown": ("#e8bf69", "#302818", "#6e5930"),
        }.get(state, ("#b6c2d8", "#222939", "#49516a"))
        canvas.create_polygon(13, 1, 267, 1, 279, 1, 279, 13, 279, 25, 267, 25, 13, 25, 1, 25, 1, 13, 1, 1, smooth=True, fill=background, outline=border)
        canvas.create_oval(10, 11, 14, 15, fill=foreground, outline="")
        canvas.create_text(22, 13, text=text, anchor="w", fill=foreground, font=("Segoe UI", 9), width=250)

    for key in canvases:
        paint(key, "unknown", "Проверка…")
    feedback = tk.StringVar(value="")
    feedback_label = tk.Label(content, textvariable=feedback, fg="#e8bf69", bg="#10131e", font=("Segoe UI", 8), anchor="w")
    feedback_label.grid(row=4, column=0, columnspan=2, sticky="ew", pady=(6, 0))
    footer = tk.Frame(root, bg="#10131e")
    footer.pack(fill="x", padx=20, pady=(0, 10))
    tk.Label(footer, text=f"Версия {SERVER_VERSION}", fg="#a6b1c4", bg="#10131e", font=("Segoe UI", 8, "bold")).pack(side="left")
    executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="dashboard")
    pending = None
    next_refresh = 0.0
    closed = False
    startup_enabled = None

    def refresh():
        nonlocal next_refresh
        nonlocal next_update
        next_update = 0.0
        next_refresh = 0.0

    def toggle_startup():
        try:
            set_autostart(startup_enabled is not True)
            refresh()
        except (OSError, RuntimeError) as error:
            feedback.set(str(error)[:120])

    button_options = {"bg": "#1c2435", "fg": "#b8cbe4", "activebackground": "#2b3851", "activeforeground": "#ffffff", "relief": "flat", "bd": 0, "padx": 10, "pady": 4, "cursor": "hand2", "font": ("Segoe UI", 9)}
    startup_button = tk.Button(content, text="Автозагрузка…", command=toggle_startup, state="disabled", **button_options)
    startup_button.grid(row=2, column=0, sticky="nw", pady=(3, 0))
    release_url = [None]
    update_pending = None
    next_update = 0.0

    def open_release():
        if release_url[0]:
            try:
                run_component_update(install=True)
                release_button.configure(state="disabled")
                feedback.set("Обновление загружается. Сервер перезапустится автоматически.")
            except (OSError, RuntimeError) as error:
                feedback.set(str(error)[:120])

    release_button = tk.Button(footer, text="Установить", command=open_release, state="disabled", **button_options)
    release_button.pack(side="right")
    tk.Button(footer, text="Обновить ↻", command=refresh, **button_options).pack(side="right", padx=(0, 6))

    def read_status():
        with urllib.request.urlopen(f"http://127.0.0.1:{SUBTITLE_PORT}/status", timeout=6) as response:
            return json.load(response)

    def poll():
        nonlocal pending, next_refresh, startup_enabled, update_pending, next_update
        if closed:
            return
        if pending is not None and pending.done():
            try:
                data = pending.result()
                statuses = data["services"]
                startup = statuses.get("startup", {})
                startup_enabled = startup.get("state") == "active"
                for key in canvases:
                    value = statuses[key]
                    text = value["text"]
                    if key == "stt":
                        text += " · автозагрузка: " + ("вкл." if startup_enabled else "выкл." if startup.get("state") == "inactive" else "?")
                    paint(key, value["state"], text)
                startup_button.configure(text="Отключить автозагрузку" if startup_enabled else "Включить автозагрузку", state="normal")
                if data.get("message"):
                    feedback.set(data["message"][:120])
            except Exception as error:
                for key in canvases:
                    paint(key, "inactive" if key == "stt" else "unknown", "Нет связи с сервером" if key == "stt" else "Не удалось проверить")
                if isinstance(error, urllib.error.HTTPError):
                    message = f"Сервер ответил с ошибкой HTTP {error.code}. Перезапустите сервер. Подробнее: stt_server.log"
                else:
                    message = startup_error or "Ожидание запуска сервера… Подробнее: stt_server.log"
                feedback.set(message[:120])
            pending = None
            next_refresh = time.monotonic() + 10
        if update_pending is not None and update_pending.done():
            try:
                update = update_pending.result()
                release_url[0] = update.get("url") if update.get("state") == "active" else None
                release_button.configure(state="normal" if release_url[0] else "disabled")
                feedback.set(update.get("message", "")[:120])
            except Exception as error:
                feedback.set(f"Обновления: {error}"[:120])
            update_pending = None
            next_update = time.monotonic() + UPDATE_CHECK_TTL
        if update_pending is None and time.monotonic() >= next_update:
            update_pending = executor.submit(check_for_update, True)
        if pending is None and time.monotonic() >= next_refresh:
            pending = executor.submit(read_status)
        root.after(200, poll)

    def close():
        nonlocal closed
        closed = True
        executor.shutdown(wait=False, cancel_futures=True)
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", close)
    poll()
    root.mainloop()


def load_runtime():
    global websockets, KaldiRecognizer, Model, MODEL_CATALOG
    try:
        import websockets as websocket_module
        from vosk import KaldiRecognizer as recognizer_class, Model as model_class, SetLogLevel
    except ImportError as error:
        raise RuntimeError("Нет Python-зависимостей. Запустите stt_install.bat или используйте готовый stt_server.exe из архива.") from error
    websockets, KaldiRecognizer, Model = websocket_module, recognizer_class, model_class
    SetLogLevel(-1)
    try:
        entries = json.loads(CATALOG_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise RuntimeError("Рядом с сервером отсутствует vosk_models.json. Распакуйте весь архив, а не только .bat и .py.") from error
    if not isinstance(entries, list) or not entries or any(not isinstance(entry, dict) or not isinstance(entry.get("id"), str) for entry in entries):
        raise ValueError("Некорректный каталог vosk_models.json")
    MODEL_CATALOG = {entry["id"]: entry for entry in entries}
    if len(MODEL_CATALOG) != len(entries):
        raise ValueError("В vosk_models.json повторяются идентификаторы моделей")


def acquire_server_mutex():
    if sys.platform != "win32":
        return True
    import ctypes
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateMutexW.argtypes = (ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR)
    kernel.CreateMutexW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    handle = kernel.CreateMutexW(None, False, f"Local\\VoiceStudioSTT-{PORT}-{SUBTITLE_PORT}")
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    if ctypes.get_last_error() == 183:
        kernel.CloseHandle(handle)
        return False
    # Hold the handle until process exit, including while the dashboard is closed.
    global server_mutex_handle
    server_mutex_handle = handle
    return True


async def serve(enable_stt=True, enable_subtitles=True, dashboard=False, initial_model=None):
    global model, model_path, model_id_active, startup_error
    async def handle_client(websocket, _path=None):
        await recognize(websocket)

    servers = []
    try:
        if enable_stt:
            servers.append(await websockets.serve(handle_client, HOST, PORT, max_size=1024 * 1024, max_queue=64))
            logging.info("Local model catalog is ready at ws://%s:%s", HOST, PORT)
        if enable_subtitles:
            servers.append(await asyncio.start_server(
                handle_subtitle_http,
                SUBTITLE_HOST,
                SUBTITLE_PORT,
                limit=16 * 1024,
            ))
            logging.info("Subtitle relay is ready at http://%s:%s", SUBTITLE_HOST, SUBTITLE_PORT)
        if dashboard:
            await asyncio.to_thread(open_dashboard)
        if enable_stt and initial_model is not None:
            try:
                loaded_model = await asyncio.to_thread(Model, str(initial_model))
                # A plugin may have selected another model while the default was loading.
                if model is None:
                    model, model_path, model_id_active = loaded_model, initial_model, initial_model.name
            except Exception:
                startup_error = "Не удалось открыть модель. Выберите или скачайте модель в плагине Microphone."
                logging.exception("Default model could not be loaded; keeping the server available")
        await asyncio.Future()
    finally:
        for server in servers:
            server.close()
        await asyncio.gather(*(server.wait_closed() for server in servers))


def main():
    global PORT, SUBTITLE_PORT, model_path, model, model_id_active, model_engine, startup_error
    parser = argparse.ArgumentParser()
    parser.add_argument("model_path", nargs="?", type=Path, default=None)
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--http-port", type=int, default=SUBTITLE_PORT)
    parser.add_argument("--dashboard", action="store_true", help="Открыть компактное окно состояния")
    parser.add_argument("--background", action="store_true", help="Работать в фоне без окна")
    parser.add_argument("--web", action="store_true", help="Открыть панель в браузере")
    parser.add_argument("--check", action="store_true", help="Проверить зависимости и каталог без запуска сервера")
    args = parser.parse_args()
    PORT = args.port
    SUBTITLE_PORT = args.http_port
    if not 1 <= PORT <= 65535 or not 1 <= SUBTITLE_PORT <= 65535 or PORT == SUBTITLE_PORT:
        parser.error("Порты должны отличаться и находиться в диапазоне 1–65535")
    if args.check:
        load_runtime()
        if sys.stdout:
            print(f"OK: STT {SERVER_VERSION}, Python {sys.version.split()[0]}, models: {len(MODEL_CATALOG)}")
        return 0

    stt_already_running = is_port_in_use(HOST, PORT)
    subtitle_service_already_running = is_port_in_use("127.0.0.1", SUBTITLE_PORT)
    if stt_already_running and subtitle_service_already_running:
        logging.info("STT and subtitle services are already running; exiting duplicate.")
        if args.web:
            open_dashboard()
        elif not args.background:
            run_dashboard()
        return 0
    if stt_already_running:
        logging.info("STT is already running; starting the subtitle relay only.")

    model_path = None
    model = None
    model_id_active = None
    model_engine = "vosk"
    service_thread = None
    owns_server = acquire_server_mutex()
    if owns_server:
        load_runtime()
        initial_model = args.model_path or MODELS_DIR / "vosk-model-small-ru-0.22"
        if not is_model_folder(initial_model):
            initial_model = None

        def run_services():
            global startup_error
            try:
                asyncio.run(serve(enable_stt=not stt_already_running, enable_subtitles=not subtitle_service_already_running, dashboard=args.web, initial_model=initial_model))
            except Exception as error:
                startup_error = str(error)
                logging.exception("STT server stopped unexpectedly")
                if args.background or args.web:
                    raise

        if args.background or args.web:
            run_services()
        else:
            service_thread = threading.Thread(target=run_services, name="stt-server", daemon=False)
            service_thread.start()
    if not args.background and not args.web:
        try:
            run_dashboard()
        finally:
            if service_thread is not None:
                # SystemExit starts concurrent.futures' global shutdown before Python
                # waits for non-daemon threads. Keep main alive while services use
                # asyncio.to_thread, including after the user closes the window.
                service_thread.join()
    return 0


if __name__ == "__main__":
    try:
        exit_code = main()
    except Exception as error:
        logging.exception("STT startup failed")
        if sys.stderr:
            print(f"STT: {error}\nПодробности: {LOG_FILE}", file=sys.stderr)
        if sys.platform == "win32" and "--background" not in sys.argv and "--check" not in sys.argv:
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, f"{error}\n\nПодробности: {LOG_FILE}", "STT · Ошибка запуска", 0x10)
        exit_code = 1
    raise SystemExit(exit_code)

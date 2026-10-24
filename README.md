# Voice Studio STT

Речь в текст и субтитры в Discord через Tailscale.

[Скачать последнюю версию](https://github.com/sakleam1414/VoiceStudio-STT/releases/latest)

## Установка

1. Скачайте `STT-for-friend-*.zip` в Releases и распакуйте целиком в папку BetterDiscord `plugins`.
2. Запустите `stt_server.exe` и Tailscale на каждом компьютере.
3. На ПК говорящего включите **Microphone**; на принимающем ПК — **Subtitles**.
4. Выберите говорящих в панели участников Subtitles.

Python не нужен для готового EXE. EXE содержит Vosk; дополнительные движки устанавливаются через Python отдельно. Модели скачиваются при первом выборе.

## Обновление у друга

Проверка выполняется при запуске и каждые 6 часов. В панели плагина нажмите **Проверить обновление**, затем **Установить обновление**. В окне сервера доступны **Обновить ↻** и **Установить**. Плагин скачает только свой компонент и его каталоги. Сервер заменит Python/EXE и перезапустится, если работал.

Перед заменой проверяется SHA256 всех файлов. Предыдущая копия сохраняется в `.stt-update-backup`. Если установка не удалась, заменённые файлы восстанавливаются. Настройки `*.config.json`, модели и история не входят в обновление. При ошибке сети остаётся установленная версия. Если BetterDiscord не перезагрузил плагин сам, выключите и включите его.

## Как выпустить новую версию

`VERSION.json` — единственное место, где задаются версии релиза и компонентов. Пример следующего обновления только Microphone:

```powershell
python tools/release.py --release 1.5.3 --microphone 2.5.0
```

Скрипт сам изменит `@version` и версию в интерфейсе Microphone. Для сервера используйте `--server`, для Subtitles — `--subtitles`. Меняется номер вместе с исправленным кодом. Один номер без нового кода не добавляет исправлений.

Проверьте изменения и отправьте commit с тегом:

```powershell
git add .
git commit -m "Update Microphone"
git push origin main
git tag v1.5.3
git push origin v1.5.3
```

GitHub Actions на Windows соберёт EXE, ZIP, отдельные файлы и `update-manifest.json`, затем опубликует Release. У клиентов будет отображаться `Microphone 2.4.1 → 2.5.0`; версии остальных компонентов не меняются. Публикация обновления — отправка тега, она не происходит при обычном редактировании файла.

Для локальной сборки:

```powershell
python -m pip install -r stt_requirements.txt pyinstaller==6.21.0
./tools/build-exe.ps1
```

Результат находится в `release/`. Источник релизов задаётся в `stt_update.json`.

## Разработка

```powershell
python -m py_compile stt_server.py tools/release.py
node --check microphone.plugin.js
node --check subtitles.plugin.js
node --check stt_updates.js
```

Личные конфиги, логи, модели, EXE и ZIP не отправляются в Git. Готовые бинарные файлы размещаются в Releases.

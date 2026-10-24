param([string]$Python = 'python')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$buildRoot = Join-Path $projectRoot 'build'
& $Python -m PyInstaller --noconfirm --clean --onefile --windowed --name stt_server `
  --distpath (Join-Path $buildRoot 'dist') --workpath (Join-Path $buildRoot 'work') --specpath $buildRoot `
  --add-data "${projectRoot}\vosk_models.json;." --collect-all vosk --hidden-import _cffi_backend `
  --exclude-module torch --exclude-module torchaudio --exclude-module transformers --exclude-module faster_whisper `
  --exclude-module gigaam --exclude-module nemo --exclude-module numpy --exclude-module scipy --exclude-module pandas `
  --exclude-module matplotlib --exclude-module tensorflow --exclude-module IPython (Join-Path $projectRoot 'stt_server.py')
if ($LASTEXITCODE -ne 0) { throw 'EXE build failed' }
& $Python (Join-Path $PSScriptRoot 'release.py') --exe (Join-Path $buildRoot 'dist\stt_server.exe')
if ($LASTEXITCODE -ne 0) { throw 'Release verification failed' }

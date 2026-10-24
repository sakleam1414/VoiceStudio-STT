$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'stt_updater.ps1') -LibraryOnly
$testRoot = Join-Path $env:TEMP ('stt-update-test-' + [guid]::NewGuid().ToString('N'))
$installed = Join-Path $testRoot 'installed'
$stage = Join-Path $testRoot 'stage'
New-Item -ItemType Directory -Force -Path $installed,$stage | Out-Null
[IO.File]::WriteAllText((Join-Path $installed 'microphone.plugin.js'), '/** @version 2.3.0 */ old')
[IO.File]::WriteAllText((Join-Path $stage 'microphone.plugin.js'), '/** @version 2.4.0 */ new')
$file = @{name='microphone.plugin.js';sha256=(Get-FileHash (Join-Path $stage 'microphone.plugin.js')).Hash}
$manifest = @{schema=1;components=@{microphone=@{version='2.4.0';files=@($file)}}}
$backup = Install-StagedFiles $installed $stage @(Get-CheckedFiles $manifest 'microphone')
if ((Get-ComponentVersion $installed 'microphone') -ne [version]'2.4.0') {throw 'Install failed'}
if ((Get-ComponentVersion $backup 'microphone') -ne [version]'2.3.0') {throw 'Backup failed'}
$file.sha256 = '0'*64
try {Install-StagedFiles $installed $stage @($file); throw 'Bad hash accepted'} catch {if ($_.Exception.Message -eq 'Bad hash accepted') {throw}}
$file.name='../escape.js'
try {Get-CheckedFiles $manifest 'microphone'; throw 'Traversal accepted'} catch {if ($_.Exception.Message -eq 'Traversal accepted') {throw}}
[IO.File]::WriteAllText((Join-Path $stage 'microphone.plugin.js'), '/** @version 2.5.0 */ next')
[IO.File]::WriteAllText((Join-Path $installed 'vosk_models.json'), 'old-catalog')
[IO.File]::WriteAllText((Join-Path $stage 'vosk_models.json'), 'new-catalog')
$files=@('microphone.plugin.js','vosk_models.json') | ForEach-Object {@{name=$_;sha256=(Get-FileHash (Join-Path $stage $_)).Hash}}
$locked = [IO.File]::Open((Join-Path $installed 'vosk_models.json'), 'Open', 'Read', 'None')
try {try {Install-StagedFiles $installed $stage $files; throw 'Lock accepted'} catch {if ($_.Exception.Message -eq 'Lock accepted') {throw}}} finally {$locked.Dispose()}
if ((Get-ComponentVersion $installed 'microphone') -ne [version]'2.4.0') {throw 'Rollback failed'}
Write-Output 'PASS: install, backup, SHA256 rejection, traversal rejection, locked-file rollback'

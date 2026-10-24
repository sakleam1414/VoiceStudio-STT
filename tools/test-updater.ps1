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

# One click must select only obsolete components and deduplicate shared files.
[IO.File]::WriteAllText((Join-Path $installed 'stt_server.py'), 'SERVER_VERSION = "1.8.0"')
[IO.File]::WriteAllText((Join-Path $installed 'subtitles.plugin.js'), '/** @version 1.9.0 */ current')
[IO.File]::WriteAllText((Join-Path $installed 'microphone.plugin.js'), '/** @version 1.4.0 */ old')
$shared=@{name='stt_updates.js';sha256=('a'*64)}
$manifest=@{schema=1;components=@{
    server=@{version='1.8.0';files=@(@{name='stt_server.py';sha256=('b'*64)},@{name='stt_server.exe';sha256=('c'*64)})}
    subtitles=@{version='1.9.0';files=@(@{name='subtitles.plugin.js';sha256=('d'*64)},$shared)}
    microphone=@{version='2.7.0';files=@(@{name='microphone.plugin.js';sha256=('e'*64)},$shared)}
}}
$plan=Get-UpdatePlan $installed $manifest 'all'
if (-not $plan.available -or $plan.components.server.available -or $plan.components.subtitles.available -or -not $plan.components.microphone.available) {throw 'Wrong update selection'}
if ((@($plan.files.name) | Sort-Object) -join ',' -ne 'microphone.plugin.js,stt_updates.js') {throw 'Current components were not skipped'}
$manifest.components.subtitles.version='1.10.0'
$plan=Get-UpdatePlan $installed $manifest 'all'
if (@($plan.files | Where-Object name -eq 'stt_updates.js').Count -ne 1) {throw 'Shared files not deduplicated'}
$manifest.components.subtitles.files[1]=@{name='stt_updates.js';sha256=('f'*64)}
try {Get-UpdatePlan $installed $manifest 'all'; throw 'Conflicting hashes accepted'} catch {if ($_.Exception.Message -eq 'Conflicting hashes accepted') {throw}}
Write-Output 'PASS: all-component plan, outdated-only selection, current server/Subtitles skipped, shared deduplication and conflict rejection'

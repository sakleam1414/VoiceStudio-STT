param(
    [string]$Directory = $PSScriptRoot,
    [ValidateSet('server','microphone','subtitles','all')][string]$Component = 'server',
    [string]$Repository = 'sakleam1414/VoiceStudio-STT',
    [switch]$Install,
    [switch]$LibraryOnly
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
# Electron or PowerShell 7 can pass a module path that hides Windows PowerShell 5 builtins.
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + [IO.Path]::PathSeparator + $env:PSModulePath

function Get-ComponentVersion([string]$Root, [string]$Name) {
    $file = @{server='stt_server.py';microphone='microphone.plugin.js';subtitles='subtitles.plugin.js'}[$Name]
    if (-not [IO.File]::Exists((Join-Path $Root $file))) { return [version]'0.0.0' }
    $text = [IO.File]::ReadAllText((Join-Path $Root $file))
    $pattern = if ($Name -eq 'server') {'SERVER_VERSION\s*=\s*"(\d+\.\d+\.\d+)"'} else {'@version\s+(\d+\.\d+\.\d+)'}
    if ($text -notmatch $pattern) { throw "Version not found: $file" }
    return [version]$Matches[1]
}

function Get-CheckedFiles($Manifest, [string]$Name) {
    $allowed = @{
        server=@('stt_server.py','stt_server.exe','stt_server.bat','stt_requirements.txt','stt_install.bat','stt_updater.ps1','stt_updates.js','stt_update.json')
        microphone=@('microphone.plugin.js','vosk_models.json','stt_engines.json','stt_updater.ps1','stt_updates.js','stt_update.json')
        subtitles=@('subtitles.plugin.js','stt_updater.ps1','stt_updates.js','stt_update.json')
    }
    if ($Manifest.schema -ne 1) { throw 'Unsupported update manifest' }
    $entry = $Manifest.components.$Name
    if (-not $entry -or -not ($entry.version -match '^\d+\.\d+\.\d+$')) { throw "Invalid component: $Name" }
    $files = @($entry.files)
    if (-not $files.Count) { throw 'Empty update' }
    $seen = @{}
    foreach ($file in $files) {
        if ($file.name -notin $allowed[$Name] -or $seen.ContainsKey($file.name)) { throw 'Unexpected update file' }
        if ($file.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid SHA256' }
        $seen[$file.name] = $true
    }
    $required = @{server=@('stt_server.py','stt_server.exe');microphone=@('microphone.plugin.js');subtitles=@('subtitles.plugin.js')}[$Name]
    foreach ($name in $required) { if (-not $seen.ContainsKey($name)) { throw "Missing update file: $name" } }
    return $files
}

function Install-StagedFiles([string]$Root, [string]$Stage, $Files) {
    $backup = Join-Path $Root ('.stt-update-backup\' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    $changed = [Collections.Generic.List[object]]::new()
    try {
        # Check every download before touching any installed file.
        foreach ($file in $Files) {
            $path = Join-Path $Stage $file.name
            if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $file.sha256) { throw "SHA256 mismatch: $($file.name)" }
        }
        foreach ($file in $Files) {
            $target = Join-Path $Root $file.name
            $saved = Join-Path $backup $file.name
            $exists = [IO.File]::Exists($target)
            if ($exists) { [IO.File]::Copy($target, $saved, $true) }
            $temporary = Join-Path $Root ('.stt-update-' + [guid]::NewGuid().ToString('N'))
            [IO.File]::Copy((Join-Path $Stage $file.name), $temporary, $true)
            try {
                if ($exists) { [IO.File]::Replace($temporary, $target, ($saved+'.replaced')) }
                else { [IO.File]::Move($temporary, $target) }
            } finally {
                if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
            }
            $changed.Add(@{target=$target;saved=$saved;existed=$exists})
        }
    } catch {
        $failure = $_
        for ($index=$changed.Count-1; $index -ge 0; $index--) {
            $item = $changed[$index]
            if ($item.existed) { [IO.File]::Copy($item.saved, $item.target, $true) }
            elseif ([IO.File]::Exists($item.target)) { [IO.File]::Delete($item.target) }
        }
        throw $failure
    }
    return $backup
}

function Get-UpdatePlan([string]$Root, $Manifest, [string]$Selection) {
    $names = if ($Selection -eq 'all') { @('server','microphone','subtitles') } else { @($Selection) }
    $components = @{}
    $files = @{}
    foreach ($name in $names) {
        $checked = @(Get-CheckedFiles $Manifest $name)
        $local = Get-ComponentVersion $Root $name
        $remote = [version]$Manifest.components.$name.version
        $available = $remote -gt $local
        $components[$name] = @{current="$local";version="$remote";available=$available}
        if (-not $available) { continue }
        foreach ($file in $checked) {
            if ($files.ContainsKey($file.name) -and $files[$file.name].sha256 -ne $file.sha256) { throw 'Conflicting shared file hashes' }
            $files[$file.name] = $file
        }
    }
    return @{components=$components;files=@($files.Values);available=($files.Count -gt 0)}
}

function Get-ArchiveRelease($Release, [string]$Repo) {
    $match = [regex]::Match([string]$Release.body, '(?s)<!-- voice-studio-manifest\s*(\{.*?\})\s*-->')
    if (-not $match.Success) { throw 'Release has no ZIP update metadata' }
    $manifest = $match.Groups[1].Value | ConvertFrom-Json
    if ($manifest.schema -ne 1 -or $manifest.archive.name -notmatch '^STT-for-friend-\d+\.\d+\.\d+\.zip$' -or $manifest.archive.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid ZIP update metadata' }
    $assets = @($Release.assets | Where-Object name -eq $manifest.archive.name)
    $expected = "https://github.com/$Repo/releases/download/$($Release.tag_name)/$($manifest.archive.name)"
    if ($assets.Count -ne 1 -or $assets[0].browser_download_url -ne $expected) { throw 'Release ZIP is missing' }
    return @{manifest=$manifest;url=$expected}
}

function Expand-CheckedArchive([string]$Archive, [string]$Stage, $Files, [string]$ExpectedHash) {
    if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ne $ExpectedHash) { throw 'ZIP SHA256 mismatch' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        # Read only whitelisted root entries; no archive paths are used for extraction.
        foreach ($file in $Files) {
            $entries = @($zip.Entries | Where-Object { $_.FullName -ceq $file.name })
            if ($entries.Count -ne 1 -or $file.name -notmatch '^[a-zA-Z0-9_.-]+$' -or $entries[0].Length -gt 200MB) { throw 'Invalid ZIP entry' }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0], (Join-Path $Stage $file.name), $true)
            if ((Get-FileHash -LiteralPath (Join-Path $Stage $file.name) -Algorithm SHA256).Hash -ne $file.sha256) { throw "SHA256 mismatch: $($file.name)" }
        }
    } finally { $zip.Dispose() }
}

if ($LibraryOnly) { return }
$client = $null
$mutex = $null
$ownsMutex = $false
$restart = $false
$stage = $null
try {
    if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Invalid repository' }
    $Directory = [IO.Path]::GetFullPath($Directory)
    $api = "https://api.github.com/repos/$Repository/releases/latest"
    $headers = @{'User-Agent'='VoiceStudio-STT';Accept='application/vnd.github+json'}
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $release = Invoke-RestMethod -Uri $api -Headers $headers -TimeoutSec 20
    $bundle = Get-ArchiveRelease $release $Repository
    $manifest = $bundle.manifest
    $plan = Get-UpdatePlan $Directory $manifest $Component
    $files = @($plan.files)
    $result = @{available=$plan.available;components=$plan.components;component=$Component;url=$release.html_url}
    if ($Component -ne 'all') {
        $result.current=$plan.components[$Component].current
        $result.version=$plan.components[$Component].version
    }
    if (-not $Install -or -not $plan.available) {
        $result | ConvertTo-Json -Depth 8 -Compress
        exit 0
    }
    $hash = [Security.Cryptography.SHA256]::Create()
    $key = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Directory.ToLowerInvariant())))).Replace('-','')
    $hash.Dispose()
    $mutex = [Threading.Mutex]::new($false, "Local\VoiceStudioUpdate-$key")
    $ownsMutex = $mutex.WaitOne(0)
    if (-not $ownsMutex) { throw 'Another update is running' }
    $stage = Join-Path $Directory ('.stt-update-stage\' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    $client = [Net.WebClient]::new()
    $client.Headers['User-Agent'] = 'VoiceStudio-STT'
    $archive = Join-Path $stage 'release.zip'
    $client.DownloadFile($bundle.url, $archive)
    Expand-CheckedArchive $archive $stage $files $manifest.archive.sha256
    if ($plan.components.ContainsKey('server') -and $plan.components.server.available) {
        # Downloads and checks complete first. Only stop this installation.
        $exe = Join-Path $Directory 'stt_server.exe'
        $script = Join-Path $Directory 'stt_server.py'
        $processes = @(Get-CimInstance Win32_Process | Where-Object {
            ($_.ExecutablePath -and $_.ExecutablePath -eq $exe) -or
            ($_.Name -match '^pythonw?\.exe$' -and $_.CommandLine -and
             ($_.CommandLine.Contains('"'+$script+'"') -or $_.CommandLine.EndsWith(' '+$script)))
        })
        foreach ($entry in $processes) { Stop-Process -Id $entry.ProcessId -Force -ErrorAction SilentlyContinue }
        $restart = $processes.Count -gt 0
        foreach ($entry in $processes) { Wait-Process -Id $entry.ProcessId -Timeout 15 -ErrorAction SilentlyContinue }
    }
    $backup = Install-StagedFiles $Directory $stage $files
    $result.installed=$true
    $result.backup=$backup
    $result | ConvertTo-Json -Depth 8 -Compress
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($restart) { Start-Process -FilePath (Join-Path $Directory 'stt_server.exe') -ArgumentList '--background' -WorkingDirectory $Directory -WindowStyle Hidden }
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
    if ($client) { $client.Dispose() }
    if ($stage -and [IO.Directory]::Exists($stage)) {
        try { [IO.Directory]::Delete($stage, $true) } catch { }
    }
}

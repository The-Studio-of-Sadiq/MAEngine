$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$codeRoot = Join-Path $repoRoot 'workbench'
$product = Get-Content (Join-Path $codeRoot 'product.json') -Raw | ConvertFrom-Json

$packagedExecutable = Join-Path $repoRoot "VSCode-win32-x64\$($product.nameShort).exe"
if (Test-Path $packagedExecutable) {
    $appExecutable = $packagedExecutable
    $isPackaged = $true
} else {
    $electronDirectory = Join-Path $codeRoot '.build\electron'
    $appExecutable = Join-Path $electronDirectory "$($product.nameShort).exe"
    $isPackaged = $false
    if (-not (Test-Path $appExecutable)) {
        throw "MAEngine executable not found at $packagedExecutable or $appExecutable."
    }
}

# Clean up any existing instances that hold single-instance lock
$existing = Get-Process -Name "$($product.nameShort)" -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Closing $($existing.Count) existing $($product.nameShort) process(es)..."
    Stop-Process -Name "$($product.nameShort)" -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
}

# Clean stale lockfile and ensure storage.json is clean without BOM
$userDataPath = Join-Path $env:APPDATA "$($product.nameShort)"
$null = New-Item -ItemType Directory -Path $userDataPath -Force
$projectsPath = Join-Path ([Environment]::GetFolderPath('MyDocuments')) "$($product.nameShort) Projects"
$null = New-Item -ItemType Directory -Path $projectsPath -Force

$lockFile = Join-Path $userDataPath 'code.lock'
if (Test-Path $lockFile) {
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
}

$storageFile = Join-Path $userDataPath 'User\globalStorage\storage.json'
if (Test-Path $storageFile) {
    try {
        $st = Get-Content $storageFile -Raw | ConvertFrom-Json
        if ($st.windowsState) {
            $st.windowsState.openedWindows = @()
            $st.windowsState.lastActiveWindow = $null
        }
        if ($st.backupWorkspaces) {
            $st.backupWorkspaces.emptyWindows = @()
            $st.backupWorkspaces.workspaces = @()
            $st.backupWorkspaces.folders = @()
        }
        $jsonStr = $st | ConvertTo-Json -Depth 10
        [System.IO.File]::WriteAllText($storageFile, $jsonStr, (New-Object System.Text.UTF8Encoding($false)))
    } catch {}
}

# Scrub parent environment variables that cause Electron to attach to host VS Code or run as node
Get-ChildItem Env: | Where-Object { $_.Name -like '*VSCODE*' -or $_.Name -like '*ELECTRON*' -or $_.Name -like '*ANTIGRAVITY*' } | ForEach-Object {
    [Environment]::SetEnvironmentVariable($_.Name, $null, 'Process')
    Remove-Item "Env:\$($_.Name)" -ErrorAction SilentlyContinue
}

$env:NODE_ENV = 'development'
$env:VSCODE_DEV = '1'
$env:VSCODE_CLI = '1'
$env:VSCODE_SKIP_PRELAUNCH = '1'

$arguments = if ($isPackaged) {
    @("--user-data-dir=`"$userDataPath`"")
} else {
    @("`"$codeRoot`"", "--user-data-dir=`"$userDataPath`"")
}

$process = Start-Process -FilePath $appExecutable -ArgumentList $arguments -WorkingDirectory $codeRoot -PassThru
Write-Host "Started $($product.nameLong) (PID $($process.Id))."

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$temporaryRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$token = [Guid]::NewGuid().ToString('N')
$buildRoot = Join-Path $temporaryRoot ('tsukiori-v1-rc1-' + $token)
$installRoot = Join-Path $temporaryRoot ('tsukiori-v1-install-' + $token)
$userDataRoot = Join-Path $temporaryRoot ('tsukiori-v1-userdata-' + $token)

function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Executable failed with exit code $LASTEXITCODE"
  }
}

function Install-Candidate([string]$Installer) {
  $process = Start-Process -FilePath $Installer -ArgumentList @('/S', ('/D=' + $installRoot)) `
    -PassThru -Wait -WindowStyle Hidden
  if ($process.ExitCode -ne 0) { throw "Installer failed with exit code $($process.ExitCode)" }
  $executable = Join-Path $installRoot 'Tsukiori.exe'
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while (-not (Test-Path -LiteralPath $executable)) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Installed Tsukiori.exe did not appear' }
    Start-Sleep -Milliseconds 250
  }
  return $executable
}

function Uninstall-Candidate {
  $uninstaller = Join-Path $installRoot 'Uninstall Tsukiori.exe'
  if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'Uninstaller is missing' }
  $process = Start-Process -FilePath $uninstaller -ArgumentList '/S' `
    -PassThru -Wait -WindowStyle Hidden
  if ($process.ExitCode -ne 0) { throw "Uninstaller failed with exit code $($process.ExitCode)" }
  $executable = Join-Path $installRoot 'Tsukiori.exe'
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while (Test-Path -LiteralPath $executable) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Uninstall did not remove Tsukiori.exe' }
    Start-Sleep -Milliseconds 250
  }
}

Push-Location $repositoryRoot
try {
  if ((Test-Path -LiteralPath $buildRoot) -or (Test-Path -LiteralPath $installRoot)) {
    throw 'Generated verification paths unexpectedly exist'
  }
  Invoke-Checked 'pnpm' @('--filter', '@tsukiori/daemon', 'build')
  Invoke-Checked 'pnpm' @('--filter', '@tsukiori/desktop', 'build')
  Invoke-Checked 'node' @('apps/desktop/scripts/stage-release.mjs')
  Invoke-Checked 'pnpm' @(
    '--filter', '@tsukiori/desktop', 'exec', 'electron-builder',
    '--config', 'electron-builder.config.cjs', '--win', 'nsis', '--x64',
    ('--config.directories.output=' + $buildRoot)
  )

  $installer = Join-Path $buildRoot 'Tsukiori-1.0.0-rc.1-x64-setup.exe'
  if (-not (Test-Path -LiteralPath $installer)) { throw 'Expected RC installer is missing' }
  $executable = Install-Candidate $installer
  $firstHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $executable).Hash

  $env:TSUKIORI_DESKTOP_SMOKE = '1'
  $env:TSUKIORI_DAEMON_EXIT_POLICY = 'stop'
  $smoke = Start-Process -FilePath $executable -ArgumentList ('--user-data-dir=' + $userDataRoot) `
    -PassThru -Wait -WindowStyle Hidden
  if ($smoke.ExitCode -ne 0) { throw "Packaged smoke failed with exit code $($smoke.ExitCode)" }

  $null = Install-Candidate $installer
  $upgradeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $executable).Hash
  if ($firstHash -ne $upgradeHash) { throw 'Upgrade changed the installed executable unexpectedly' }
  Uninstall-Candidate
  $removedAfterUninstall = -not (Test-Path -LiteralPath $executable)
  $null = Install-Candidate $installer
  $reinstalled = Test-Path -LiteralPath $executable
  Uninstall-Candidate

  [ordered]@{
    schemaVersion = 1
    releaseCandidate = '1.0.0-rc.1'
    platform = 'windows-x64'
    install = 'passed'
    packagedSmoke = 'passed'
    update = 'passed'
    uninstall = if ($removedAfterUninstall) { 'passed' } else { 'failed' }
    reinstall = if ($reinstalled) { 'passed' } else { 'failed' }
    finalUninstall = if (-not (Test-Path -LiteralPath $executable)) { 'passed' } else { 'failed' }
    userDataRetained = Test-Path -LiteralPath $userDataRoot
    artifactSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $installer).Hash.ToLowerInvariant()
    artifactBytes = (Get-Item -LiteralPath $installer).Length
    artifactCommitted = $false
    credentialsCommitted = $false
  } | ConvertTo-Json -Compress
} finally {
  Pop-Location
}
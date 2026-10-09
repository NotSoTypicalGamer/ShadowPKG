<#
.SYNOPSIS
  Guided install of the ShadowPKG builder container on Windows with Docker Desktop.

.DESCRIPTION
  The same steps as install.sh, for a PC instead of a NAS:
    1. builds the image from this folder (the Dockerfile has to be beside this script)
    2. runs the ONE-TIME setup in a throwaway container that has network access:
       Wine, .NET, the VC++ runtime and Python are downloaded, the kit is tested,
       and you type YES to approve exactly the files in it
    3. starts the real container with the network switched OFF
  Nothing is approved without you typing YES, and the kit never enters the image.

  Two things differ from a NAS. Wine will not run from a Windows folder (it needs
  Linux file permissions), so its environment and the scratch space live in Docker
  volumes rather than in folders you can see. And reading a big dump through
  Docker Desktop's file sharing is slow, so the dump is copied into the scratch
  volume first (COPY_DUMP). Make sure Docker Desktop's disk image has room for the
  biggest game plus its package (Settings > Resources).

.PARAMETER Update
  Rebuild the image and recreate the container with the answers saved last time.
  Refuses while a build is running.
.PARAMETER DryRun
  Print the docker commands, run nothing.
.PARAMETER Yes
  Take saved answers or defaults without asking.
.PARAMETER Force
  Recreate the container even if a build is running (the build is lost).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
#>
param(
  [switch]$Update,
  [switch]$DryRun,
  [switch]$Yes,
  [switch]$Force,
  [string]$Kit, [string]$Library, [string]$ShadowPkgConfig, [string]$Config
)
$ErrorActionPreference = 'Stop'

$Name = if ($env:SPKGB_NAME) { $env:SPKGB_NAME } else { 'ShadowPKG-Builder' }
$Image = if ($env:SPKGB_IMAGE) { $env:SPKGB_IMAGE } else { 'shadowpkg-builder' }
$PrefixVolume = "$($Name.ToLower())-prefix"
$WorkVolume = "$($Name.ToLower())-work"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Say($m) { Write-Host $m }
function Stop-Here($m) { Write-Host "Stopped: $m" -ForegroundColor Red; exit 1 }
# Everything that changes something goes through here, so -DryRun is honest.
# docker's own output goes to the screen untouched (the setup step is interactive),
# so the exit code comes back in $script:DockerExit rather than as a return value.
$script:DockerExit = 0
function Invoke-Docker([string[]]$DockerArgs, [switch]$Quiet) {
  if ($DryRun) { Say ('  would run: docker ' + (($DockerArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ')); $script:DockerExit = 0; return }
  # Windows PowerShell turns a native program's stderr into an error when it is
  # redirected, and a missing container on "rm -f" is not one worth stopping for.
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  if ($Quiet) { & docker @DockerArgs *> $null } else { & docker @DockerArgs }
  $script:DockerExit = $LASTEXITCODE
  $ErrorActionPreference = $old
}

if (-not $DryRun -and -not (Get-Command docker -ErrorAction SilentlyContinue)) { Stop-Here 'docker was not found. Install Docker Desktop and start it first.' }

# Saved answers live beside the other per-user settings, not in the repository.
$SaveDir = Join-Path $env:LOCALAPPDATA 'ShadowPKG-Builder'
$SaveFile = Join-Path $SaveDir 'install.json'
$saved = $null
if (Test-Path $SaveFile) { try { $saved = Get-Content $SaveFile -Raw | ConvertFrom-Json } catch { $saved = $null } }
if ($Update -and -not $saved) { Stop-Here "no saved answers found at $SaveFile; run without -Update first." }

function Ask([string]$Current, [string]$SavedValue, [string]$Prompt, [string]$Default) {
  $def = if ($Current) { $Current } elseif ($SavedValue) { $SavedValue } else { $Default }
  if ($Yes -or $Update) { if (-not $def) { Stop-Here "$Prompt has no answer; run without -Yes." }; return $def }
  while ($true) {
    $ans = Read-Host ("$Prompt" + $(if ($def) { " [$def]" } else { '' }))
    if (-not $ans) { $ans = $def }
    if ($ans) { return $ans.Trim('"') }
  }
}

Say 'ShadowPKG builder setup (Docker Desktop)'
Say ''
$Kit = Ask $Kit $saved.Kit 'Folder holding your extracted repack kit (build-from-folder.ps1, scripts\, toolchain\)' 'C:\Tools\sdk-fpkg279-fix13'
$Library = Ask $Library $saved.Library 'Your game library, the same folder ShadowPKG uses' 'D:\Games'
$ShadowPkgConfig = Ask $ShadowPkgConfig $saved.ShadowPkgConfig "ShadowPKG's own config folder (where its builds.json lives)" 'C:\ShadowPKG\config'
$Config = Ask $Config $saved.Config "A folder for this builder's settings and logs" 'C:\ShadowPKG-Builder'

$problems = $false
if (-not (Test-Path (Join-Path $Kit 'toolchain\prospero-pub-cmd.exe'))) { Say "  ! $Kit does not contain toolchain\prospero-pub-cmd.exe. The kit has to be extracted there, not left as an archive."; $problems = $true }
if (-not (Test-Path $Library -PathType Container)) { Say "  ! $Library is not a folder."; $problems = $true }
if (-not (Test-Path $ShadowPkgConfig -PathType Container)) { Say "  ! $ShadowPkgConfig is not a folder (ShadowPKG's config folder)."; $problems = $true }
if ($problems -and -not $DryRun) { Stop-Here 'fix the paths above and run this again.' }

if (-not $DryRun) {
  New-Item -ItemType Directory -Force -Path $Config, $SaveDir | Out-Null
  @{ Kit = $Kit; Library = $Library; ShadowPkgConfig = $ShadowPkgConfig; Config = $Config } | ConvertTo-Json | Set-Content -Path $SaveFile -Encoding UTF8
}

# A restart kills a build that is running, and so does replacing the container.
$statusFile = Join-Path $Library '.shadowpkg-builder.json'
if (-not $DryRun -and (Test-Path $statusFile)) {
  $busy = $null; try { $busy = (Get-Content $statusFile -Raw | ConvertFrom-Json).busy } catch {}
  if ($busy) {
    if ($Force) { Say '  A build is running and -Force was given; it will be lost.' }
    else { Stop-Here 'the builder is in the middle of a build. Wait for it to finish (or cancel it in ShadowPKG), or use -Force.' }
  }
}

# The kit is mounted read-only; the library is /games, so ShadowPKG's job paths line up.
$Mounts = @('-v', "${Kit}:/kit:ro", '-v', "${Library}:/games", '-v', "${Config}:/config", '-v', "${PrefixVolume}:/prefix", '-v', "${WorkVolume}:/work")

Say ''
Say '1/3  The image'
if (Test-Path (Join-Path $Here 'Dockerfile')) {
  Invoke-Docker @('build', '-t', $Image, $Here)
  if ($script:DockerExit -ne 0) { Stop-Here 'building the image failed.' }
} else { Say "  No Dockerfile beside this script, so the existing image `"$Image`" is used." }

Say ''
Say '2/3  One-time setup, in a container that is allowed to use the network'
Say '     (downloads about 1 GB, takes 10 to 20 minutes the first time; nothing to do but wait,'
Say "      then type YES when it lists the kit's files, if you accept them)"
Invoke-Docker @('rm', '-f', "$Name-setup") -Quiet
$setupArgs = @('run', '--rm', '-it', '--name', "$Name-setup") + $Mounts + @('-e', 'COPY_DUMP=1', $Image, 'setup')
Invoke-Docker $setupArgs
if ($script:DockerExit -ne 0) { Stop-Here 'setup did not finish. Nothing was started. Read what it said above and run this again; it picks up where it stopped.' }

Say ''
Say '3/3  The builder itself, with the network off'
Invoke-Docker @('rm', '-f', $Name) -Quiet
$runArgs = @('run', '-d', '--name', $Name, '--restart', 'unless-stopped', '--network', 'none') + $Mounts + @('-v', "${ShadowPkgConfig}:/spkg:ro", '-e', 'COPY_DUMP=1', $Image)
Invoke-Docker $runArgs -Quiet
if ($script:DockerExit -ne 0) { Stop-Here 'starting the builder failed.' }
if (-not $DryRun) {
  Start-Sleep -Seconds 4
  & docker exec $Name node /app/runner.js status
}

Say ''
Say 'Done. In ShadowPKG, open a game dump and press Build .pkg: its card should say the builder is online.'
Say 'The Wine environment and scratch space are Docker volumes, so they are removed with "docker volume rm" and not by deleting a folder.'
Say 'To update later:  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Update'

# Keeps ShadowPKG-Build.ps1 running in the background: every few seconds it asks
# ShadowPKG whether a build is waiting, and runs it if so. Started at logon by
# the scheduled task Install-ShadowPKG-Builder.ps1 creates, so nothing has to be
# opened by hand. Each poll is a fresh run of the builder, which re-checks the
# kit against the approved hashes every time.
param([int]$PollSeconds = 30)
$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
$log = Join-Path $here 'watch.log'

# One watcher at a time, however it was started.
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\ShadowPKG-Builder-Watch', [ref]$created)
if (-not $created) { exit 0 }

function Log($m) {
    $line = '{0:s}  {1}' -f (Get-Date), $m
    Add-Content -LiteralPath $log -Value $line -Encoding UTF8
    # Keep the log from growing without end.
    if ((Get-Item -LiteralPath $log).Length -gt 1MB) {
        Move-Item -LiteralPath $log -Destination ($log + '.1') -Force
    }
}

Log "watching every $PollSeconds s"
$lastNote = ''
while ($true) {
    $out = Join-Path $env:TEMP 'shadowpkg-watch-out.txt'
    $p = Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -PassThru -Wait `
        -RedirectStandardOutput $out -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f (Join-Path $here 'ShadowPKG-Build.ps1')))
    $text = (Get-Content -LiteralPath $out -Raw -ErrorAction SilentlyContinue)
    $text = if ($text) { ($text -replace '\s+', ' ').Trim() } else { '' }
    # A build that ran is worth logging in full; the same idle or blocked message
    # every poll is logged once.
    if ($p.ExitCode -eq 0 -and $text -match 'No build is waiting') {
        if ($lastNote -ne 'idle') { Log 'idle: no build waiting'; $lastNote = 'idle' }
    } elseif ($text -ne $lastNote) {
        Log ("exit {0}: {1}" -f $p.ExitCode, $text)
        $lastNote = $text
    }
    # Blocked or failing: wait longer rather than hammering the server and the log.
    Start-Sleep -Seconds $(if ($p.ExitCode -ne 0) { [Math]::Max($PollSeconds, 120) } else { $PollSeconds })
}

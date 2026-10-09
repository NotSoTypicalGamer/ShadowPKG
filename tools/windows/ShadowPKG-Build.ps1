# Runs a ShadowPKG "Build .pkg" job on this PC.
#
# ShadowPKG (on the NAS) checks a game dump and writes a job folder beside it.
# This script picks the job up, runs the repack kit you supply on the dump, and
# puts the finished .pkg next to the dump. It contains no Sony code and needs
# none in the repo: the kit lives on this PC, at the path in builder.json, and
# is only ever run after every file in it matches the hashes you approved.
#
#   ShadowPKG-Build.ps1            take the oldest pending job from ShadowPKG
#   ShadowPKG-Build.ps1 -Trust     record the kit's current file hashes as approved
#   ShadowPKG-Build.ps1 -JobDir X  run the job in folder X (testing)
#   ShadowPKG-Build.ps1 -DryRun    do every check, run nothing
param(
    [string]$Config = (Join-Path $PSScriptRoot 'builder.json'),
    [string]$JobDir,
    [switch]$Trust,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

$script:stateDir = $null      # set once there is a job folder to report a failure in
$script:settled = $false      # set once state.json says done or failed
function Fail($message) {
    Write-Host "`n$message" -ForegroundColor Red
    # A job that cannot start should say why on its card, not sit "waiting".
    if ($script:stateDir -and -not $script:settled -and -not $DryRun) { Write-State $script:stateDir 'failed' $message @{ exit = 0 } }
    exit 1
}
function Note($message) { Write-Host $message }

if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) { Fail "No $Config yet. Copy builder.example.json to builder.json and fill it in." }
$cfg = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
$kit = [IO.Path]::GetFullPath([string]$cfg.kit)
if (-not (Test-Path -LiteralPath (Join-Path $kit 'build-from-folder.ps1'))) { Fail "The kit is not at $kit (no build-from-folder.ps1)." }
if ($kit -match '\\OneDrive\\') { Write-Host "Warning: the kit is inside OneDrive, so its files are being uploaded to the cloud. Move it somewhere like C:\Tools." -ForegroundColor Yellow }

# Every program and script in the kit, by relative path. A file added, removed
# or changed since it was approved stops the run.
function Get-KitHashes {
    $out = [ordered]@{}
    Get-ChildItem -LiteralPath $kit -Recurse -File |
        Where-Object { $_.Extension -match '^\.(exe|dll|ps1|py|bat|cmd|sys)$' } |
        Sort-Object FullName | ForEach-Object {
            $rel = $_.FullName.Substring($kit.Length).TrimStart('\').Replace('\', '/')
            $out[$rel] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
        }
    return $out
}

if ($Trust) {
    $hashes = Get-KitHashes
    Note "Files in $kit that will be approved ($($hashes.Count)):"
    $tampered = 0
    foreach ($k in $hashes.Keys) {
        $sig = ''
        if ($k -match '\.(exe|dll)$') { $sig = (Get-AuthenticodeSignature -LiteralPath (Join-Path $kit $k)).Status }
        if ("$sig" -eq 'HashMismatch') { $tampered++ }
        Note ("  {0,-46} {1}  {2}" -f $k, $hashes[$k].Substring(0, 12), $sig)
    }
    if ($tampered) { Note "`n$tampered of these carry a signature that no longer matches (HashMismatch): they were modified after they were signed." }
    Note "Approving them means you are choosing to run them as yourself, on this PC."
    if ((Read-Host "Type YES to approve exactly these files") -cne 'YES') { Fail 'Not approved.' }
    $obj = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
    $obj | Add-Member -NotePropertyName pins -NotePropertyValue $hashes -Force
    $obj | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Config -Encoding UTF8
    Note "`nApproved. Recommended, once, from an elevated PowerShell: stop these programs reaching the network."
    Note "(The main one contains Sony sign-in and version-check code.)"
    foreach ($k in $hashes.Keys | Where-Object { $_ -match '\.exe$' }) {
        Note ("  New-NetFirewallRule -DisplayName 'ShadowPKG kit block' -Direction Outbound -Action Block -Program '{0}'" -f (Join-Path $kit $k))
    }
    exit 0
}

if (-not $cfg.pins) { Fail "The kit has not been approved yet. Run:  ShadowPKG-Build.ps1 -Trust" }
$now = Get-KitHashes
$pins = $cfg.pins
$problems = @()
foreach ($k in $now.Keys) {
    $want = $pins.PSObject.Properties[$k]
    if (-not $want) { $problems += "not approved: $k" } elseif ($want.Value -ne $now[$k]) { $problems += "changed: $k" }
}
foreach ($p in $pins.PSObject.Properties) { if (-not $now.Contains($p.Name)) { $problems += "missing: $($p.Name)" } }
if ($problems) { Fail ("The kit no longer matches what you approved, so nothing was run:`n  " + ($problems -join "`n  ") + "`nIf you changed it on purpose, run -Trust again.") }
Note "Kit matches the approved hashes ($($now.Count) files)."

# ---- The job ---------------------------------------------------------------
function Read-Json($path) { Get-Content -LiteralPath $path -Raw | ConvertFrom-Json }

# A path from the server is only ever a relative path under a library root.
function Resolve-Under($root, $rel, [switch]$AllowRoot) {
    if ([string]::IsNullOrWhiteSpace($rel)) {
        if ($AllowRoot) { return [IO.Path]::GetFullPath($root) }
        throw 'empty path'
    }
    foreach ($seg in $rel.Split('/')) {
        if ($seg -eq '' -or $seg -eq '.' -or $seg -eq '..' -or $seg -match '[<>:"|?*\x00-\x1f\\]') { throw "unacceptable path: $rel" }
    }
    $full = [IO.Path]::GetFullPath((Join-Path $root ($rel.Replace('/', '\'))))
    $r = [IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
    if (-not $full.StartsWith($r, [StringComparison]::OrdinalIgnoreCase)) { throw "path leaves the library: $rel" }
    return $full
}

function Write-State($dir, $state, $message, $extra) {
    $o = [ordered]@{ state = $state; message = $message; updated = (Get-Date).ToUniversalTime().ToString('o') }
    if ($extra) { foreach ($k in $extra.Keys) { $o[$k] = $extra[$k] } }
    $o | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dir 'state.json') -Encoding UTF8
    if ($state -eq 'done' -or $state -eq 'failed') { $script:settled = $true }
}

# Bytes in a file that is still being written. A directory listing only learns
# a file's new size when it is closed, so a package that stays open for the whole
# build would read as empty; the length of an open handle is always current.
function Get-LiveLength($path) {
    try {
        $s = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite,Delete')
        try { return $s.Length } finally { $s.Dispose() }
    } catch {
        # Opened exclusively by the writer: the listing's size is all there is,
        # and it can lag until the file is closed.
        try { return (Get-Item -LiteralPath $path -ErrorAction Stop).Length } catch { return 0 }
    }
}
function Get-TreeBytes($dir) {
    $sum = 0L
    foreach ($f in Get-ChildItem -LiteralPath $dir -Recurse -File -ErrorAction SilentlyContinue) { $sum += Get-LiveLength $f.FullName }
    return $sum
}

$job = $null; $lib = $null; $jobRel = $null
if ($JobDir) {
    $jobDirFull = [IO.Path]::GetFullPath($JobDir)
    $job = Read-Json (Join-Path $jobDirFull 'job.json')
    $lib = [string]$job.library
    $root = [string]$cfg.libraries.$lib
    if (-not $root) { Fail "builder.json has no path for library '$lib' (libraries)." }
} else {
    $server = ([string]$cfg.server).TrimEnd('/')
    if (-not $server) { Fail 'builder.json has no "server".' }
    # ShadowPKG asks for a password when ACCESS_PASSWORD is set on it. "user" (default shadow) and "password" in builder.json are optional.
    $headers = @{}
    if ($cfg.password) {
        $who = if ($cfg.user) { [string]$cfg.user } else { 'shadow' }
        $headers['Authorization'] = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($who + ':' + [string]$cfg.password))
    }
    try { $pending = Invoke-RestMethod -Uri "$server/api/build/pending" -Headers $headers -TimeoutSec 15 } catch {
        $hint = if ("$($_.Exception.Message)" -match '401') { ' ShadowPKG asks for a password: set "user" and "password" in builder.json.' } else { '' }
        Fail "Could not ask $server for jobs: $($_.Exception.Message)$hint"
    }
    if (-not $pending.jobs -or -not $pending.jobs.Count) { Note 'No build is waiting. Press Build .pkg on a checked dump in ShadowPKG first.'; exit 0 }
    $pick = $pending.jobs[0]
    $lib = [string]$pick.library
    $root = [string]$cfg.libraries.$lib
    if (-not $root) { Fail "builder.json has no path for library '$lib' (libraries)." }
    if ([string]$pick.id -notmatch '^[0-9a-f]{12}$') { Fail 'The server sent a job id that is not valid.' }
    # The share not being mounted yet (just after logon, say) is not the job's
    # fault: leave it waiting and let the next poll try again.
    if (-not (Test-Path -LiteralPath $root)) { Note "The library at $root is not reachable yet."; exit 2 }
    $jobDirFull = Resolve-Under $root ([string]$pick.jobRel)
    $job = Read-Json (Join-Path $jobDirFull 'job.json')
}
$script:stateDir = $jobDirFull

if ([string]$job.id -notmatch '^[0-9a-f]{12}$') { Fail 'job.json: bad id.' }
if ([string]$job.contentId -notmatch '^[A-Z]{2}[0-9]{4}-[A-Z]{4}[0-9]{5}_[0-9]{2}-[A-Z0-9]{16}$') { Fail 'job.json: bad content ID.' }
$compression = [int]$job.options.compression; $chunks = [int]$job.options.chunks
if ($compression -lt -4 -or $compression -gt 9) { Fail 'job.json: compression out of range.' }
if ($chunks -lt 1 -or $chunks -gt 255) { Fail 'job.json: chunks out of range.' }
# Only the builder container can stop after the package list; this one would go on
# to a full build, which is not what was asked for.
if ($job.options.validateOnly) { Fail 'This builder cannot do a quick validation (only the builder container can). Clear this job and use Build .pkg instead.' }
if ($job.options.reference) { Fail 'This builder cannot build a patch (only the builder container can). Clear this job and build without a base package.' }

$dump = Resolve-Under $root ([string]$job.dumpRel)
$outDir = Resolve-Under $root ([string]$job.outputDirRel) -AllowRoot
if (-not (Test-Path -LiteralPath (Join-Path $dump 'sce_sys\param.json'))) { Fail "The dump is not at $dump." }
if (-not (Test-Path -LiteralPath $outDir -PathType Container)) { Fail "The output folder $outDir does not exist." }
$finalPkg = Join-Path $outDir ($job.contentId + '.pkg')
if (Test-Path -LiteralPath $finalPkg) { Fail "$finalPkg already exists; not overwriting it." }

$py = [string]$cfg.python
if (Test-Path -LiteralPath $py -PathType Container) { $py = Join-Path $py 'python.exe' }
if (-not (Test-Path -LiteralPath $py -PathType Leaf)) { Fail "Python not found at $py (builder.json: python)." }
$temp = [IO.Path]::GetFullPath([string]$cfg.temp)

Note "Game:    $($job.title)  [$($job.contentId)]"
Note "Dump:    $dump"
Note "Output:  $finalPkg"
Note "Scratch: $temp"
Note "Job:     $jobDirFull"

# Scratch and staging must be real, writable, local folders. A cloud-synced or
# virtual drive can show plenty of free space and still refuse to hold them, and
# the kit would only find out partway in.
function Test-Scratch([string]$dir, [string]$what) {
    try {
        New-Item -ItemType Directory -Force -Path $dir -ErrorAction Stop | Out-Null
        $probe = Join-Path $dir ('.probe-' + [guid]::NewGuid().ToString('N'))
        Set-Content -LiteralPath $probe -Value 'x' -ErrorAction Stop
        $ok = (Get-Item -LiteralPath $probe -ErrorAction Stop).Length -gt 0
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        if (-not $ok) { return "$what ($dir) did not keep a test file" }
        return $null
    } catch { return "$what ($dir) cannot be written to: $($_.Exception.Message). Use a folder on a normal local disk, not a cloud or virtual drive." }
}
$scratchProblem = Test-Scratch $temp 'The scratch folder'
if (-not $scratchProblem -and $cfg.staging) { $scratchProblem = Test-Scratch ([IO.Path]::GetFullPath([string]$cfg.staging)) 'The staging folder' }
if ($scratchProblem) { Fail $scratchProblem }

# The kit reads the dump by memory-mapping its files. Over a network share every
# page fault is a round trip, which crawls at a fraction of a MB/s however fast
# the share is; the same reads from a local disk are quick. "dumpCache" names a
# fast local folder to copy the dump into first (kept per game, so a retry only
# copies what is missing, and removed after a successful build).
$cache = $null; $localDump = $null; $srcBytes = 0L
if ($cfg.dumpCache) {
    $cache = [IO.Path]::GetFullPath([string]$cfg.dumpCache)
    $cacheProblem = Test-Scratch $cache 'The dump cache folder'
    if ($cacheProblem) { Fail $cacheProblem }
    $localDump = Join-Path $cache ([string]$job.contentId)
}
if ($cache -or $cfg.staging) {
    $srcBytes = [long](Get-ChildItem -LiteralPath $dump -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    $haveLocal = 0L
    if ($localDump -and (Test-Path -LiteralPath $localDump)) { $haveLocal = Get-TreeBytes $localDump }
    # What each drive will need, in the worst case: the dump copy, a package about
    # the size of the dump, and some room for the SDK's own scratch files.
    $need = @{}
    $add = { param($path, [long]$bytes) $k = (Split-Path -Qualifier ([IO.Path]::GetFullPath($path))).ToUpper(); $need[$k] = [long]$need[$k] + $bytes }
    if ($cache) { & $add $cache ([Math]::Max(0L, $srcBytes - $haveLocal)) }
    if ($cfg.staging) { & $add ([string]$cfg.staging) $srcBytes }
    & $add $temp 10GB
    foreach ($k in $need.Keys) {
        $free = (Get-PSDrive -Name $k.TrimEnd(':') -ErrorAction Stop).Free
        if ($free -lt $need[$k]) { Fail ("Not enough room on {0} for this build: it can need about {1:N0} GB and {0} has {2:N0} GB free. Point dumpCache, staging or temp in builder.json at a bigger local disk." -f $k, ($need[$k] / 1GB), ($free / 1GB)) }
    }
    Note ("Dump:    {0:N1} GB to read" -f ($srcBytes / 1GB))
}

if ($DryRun) { Note "`nDry run: every check passed; nothing was run."; exit 0 }

New-Item -ItemType Directory -Force -Path $temp | Out-Null
# The package is built in "work" and only moved out once it is whole. With
# "staging" set, work is a folder on this PC, so the build never writes over the
# network and the NAS only ever receives a finished file; without it, work is a
# hidden folder in the job folder on the NAS.
$stage = $null
if ($cfg.staging) {
    $stage = Join-Path ([IO.Path]::GetFullPath([string]$cfg.staging)) ([string]$job.id)
    $work = $stage
} else {
    $work = Join-Path $jobDirFull 'work'
}
New-Item -ItemType Directory -Force -Path $work | Out-Null
$built = Join-Path $work ($job.contentId + '.pkg')
$log = Join-Path $jobDirFull 'build.log'
$err = Join-Path $jobDirFull 'build.err'
Write-State $jobDirFull 'running' 'starting' @{ host = $env:COMPUTERNAME; startedAt = (Get-Date).ToUniversalTime().ToString('o') }

# Start-Process joins its arguments with spaces and does not quote them, so a
# path such as "C:\Program Files (x86)\..." or a folder named "Game Name" would
# be split into several arguments. Each one is quoted here, the way the Windows
# command line expects (a backslash run before a quote doubles).
function ConvertTo-CommandLineArg([string]$a) {
    if ($a -ne '' -and $a -notmatch '[\s"]') { return $a }
    $q = $a -replace '(\\*)"', '$1$1\"'
    $q = $q -replace '(\\+)$', '$1$1'
    return '"' + $q + '"'
}
$sourceForKit = $dump
if ($cache) {
    Note "Copying the dump to this PC first ($([math]::Round($srcBytes / 1GB, 1)) GB); the kit reads it far faster from a local disk."
    New-Item -ItemType Directory -Force -Path $localDump | Out-Null
    $rcArgs = @($dump, $localDump, '/E', '/J', '/R:3', '/W:5', '/NP', '/NFL', '/NDL') | ForEach-Object { ConvertTo-CommandLineArg $_ }
    $rc = Start-Process -FilePath 'robocopy.exe' -ArgumentList $rcArgs -NoNewWindow -PassThru `
        -RedirectStandardOutput (Join-Path $jobDirFull 'fetch.log')
    $null = $rc.Handle
    $fetchStart = (Get-Date).ToUniversalTime().ToString('o')
    while (-not $rc.HasExited) {
        Write-State $jobDirFull 'running' 'fetching' @{ copied = (Get-TreeBytes $localDump); total = $srcBytes; startedAt = $fetchStart }
        Start-Sleep -Seconds 15
    }
    $rc.WaitForExit()
    $gotBytes = Get-TreeBytes $localDump
    # robocopy's own codes: 8 and above mean something failed.
    if ($rc.ExitCode -ge 8 -or $gotBytes -ne $srcBytes) {
        Write-State $jobDirFull 'failed' "copying the dump to this PC failed (robocopy exit $($rc.ExitCode), $gotBytes of $srcBytes bytes)" @{ exit = $rc.ExitCode }
        Fail "Copying the dump failed (robocopy exit $($rc.ExitCode); $gotBytes of $srcBytes bytes). A retry continues where it stopped."
    }
    $sourceForKit = $localDump
}
$kitArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $kit 'build-from-folder.ps1'),
    '-SourceFolder', $sourceForKit, '-OutputPackage', $built,
    '-CompressionLevel', [string]$compression, '-ChunkCount', [string]$chunks,
    '-Python', $py, '-TemporaryDirectory', $temp, '-Force') | ForEach-Object { ConvertTo-CommandLineArg $_ }
$proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $kitArgs -NoNewWindow -PassThru `
    -RedirectStandardOutput $log -RedirectStandardError $err -WorkingDirectory $kit
$null = $proc.Handle    # without this the exit code of a -PassThru process reads back empty
# Keep the PC awake while the build runs; the setting lapses when this process ends.
try {
    Add-Type -Namespace ShadowPKG -Name Power -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
    [void][ShadowPKG.Power]::SetThreadExecutionState(0x80000001)   # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
} catch {}
Note "Building. This can take a long time; ShadowPKG shows progress."
$started = Get-Date
while (-not $proc.HasExited) {
    $phase = 'starting'
    $t = Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue
    if ($t -match '\[2/2\]') { $phase = 'packing' } elseif ($t -match '\[1/2\]') { $phase = 'preparing' }
    # Bytes written so far, measured here because with "staging" set the build
    # is on this PC and ShadowPKG cannot see it.
    $written = 0
    try { $written = Get-TreeBytes $work } catch {}
    $extra = @{ startedAt = $started.ToUniversalTime().ToString('o'); written = $written }
    # The packing tool draws its own 50-column progress bar into the log; the
    # last run of "=" on a line by itself is how far along it is.
    $text = [string]$t
    $at = $text.LastIndexOf('Creating an image')
    if ($at -ge 0) {
        $bar = [regex]::Matches($text.Substring($at), '(?m)^(=+)\s*$')
        $extra.percent = if ($bar.Count) { [Math]::Min(100, $bar[$bar.Count - 1].Groups[1].Length * 2) } else { 0 }
    }
    Write-State $jobDirFull 'running' $phase $extra
    Start-Sleep -Seconds 15
}
$proc.WaitForExit()

if ($proc.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $built) -or (Get-Item -LiteralPath $built).Length -le 0) {
    Write-State $jobDirFull 'failed' "the kit stopped with exit code $($proc.ExitCode)" @{ exit = $proc.ExitCode }
    Fail "The kit failed (exit $($proc.ExitCode)). See $log"
}
$size = (Get-Item -LiteralPath $built).Length
# The local copy of the dump has done its job; free the space before the package
# is copied out. (A failed build keeps it, so a retry does not copy it again.)
if ($cache -and -not $cfg.keepDumpCopy) { Remove-Item -LiteralPath $localDump -Recurse -Force -ErrorAction SilentlyContinue }
if ($stage) {
    # Copy into the job folder first, under a name that is not a package, and
    # rename it into place last, so a copy that stops halfway is never listed
    # or sent as if it were whole.
    $hold = Join-Path $jobDirFull 'copying.part'
    if (Test-Path -LiteralPath $hold) { Remove-Item -LiteralPath $hold -Force }
    Note "Copying the finished package to the library ($([math]::Round($size / 1GB, 1)) GB)..."
    $copy = Start-Job -ScriptBlock { param($a, $b) Copy-Item -LiteralPath $a -Destination $b -ErrorAction Stop } -ArgumentList $built, $hold
    while ($copy.State -eq 'Running') {
        $have = 0
        if (Test-Path -LiteralPath $hold) { $have = Get-LiveLength $hold }
        Write-State $jobDirFull 'running' 'copying' @{ copied = $have; total = $size }
        Start-Sleep -Seconds 5
    }
    try { Receive-Job $copy -ErrorAction Stop | Out-Null; $copyError = $null } catch { $copyError = $_.Exception.Message }
    Remove-Job $copy -Force
    if ($copyError -or -not (Test-Path -LiteralPath $hold) -or (Get-Item -LiteralPath $hold).Length -ne $size) {
        Write-State $jobDirFull 'failed' "copying the package to the library failed: $copyError" @{ exit = 0 }
        Fail "Copying to the library failed. The finished package is still at $built"
    }
    Move-Item -LiteralPath $hold -Destination $finalPkg
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
} else {
    Move-Item -LiteralPath $built -Destination $finalPkg
}
Write-State $jobDirFull 'done' 'the package is next to the dump' @{ package = $job.contentId + '.pkg'; size = $size }
Note "`nDone: $finalPkg  ($([math]::Round($size / 1GB, 1)) GB)"

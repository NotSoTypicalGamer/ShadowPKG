# Registers (or removes) a scheduled task that runs ShadowPKG-Watch.ps1 hidden at
# every logon, so build jobs are picked up without opening anything.
#
# A scheduled task rather than a Windows service on purpose: a service runs in
# its own session, where the mapped drive letters (R:) do not exist, and the
# library is reached through one. A task at logon runs as you, in your session.
#
#   Install-ShadowPKG-Builder.ps1              register and start it
#   Install-ShadowPKG-Builder.ps1 -Uninstall   stop and remove it
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$name = 'ShadowPKG Builder'

if ($Uninstall) {
    Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue | ForEach-Object {
        Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        Write-Host "Removed '$name'."
    }
    exit 0
}

$watch = Join-Path $PSScriptRoot 'ShadowPKG-Watch.ps1'
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'builder.json'))) {
    Write-Host 'Warning: there is no builder.json next to this script yet, so the watcher will have nothing to work from.' -ForegroundColor Yellow
}
$me = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $watch)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Runs ShadowPKG build jobs on this PC as they appear.' -Force | Out-Null
Start-ScheduledTask -TaskName $name
Write-Host "Registered '$name' to start at every logon, and started it now."
Write-Host "Its log: $(Join-Path $PSScriptRoot 'watch.log')"

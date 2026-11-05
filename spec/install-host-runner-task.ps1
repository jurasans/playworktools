# Registers a hidden, auto-restarting Windows scheduled task that keeps the spec-web host-runner running.
# Usage: powershell -File tools\spec\install-host-runner-task.ps1 [-Remove]
# Runs as the current user (needs your AWS credentials, python venv and claude login), so it starts at your logon.
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$name = 'Playwork host-runner'
if ($Remove) { Unregister-ScheduledTask -TaskName $name -Confirm:$false; Write-Host "removed $name"; return }

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$envFile = Join-Path $root 'tools\spec-web\.env'
$token = $null
if (Test-Path $envFile) { $m = Select-String -Path $envFile -Pattern '^HOST_RUNNER_TOKEN=(.+)$'; if ($m) { $token = $m.Matches[0].Groups[1].Value.Trim() } }
if (-not $token -or $token.Length -lt 24) {
  $token = -join ((1..48) | % { '{0:x}' -f (Get-Random -Max 16) })
  Add-Content -Path $envFile -Value "HOST_RUNNER_TOKEN=$token"
  Write-Host "generated HOST_RUNNER_TOKEN in tools\spec-web\.env (gitignored; docker compose reads it)"
}
$node = (Get-Command node).Source
$launcher = Join-Path $PSScriptRoot 'host-runner-launch.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`" -Node `"$node`" -Root `"$root`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'Runs tools/spec/host-runner.mjs for spec-web (Docker). Invisible.' -Force | Out-Null
Start-ScheduledTask -TaskName $name
Write-Host "installed '$name' (starts at logon, restarts if it dies, no window). Recreate the container so it sees the token: docker compose up -d"

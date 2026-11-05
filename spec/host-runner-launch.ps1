# Started by the scheduled task: loads HOST_RUNNER_TOKEN from tools\spec-web\.env and runs the host-runner without a window.
param([string]$Node, [string]$Root)
$envFile = Join-Path $Root 'tools\spec-web\.env'
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*(HOST_RUNNER_TOKEN|MANAGE_PASSWORD)=(.+)$') { Set-Item -Path "env:$($Matches[1])" -Value $Matches[2].Trim() }
  }
}
Set-Location $Root
& $Node (Join-Path $Root 'tools\spec\host-runner.mjs') *> (Join-Path $Root 'tools\spec-web\documentation\state\host-runner.log')
exit $LASTEXITCODE

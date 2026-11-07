# Deploy Wasbeer from GIGA-CARL to RTX-EPE.
#
#   powershell -File deploy.ps1
#
# Idempotent and rerunnable. Pushes committed code to a bare repo on RTX-EPE,
# fast-forwards the working copy there, runs deploy\rtxepe-setup.ps1 (which
# creates the task and firewall rule the first time), restarts the task, and
# checks the app answers.
#
# It only ever touches paths and names beginning with "Wasbeer". Nothing
# belonging to PoseGenerator is read, written or restarted.
#
# One-time prerequisite: GIGA-CARL's public key id_ed25519_wasbeer.pub must be a
# line in C:\ProgramData\ssh\administrators_authorized_keys on RTX-EPE.
$ErrorActionPreference = 'Stop'

$App   = 'Wasbeer'
$Box   = 'ljack@192.168.2.3'
$Host4 = '192.168.2.3'
$Port  = 8099
$Bare  = 'C:\Wasbeer.git'
$Work  = 'C:\Wasbeer'
$Key   = Join-Path $env:USERPROFILE '.ssh\id_ed25519_wasbeer'
$Repo  = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path $Key)) { throw "missing key $Key - see the README's deployment section" }

function Remote([string]$PowerShellCommand) {
  # RTX-EPE's default shell is cmd, so PowerShell has to be invoked explicitly
  & ssh -i $Key -o BatchMode=yes -o ConnectTimeout=10 $Box `
    "powershell -NoProfile -ExecutionPolicy Bypass -Command `"$PowerShellCommand`""
  if ($LASTEXITCODE) { throw "remote command failed: $PowerShellCommand" }
}

Write-Host "1/6 checking the connection"
Remote "if (`$env:COMPUTERNAME -ne 'RTX-EPE') { throw 'wrong host' }; '  on ' + `$env:COMPUTERNAME"

Write-Host "2/6 bare repo"
Remote "if (-not (Test-Path '$Bare')) { git init --bare '$Bare' | Out-Null; '  created $Bare' } else { '  $Bare already there' }"

Write-Host "3/6 pushing"
$env:GIT_SSH_COMMAND = "ssh -i `"$Key`" -o BatchMode=yes"
if (-not (git -C $Repo remote | Select-String -Quiet '^rtxepe$')) {
  git -C $Repo remote add rtxepe "ssh://$Box/$($Bare -replace '\\','/')"
  "  remote 'rtxepe' added"
}
git -C $Repo push -q rtxepe main
if ($LASTEXITCODE) { throw "push failed" }
"  pushed $(git -C $Repo rev-parse --short HEAD)"

Write-Host "4/6 working copy"
Remote "if (-not (Test-Path '$Work')) { git clone -q '$Bare' '$Work'; '  cloned into $Work' } else { git -C '$Work' pull -q --ff-only; '  fast-forwarded' }; git -C '$Work' log --oneline -1"

Write-Host "5/6 task and firewall"
Remote "& '$Work\deploy\rtxepe-setup.ps1'"

Write-Host "6/6 restarting"
Remote "Stop-ScheduledTask -TaskName '$App' -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 700; Start-ScheduledTask -TaskName '$App'; '  task $App started'"

Start-Sleep -Seconds 3
try {
  $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "http://${Host4}:$Port/api/token"
  $meta = $r.Content | ConvertFrom-Json
  "answers: HTTP $($r.StatusCode) at http://${Host4}:$Port"
  if (-not $meta.present) { "  no token yet - open the app and use the key button in the header" }
  elseif ($meta.likelyExpired) { "  token is probably expired - use the key button in the header" }
  else { "  token present$(if ($meta.hoursLeft) { ", about $($meta.hoursLeft)h left" })" }
} catch {
  "answers: " + $_.Exception.Message
  "  check the task's last result: Get-ScheduledTaskInfo -TaskName $App"
}

# Runs ON RTX-EPE, from the deployed working copy: C:\Wasbeer\deploy\rtxepe-setup.ps1
#
# Idempotent. deploy.ps1 on GIGA-CARL calls this after every push; running it by
# hand is harmless. It only ever touches things named Wasbeer.
#
#   .env            device id and port (the TOKEN is not written here -- paste it
#                   into the app's key page, which writes this same file)
#   task Wasbeer    starts at boot, runs whether or not anyone is logged in
#   rule Wasbeer-In inbound TCP on $Port, local subnet only
$ErrorActionPreference = 'Stop'

$App     = 'Wasbeer'
$Root    = 'C:\Wasbeer'
$Port    = 8099
$Node    = 'C:\Program Files\nodejs\node.exe'
$EnvFile = Join-Path $Root '.env'

if (-not (Test-Path $Root)) { throw "$Root is missing - run deploy.ps1 from GIGA-CARL first" }
if (-not (Test-Path $Node)) { throw "node not found at $Node" }

# --- git safety: the task may run as a different identity than the one that cloned
& git config --global --add safe.directory 'C:/Wasbeer' 2>$null
$global:LASTEXITCODE = 0

# --- .env ------------------------------------------------------------------
# Created once with the device id and port. The token is deliberately absent:
# it expires every 24h, so it is pasted through the app's own key page, which
# rewrites this file. An existing .env is never overwritten.
if (-not (Test-Path $EnvFile)) {
  @(
    '# Wasbeer. The token is set through the app (key button in the header).'
    'SMARTTHINGS_TOKEN='
    'SMARTTHINGS_DEVICE_ID='
    "PORT=$Port"
  ) | Set-Content -Path $EnvFile -Encoding ascii
  "  .env created - set SMARTTHINGS_DEVICE_ID, then paste a token in the app"
} else {
  "  .env already there, left alone"
}

# --- scheduled task --------------------------------------------------------
$existing = Get-ScheduledTask -TaskName $App -ErrorAction SilentlyContinue
if ($existing) {
  "  task $App already registered"
} else {
  $action = New-ScheduledTaskAction -Execute $Node `
    -Argument '--env-file-if-exists=.env src\server.mjs' -WorkingDirectory $Root
  $trigger = New-ScheduledTaskTrigger -AtStartup
  # S4U: runs with no one logged in and without storing a password
  $principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$env:USERNAME" `
    -LogonType S4U -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $App -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Description 'Wasbeer washer panel' | Out-Null
  "  task $App registered (starts at boot)"
}

# --- firewall --------------------------------------------------------------
$rule = Get-NetFirewallRule -Name "$App-In" -ErrorAction SilentlyContinue
if ($rule) {
  "  firewall rule $App-In already there"
} else {
  New-NetFirewallRule -Name "$App-In" -DisplayName "$App-In" -Direction Inbound `
    -Action Allow -Protocol TCP -LocalPort $Port -Profile Any -RemoteAddress LocalSubnet |
    Out-Null
  "  firewall rule $App-In added (TCP $Port, local subnet only)"
}

"setup ok"

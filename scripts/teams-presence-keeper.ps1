<#
  Teams Presence Keeper

  Keeps the Windows session from going idle so Microsoft Teams reports
  "Available" instead of flipping to "Away" after its idle timeout.

  How it works:
    - Injects a VK_F15 key event once per interval. F15 is not present on any
      modern physical keyboard, so no application reacts to it, but it does
      reset the GetLastInputInfo idle timer that Teams reads.
    - Holds ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED so the
      machine will not sleep or blank the display while the keeper runs.

  This does NOT work around a locked workstation: if you lock the PC (Win+L),
  Teams goes Away regardless. It only prevents the *idle* transition.

  Embedded in and started/stopped by src-tauri/src/commands/presence.rs. It writes a
  heartbeat file each tick so the UI can tell a live keeper from a stale PID.
#>
param(
    [ValidateRange(15, 240)]
    [int]$IntervalSeconds = 60,

    [Parameter(Mandatory = $true)]
    [string]$HeartbeatPath
)

$ErrorActionPreference = 'Stop'

# Give the process an identifiable window title instead of the default
# "Windows PowerShell", so it is recognisable in Task Manager's details view.
try { $Host.UI.RawUI.WindowTitle = 'TeamsPresenceKeeper' } catch {}

Add-Type -Namespace Singl -Name TeamsPresence -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)]
public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@

$ES_CONTINUOUS       = [uint32]2147483648  # 0x80000000
$ES_SYSTEM_REQUIRED  = [uint32]1           # 0x00000001
$ES_DISPLAY_REQUIRED = [uint32]2           # 0x00000002
$KEEP_AWAKE = [uint32]($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED -bor $ES_DISPLAY_REQUIRED)

$VK_F15          = [byte]0x7E
$KEYEVENTF_KEYUP = [uint32]2

$heartbeatDir = Split-Path -Parent $HeartbeatPath
if ($heartbeatDir -and -not (Test-Path $heartbeatDir)) {
    New-Item -ItemType Directory -Path $heartbeatDir -Force | Out-Null
}

try {
    while ($true) {
        # Re-asserted every tick: the flag is per-thread and cheap to set.
        [Singl.TeamsPresence]::SetThreadExecutionState($KEEP_AWAKE) | Out-Null

        [Singl.TeamsPresence]::keybd_event($VK_F15, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 40
        [Singl.TeamsPresence]::keybd_event($VK_F15, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)

        Set-Content -Path $HeartbeatPath -Encoding utf8 -Value ((Get-Date).ToUniversalTime().ToString('o'))

        Start-Sleep -Seconds $IntervalSeconds
    }
}
finally {
    # Release the sleep/display lock on a clean exit. A forced kill skips this,
    # but Windows drops the execution state when the process dies anyway.
    [Singl.TeamsPresence]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
}

# Puts ONE shortcut on your desktop: "pi on my phone".
#
#   npm run desktop           install it
#   npm run desktop:remove    take it away
#
# There is no separate Stop any more. Double-clicking opens a window; while that
# window is open the bridge is running and Tailscale points your PC's https name
# at it. Close the window and everything stops. The window is the switch.

param([switch]$Remove)

$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent $PSScriptRoot
$desktop    = [Environment]::GetFolderPath("Desktop")
$launcher   = Join-Path $projectDir "scripts\pi-window.cmd"
$iconDir    = Join-Path $projectDir "scripts\icons"

$linkPath = Join-Path $desktop "pi on my phone.lnk"

# the green/red pair this replaced, plus the hidden shim they ran through
$legacy = @(
    (Join-Path $desktop "Start pi on phone.lnk"),
    (Join-Path $desktop "Stop pi on phone.lnk"),
    (Join-Path $projectDir "scripts\phone-link-hidden.vbs")
)

if ($Remove) {
    $gone = 0
    foreach ($old in @($linkPath) + $legacy) {
        if (Test-Path $old) { Remove-Item $old -Force; $gone++ }
    }
    Write-Output ""
    if ($gone -gt 0) { Write-Output "  Removed $gone item(s)." } else { Write-Output "  Nothing to remove." }
    Write-Output ""
    exit 0
}

# clear out the old two-icon setup so the desktop does not end up with three
foreach ($old in $legacy) {
    if (Test-Path $old) { Remove-Item $old -Force }
}

if (-not (Test-Path (Join-Path $iconDir "pi.ico"))) {
    Push-Location $projectDir
    try { node (Join-Path $projectDir "scripts\make-desktop-icons.mjs") | Out-Null } finally { Pop-Location }
}

$wsh = New-Object -ComObject WScript.Shell
$lnk = $wsh.CreateShortcut($linkPath)
$lnk.TargetPath       = $launcher
$lnk.WorkingDirectory = $projectDir
$lnk.IconLocation     = Join-Path $iconDir "pi.ico"
$lnk.Description      = "Open the phone link to pi. Close the window to turn it off."
$lnk.Save()

Write-Output ""
Write-Output "  Done. One shortcut on your desktop:  pi on my phone"
Write-Output ""
Write-Output "    Double-click   a window opens, the bridge starts, Tailscale points"
Write-Output "                   your https name at it, and the window shows the"
Write-Output "                   address to open on your phone."
Write-Output ""
Write-Output "    Close it       bridge stops, pi sessions stop, Tailscale door shuts."
Write-Output "                   Nothing is left listening."
Write-Output ""
Write-Output "  The old green Start / red Stop pair has been removed."
Write-Output ""

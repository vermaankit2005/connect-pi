# Makes the connect-pi bridge start automatically when you log into Windows,
# running hidden in the background.
#
#   npm run autostart          install
#   npm run autostart:remove   uninstall

param([switch]$Remove)

$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent $PSScriptRoot
$startup    = [Environment]::GetFolderPath("Startup")
$shortcut   = Join-Path $startup "connect-pi.lnk"
$launcher   = Join-Path $projectDir "scripts\connect-pi-hidden.vbs"

if ($Remove) {
    if (Test-Path $shortcut) {
        Remove-Item $shortcut -Force
        Write-Output "Removed autostart. connect-pi will no longer start with Windows."
    } else {
        Write-Output "Autostart was not installed."
    }
    exit 0
}

# tiny VBScript wrapper: runs node with no console window
$vbs = @"
' Starts the connect-pi bridge with no visible console window.
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "$projectDir"
shell.Run "node ""$projectDir\server\index.js""", 0, False
"@
Set-Content -Path $launcher -Value $vbs -Encoding utf8

$wsh = New-Object -ComObject WScript.Shell
$lnk = $wsh.CreateShortcut($shortcut)
$lnk.TargetPath       = "wscript.exe"
$lnk.Arguments        = """$launcher"""
$lnk.WorkingDirectory = $projectDir
$lnk.Description      = "connect-pi bridge (phone remote for pi)"
$lnk.Save()

Write-Output ""
Write-Output "  Done. connect-pi will now start automatically when you log in."
Write-Output "  Shortcut: $shortcut"
Write-Output ""
Write-Output "  To start it right now without rebooting:"
Write-Output "    wscript `"$launcher`""
Write-Output ""

@echo off
rem  The window IS the switch.
rem
rem  While this window is open the bridge is running and Tailscale is pointing
rem  the PC's https name at it. Close the window and the bridge stops, the pi
rem  sessions it started stop, and the Tailscale door shuts behind it.
rem
rem  Started by the "pi on my phone" shortcut on the desktop.

title pi on my phone

cd /d "%~dp0.."

rem Home WiFi is never opened by this app. Force it shut on every start, so an
rem old setting or a half-finished run can never leave it drifting open.
node "scripts\allow-wifi.mjs" off >nul 2>&1

rem Clear out a bridge left behind by a window that was killed rather than
rem closed, otherwise this one cannot bind the port.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $p.Id -Force } }" >nul 2>&1

rem Run in the foreground: this window's lifetime is the bridge's lifetime.
node "server\index.js"

rem Reached on a normal exit (Ctrl+C, or the server stopping). A hard window
rem close never gets here - server/index.js shuts the Tailscale door itself
rem from its own exit handler, which is why that belt exists as well as this one.
echo.
echo   Bridge stopped. Closing the Tailscale door...
node -e "import('./server/tailscale.js').then(t=>{t.serveOn(4317);t.serveOff();})" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "& 'C:\Program Files\Tailscale\tailscale.exe' serve --bg off" >nul 2>&1
echo   Done. Nothing is listening.
timeout /t 3 >nul

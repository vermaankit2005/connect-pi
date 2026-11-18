@echo off
title pi on my phone
cd /d "%~dp0.."
node "scripts\phone.mjs" foreground
if errorlevel 1 pause

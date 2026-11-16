@echo off
REM Relay'i kendi bilgisayarinda dene: sonra tarayicida http://localhost:8000/health ac
cd /d "%~dp0"
set RELAY_ONLY=1
node server.js

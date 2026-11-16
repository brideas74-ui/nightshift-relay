@echo off
REM ..\server.js degistiyse relay_deploy\server.js'i guncelle (sonra sunucuya yeniden yukle)
copy /Y "%~dp0..\server.js" "%~dp0server.js"
pause

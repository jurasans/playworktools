@echo off
rem Visible console for one headless Claude run (started by startWorker in runs-lib.mjs).
rem %1 = run id; the host's node comes from PW_NODE because its path may contain spaces.
title Playwork run %1
"%PW_NODE%" "%~dp0agent-run.mjs" %1
echo.
echo ===== Run finished. This window closes in 2 minutes; press any key to close it now. =====
rem Full path: a GNU timeout earlier on PATH (Git Bash) rejects /t and the window would close at once.
"%SystemRoot%\System32\timeout.exe" /t 120 >nul

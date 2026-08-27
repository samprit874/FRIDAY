@echo off
title FRIDAY 1.0.0 — Fresh User Simulation Test
echo ========================================================
echo   TESTING FRIDAY AS A BRAND NEW USER (100%% ISOLATED)
echo   - Your personal FRIDAY in D:\testing\FRIDAY is UNTOUCHED
echo   - Runs with a blank profile, zero memories, and Setup Wizard
echo ========================================================
echo.

set TEST_PROFILE=%TEMP%\friday_test_fresh_user_%RANDOM%
mkdir "%TEST_PROFILE%" >nul 2>&1

echo Starting FRIDAY from D:\testing\Friday1 with isolated sandbox data...
start "" "D:\testing\Friday1\FRIDAY.exe" --user-data-dir="%TEST_PROFILE%"

echo.
echo [DONE] FRIDAY launched in a clean isolated test sandbox!
pause

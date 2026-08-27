@echo off
rem -- Launch FRIDAY silently from the Windows startup entry.
rem    The single-instance lock in main.cjs ensures only one FRIDAY window
rem    is visible even if this fires alongside the desktop shortcut.
start "" "D:\testing\MYRAA\FRIDAY.exe"
exit

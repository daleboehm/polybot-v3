@echo off
REM ================================================================
REM CLEANUP: Move Polymarket files from CLAUDE root into Polymarket\
REM
REM Usage: cd to your CLAUDE folder, then run:
REM   Polymarket\deploy\cleanup_polymarket_root.bat
REM ================================================================

setlocal EnableDelayedExpansion

echo ================================================================
echo   CLEANUP: Consolidate Polymarket files
echo ================================================================
echo.

REM --- Create target directories ---
if not exist "Polymarket\redeem" mkdir "Polymarket\redeem"
if not exist "Polymarket\docs" mkdir "Polymarket\docs"

set MOVED=0

REM --- Move redeem scripts and logs ---
if exist "auto_redeem.py" (
    echo   Moving auto_redeem.py
    move "auto_redeem.py" "Polymarket\redeem\" >nul
    set /a MOVED+=1
)
if exist "check_redeem.py" (
    echo   Moving check_redeem.py
    move "check_redeem.py" "Polymarket\redeem\" >nul
    set /a MOVED+=1
)
if exist "redeem_research.txt" (
    echo   Moving redeem_research.txt
    move "redeem_research.txt" "Polymarket\redeem\" >nul
    set /a MOVED+=1
)
if exist "redeem_output.txt" (
    echo   Moving redeem_output.txt
    move "redeem_output.txt" "Polymarket\redeem\" >nul
    set /a MOVED+=1
)
if exist "redeem_run.txt" (
    echo   Moving redeem_run.txt
    move "redeem_run.txt" "Polymarket\redeem\" >nul
    set /a MOVED+=1
)
if exist "redeem_run2.txt" (
    echo   Moving redeem_run2.txt
    move "redeem_run2.txt" "Polymarket\redeem\" >nul
    set /a MOVED+=1
)
if exist "redeem_run3.txt" (
    echo   Moving redeem_run3.txt
    move "redeem_run3.txt" "Polymarket\redeem\" >nul
    set /a MOVED+=1
)

REM --- Move docs / status files ---
if exist "ams3-deployment-status.md" (
    echo   Moving ams3-deployment-status.md
    move "ams3-deployment-status.md" "Polymarket\docs\" >nul
    set /a MOVED+=1
)
if exist "sshtest.txt" (
    echo   Moving sshtest.txt
    move "sshtest.txt" "Polymarket\docs\" >nul
    set /a MOVED+=1
)
if exist "polymarket-comprehensive-research.md" (
    echo   Moving polymarket-comprehensive-research.md
    move "polymarket-comprehensive-research.md" "Polymarket\docs\" >nul
    set /a MOVED+=1
)

REM --- Remove duplicates (already exist in Polymarket\) ---
if exist "polymarket-simulation-playbook-2026-03-15.xlsx" (
    echo   Removing duplicate: polymarket-simulation-playbook-2026-03-15.xlsx
    del "polymarket-simulation-playbook-2026-03-15.xlsx" >nul
    set /a MOVED+=1
)
if exist ".lock.polymarket-simulation-playbook-2026-03-15.xlsx" (
    echo   Removing lock file
    del ".lock.polymarket-simulation-playbook-2026-03-15.xlsx" >nul
    set /a MOVED+=1
)

echo.
echo ================================================================
echo   DONE -- !MOVED! files moved or cleaned
echo.
echo   Polymarket\redeem\   -- redemption scripts and logs
echo   Polymarket\docs\     -- deployment status and research
echo   Polymarket\deploy\   -- VPS deploy scripts and SSH keys
echo   Polymarket\scripts\  -- trading bot scripts
echo ================================================================

endlocal
pause

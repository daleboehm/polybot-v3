@echo off
REM ═══════════════════════════════════════════════════════════════
REM DEPLOY auto_redeem.py v3 → VPS (209.38.40.80)
REM
REM Usage: Open cmd, cd to your CLAUDE folder, then run:
REM   Polymarket\deploy\deploy_auto_redeem_v3.bat
REM ═══════════════════════════════════════════════════════════════

setlocal

set VPS_IP=178.62.225.235
set VPS_USER=root
set SSH_KEY=%~dp0armorstack_vps_key
set REMOTE_DIR=/opt/polybot
REM Check new location first (Polymarket\redeem\), fall back to old root location
set LOCAL_SCRIPT=%~dp0..\redeem\auto_redeem.py
if not exist "%LOCAL_SCRIPT%" set LOCAL_SCRIPT=%~dp0..\..\auto_redeem.py

echo ═══════════════════════════════════════════════════════
echo   DEPLOY auto_redeem.py v3 → VPS
echo ═══════════════════════════════════════════════════════
echo.

REM ─── PREFLIGHT ─────────────────────────────────────────
if not exist "%SSH_KEY%" (
    echo ERROR: SSH key not found: %SSH_KEY%
    exit /b 1
)

if not exist "%LOCAL_SCRIPT%" (
    echo ERROR: auto_redeem.py not found: %LOCAL_SCRIPT%
    exit /b 1
)

echo   SSH Key:   %SSH_KEY%
echo   Script:    %LOCAL_SCRIPT%
echo   Target:    %VPS_USER%@%VPS_IP%:%REMOTE_DIR%/
echo.

REM ─── 1. BACKUP CURRENT VERSION ────────────────────────
echo [1/4] Backing up current auto_redeem.py on VPS...
ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %VPS_USER%@%VPS_IP% "if [ -f %REMOTE_DIR%/auto_redeem.py ]; then cp %REMOTE_DIR%/auto_redeem.py %REMOTE_DIR%/auto_redeem.py.bak.$(date +%%Y%%m%%d_%%H%%M%%S); echo '   Backup created'; else echo '   No existing file to back up'; fi"

REM ─── 2. UPLOAD V3 ─────────────────────────────────────
echo [2/4] Uploading auto_redeem.py v3...
scp -i "%SSH_KEY%" -o StrictHostKeyChecking=no "%LOCAL_SCRIPT%" %VPS_USER%@%VPS_IP%:%REMOTE_DIR%/auto_redeem.py
echo    Uploaded

REM ─── 3. ENSURE STATE DIR + PERMISSIONS ─────────────────
echo [3/4] Ensuring state directory and permissions...
ssh -i "%SSH_KEY%" %VPS_USER%@%VPS_IP% "mkdir -p %REMOTE_DIR%/state && chmod +x %REMOTE_DIR%/auto_redeem.py && echo '   Ready'"

REM ─── 4. VERIFY ────────────────────────────────────────
echo [4/4] Verifying deployment...
ssh -i "%SSH_KEY%" %VPS_USER%@%VPS_IP% "echo '' && echo '  File check:' && ls -la /opt/polybot/auto_redeem.py && echo '' && echo '  Version check:' && head -3 /opt/polybot/auto_redeem.py && echo '' && echo '  Dependencies check:' && (source /opt/polybot/venv/bin/activate 2>/dev/null || source /opt/armorstack/venv/bin/activate 2>/dev/null) && python3 -c 'from web3 import Web3; import requests; print(\"   web3 + requests OK\")' 2>/dev/null || echo '   Missing deps' && echo '' && echo '  api_keys.json check:' && if [ -f /opt/polybot/api_keys.json ]; then echo '   Found at /opt/polybot/api_keys.json'; elif [ -f /opt/polybot/state/api_keys.json ]; then echo '   Found at state/ — symlinking...' && ln -sf /opt/polybot/state/api_keys.json /opt/polybot/api_keys.json && echo '   Symlinked'; elif [ -f /opt/armorstack/polymarket/state/api_keys.json ]; then echo '   Found at /opt/armorstack/ — symlinking...' && ln -sf /opt/armorstack/polymarket/state/api_keys.json /opt/polybot/api_keys.json && echo '   Symlinked'; else echo '   NOT FOUND'; fi && echo '' && echo '  Cron check:' && (crontab -l 2>/dev/null | grep -i redeem || echo '   No auto_redeem cron entry yet')"

echo.
echo ═══════════════════════════════════════════════════════
echo   DEPLOYMENT COMPLETE
echo.
echo   To run manually:
echo     ssh -i "%SSH_KEY%" root@%VPS_IP%
echo     source /opt/polybot/venv/bin/activate
echo     python3 /opt/polybot/auto_redeem.py
echo.
echo   To add to cron (every 30 min):
echo     ssh -i "%SSH_KEY%" root@%VPS_IP%
echo     crontab -e
echo     */30 * * * * /opt/polybot/venv/bin/python3 /opt/polybot/auto_redeem.py ^>^> /opt/polybot/logs/redeem.log 2^>^&1
echo ═══════════════════════════════════════════════════════

endlocal
pause

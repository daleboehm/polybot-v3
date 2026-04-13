@echo off
REM ============================================================
REM   DEPLOY AUTO-DEPOSIT TO VPS (ONE-CLICK)
REM   Closes the loop: redeem -> deposit -> trade -> exit -> repeat
REM   Run from: CLAUDE folder
REM ============================================================

set VPS_IP=178.62.225.235
set SSH_KEY=Polymarket\deploy\armorstack_vps_key
set REMOTE_PATH=/opt/polybot
set VENV=%REMOTE_PATH%/venv/bin/python3

echo.
echo ============================================================
echo   STEP 1/7: Upload auto_deposit.py to VPS
echo ============================================================
scp -i %SSH_KEY% Polymarket\scripts\auto_deposit.py root@%VPS_IP%:%REMOTE_PATH%/auto_deposit.py
if errorlevel 1 (
    echo FAILED: Could not upload auto_deposit.py
    goto :end
)
echo SUCCESS: auto_deposit.py uploaded

echo.
echo ============================================================
echo   STEP 2/7: Add working RPC URL to api_keys.json
echo ============================================================
ssh -i %SSH_KEY% root@%VPS_IP% "%VENV% -c 'import json; k=json.load(open(\"/opt/polybot/api_keys.json\")); k[\"POLY_RPC_URL\"]=\"https://polygon-bor-rpc.publicnode.com\"; json.dump(k, open(\"/opt/polybot/api_keys.json\",\"w\"), indent=2); print(\"RPC URL added:\", k[\"POLY_RPC_URL\"])'"
echo.

echo.
echo ============================================================
echo   STEP 3/7: Dry run (check balances, no execution)
echo ============================================================
ssh -i %SSH_KEY% root@%VPS_IP% "%VENV% %REMOTE_PATH%/auto_deposit.py"
echo.
echo -- Review the output above. --
echo -- You should see On-chain USDC.e balance around $181 --
echo -- Press any key to proceed with LIVE deposit --
echo.
pause

echo.
echo ============================================================
echo   STEP 4/7: LIVE RUN - Refresh CLOB balance
echo ============================================================
ssh -i %SSH_KEY% root@%VPS_IP% "%VENV% %REMOTE_PATH%/auto_deposit.py --execute"
echo.

echo.
echo ============================================================
echo   STEP 5/7: Add auto_deposit to cron
echo ============================================================
ssh -i %SSH_KEY% root@%VPS_IP% "(crontab -l 2>/dev/null | grep -v auto_deposit; echo '5,35 * * * * /opt/polybot/venv/bin/python3 /opt/polybot/auto_deposit.py --execute >> /opt/polybot/logs/deposit.log 2>&1') | crontab -"
if errorlevel 1 (
    echo FAILED: Could not update cron
    goto :end
)
echo SUCCESS: auto_deposit cron added (runs at :05 and :35)

echo.
echo ============================================================
echo   STEP 6/7: Disable sprint_trader Cowork scheduled task
echo ============================================================
echo NOTE: Cowork scheduled tasks already disabled by Claude.
echo All execution now runs via VPS cron only.
echo.

echo.
echo ============================================================
echo   STEP 7/7: Verify full cron schedule
echo ============================================================
ssh -i %SSH_KEY% root@%VPS_IP% "crontab -l"

echo.
echo ============================================================
echo   DEPLOYMENT COMPLETE - FULL AUTOMATED LOOP ACTIVE
echo ============================================================
echo.
echo   VPS Cron Schedule:
echo     */5      arb_executor.py     Dutch book scanner
echo     */15     sprint_trader       Kelly-sized trades
echo     */15     position_monitor    Exit engine
echo     :00/:30  auto_redeem.py      Claim resolved -> USDC
echo     :05/:35  auto_deposit.py     Refresh CLOB balance
echo     hourly   sync_to_drive.sh    Backup to Google Drive
echo.
echo   Money flow (fully automated):
echo     Trade -> Win/Lose -> Resolve -> Redeem USDC -> Refresh CLOB -> Trade
echo.
echo   Monitor logs:
echo     ssh -i %SSH_KEY% root@%VPS_IP% "tail -20 /opt/polybot/logs/deposit.log"
echo     ssh -i %SSH_KEY% root@%VPS_IP% "tail -20 /opt/polybot/logs/arb.log"
echo     ssh -i %SSH_KEY% root@%VPS_IP% "tail -20 /opt/polybot/logs/exits.log"
echo.

:end
pause

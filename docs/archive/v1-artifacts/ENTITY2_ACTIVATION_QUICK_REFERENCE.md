# Entity #2 Activation Quick Reference

## Wallet Address (FUND THIS)
```
0x5F7d1350c1f7e1d1a15e29F59E662d7197103c57
```
**Network**: Polygon (MATIC)
**Required**: $500+ USDC minimum for trading
**Current balance**: $0.00 (INSUFFICIENT)

## Critical Fixes Needed

### 1. Fund Wallet (Priority: CRITICAL)
Send USDC to the above address via:
- CEX to Polygon bridge (Coinbase, Kraken, etc.)
- Existing Polygon USDC (if you have funds elsewhere)
- Target: $500-$1000 recommended

### 2. Configure API Keys (Priority: CRITICAL)
**File**: `/opt/armorstack/api_keys.json`
**Status**: Currently empty/invalid

**Required structure**:
```json
{
  "private_key": "0x<64_hex_characters>",
  "public_key": "0x<40_hex_characters>",
  "rpc_endpoint": "https://polygon-rpc.com",
  "trading_keys": {
    "polymarket_api_key": "your_api_key_here",
    "polymarket_secret": "your_secret_here"
  }
}
```

**How to populate**:
1. SSH to VPS: `ssh -i armorstack_vps_key -p 2222 root@178.62.225.235`
2. Read wallet private key: `cat /opt/armorstack/wallet.json | jq .private_key`
3. Extract public key from wallet (derive from private key)
4. Create api_keys.json with above structure
5. Set permissions: `chmod 600 /opt/armorstack/api_keys.json`

### 3. Verify Configuration (Priority: HIGH)
**File**: `/opt/armorstack/config.py`
**Status**: ✅ Syntax valid, but verify parameters

**Check these settings**:
```python
# Should contain:
TRADING_ENABLED = False  # Keep False until funding confirmed
PORTFOLIO_SIZE = 500     # Or whatever you're funding
MAX_POSITION = 50        # Per-market position limit
API_ENDPOINT = "https://gamma-api.polymarket.com"
```

## Activation Checklist

- [ ] **Wallet Funded**: Confirm $500+ USDC on Polygon
- [ ] **API Keys Configured**: api_keys.json populated and tested
- [ ] **Config Reviewed**: TRADING_ENABLED still False
- [ ] **Port 8081 Online**: Dashboard accessible
- [ ] **Paper Trade Test**: Run `auto_trader.py --dry-run` successfully
- [ ] **Go-Live**: Set TRADING_ENABLED = True in config.py

## Current System Status

| Check | Status | Details |
|-------|--------|---------|
| Directory | ✅ | /opt/armorstack exists |
| Config syntax | ✅ | config.py valid Python |
| Dashboard | ✅ | Port 8081 responding |
| Wallet file | ✅ | wallet.json exists |
| **Wallet balance** | ❌ | $0.00 (need funding) |
| **API keys** | ❌ | Incomplete/invalid |

## Activation Timeline

Once funding + keys are in place:

1. **Config verification** (5 min) — manually spot-check config.py
2. **Connection test** (10 min) — test API connectivity
3. **Paper trading** (30 min) — run dry-run to verify execution
4. **Go-live** (5 min) — set TRADING_ENABLED = True, start auto_trader.py
5. **Monitoring** (ongoing) — watch logs for performance

**Total time to activation**: ~1 hour

## Contact & Support

To check Entity #2 status anytime:
```bash
ssh -i armorstack_vps_key -p 2222 root@178.62.225.235 \
  "cd /opt/polybot && /opt/polybot/venv/bin/python3 entity2_activation_check.py"
```

Output: Full JSON report saved to `/opt/polybot/state/entity2_activation_report.json`

---

**Last updated**: 2026-03-30 05:15 UTC
**Status**: Awaiting funding + API key configuration

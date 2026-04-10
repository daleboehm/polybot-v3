# Polymarket AMS3 Desktop — Deployment Summary

**Last Updated:** 2026-03-22 (Claude Desktop workspace deployed with full trading engine)
**Author:** Dale Boehm / Claude
**Classification:** Internal — Armorstack Operations

---

## 1. Infrastructure Overview

### Host Server (DigitalOcean Droplet)
- **Provider:** DigitalOcean, Amsterdam AMS3 datacenter
- **IP Address:** 178.62.225.235
- **Plan:** $48/mo — 8GB RAM, 4 vCPUs, 160GB SSD, 5TB transfer
- **OS:** Ubuntu 24.04.4 LTS (kernel 6.8.0-106-generic)
- **Hostname:** armorstack-vps-ams3
- **Created from:** Snapshot of previous droplet (preserved bot state + dashboard)
- **SSH Key:** `armorstack_vps_key` (stored in `Polymarket/deploy/`)

### Windows 11 VM (KVM/QEMU)
- **Hypervisor:** KVM with QEMU, managed by libvirt
- **Machine Type:** q35 with PCIe, OVMF UEFI firmware
- **VM Name:** win11
- **Resources:** 4GB RAM, 2 vCPUs
- **Disk:** 64GB qcow2 (thin-provisioned) at `/opt/vm/disks/win11.qcow2`
- **TPM:** swtpm 2.0 emulation (tpm-crb model)
- **Network:** VirtIO NIC on libvirt default NAT (192.168.122.0/24)
- **Static IP:** 192.168.122.10 (DHCP reservation via libvirt)
- **Graphics:** QXL + VNC on port 5900
- **Storage Driver:** VirtIO SCSI (viostor)
- **OS:** Windows 11 Pro 25H2 (build 26100.1)
- **Local Admin:** `dale` / `Armorstack2026!`
- **Computer Name:** ARMORSTACK-VM

### Network Topology
```
Internet → 178.62.225.235 (eth0)
              ├─ :22    → SSH (host)
              ├─ :80    → nginx → dashboard_server.py :8080
              ├─ :443   → nginx → dashboard_server.py :8080
              ├─ :3389  → iptables NAT → 192.168.122.10:3389 (Windows RDP)
              └─ :6080  → websockify → VNC :5900 (noVNC console)
```

---

## 2. Services Running on Host

### Trading Bot (`/opt/polybot/`)
- **sprint_trader.py** — Main trading engine for Polymarket weather sprint markets
- **dashboard_server.py** — Flask-based web dashboard (port 8080, proxied by nginx)
- **run_sprint.sh** — Execution script for sprint trading runs
- **State:** `/opt/polybot/state/portfolio.json`
- **API Keys:** `/opt/polybot/api_keys.json` (Polymarket CLOB credentials)
- **Wallet:** `/opt/polybot/wallet.json` (Ethereum private key for signing)

### nginx
- Reverse proxy for dashboard on ports 80/443
- Self-signed SSL certificate at `/etc/nginx/ssl/dashboard.{crt,key}`
- Config: `/etc/nginx/sites-available/dashboard`

### noVNC / websockify
- Browser-based VNC console: `https://178.62.225.235:6080/vnc_lite.html`
- SSL cert: `/root/self.pem`
- Proxies VNC :5900 from the Windows VM

### Boot Persistence
- VM auto-starts via `/etc/rc.local`
- iptables rules persisted via `netfilter-persistent`
- RDP NAT forwarding restored on reboot

---

## 3. Current Portfolio State

**Cash:** $72.21 of $100 starting capital
**Total Trades:** 8
**Active Positions:** 7 (all weather sprint YES bets)

| City | Target | Resolve Date | Shares | Entry Price | Amount Risked |
|------|--------|-------------|--------|------------|--------------|
| Tel Aviv | 17°C | 2026-03-23 | 707.2 | $0.016 | $11.58 |
| Chicago | 49°F or below | 2026-03-25 | 476.2 | $0.013 | $6.19 |
| London | 12°C | 2026-03-23 | 153.9 | $0.015 | $2.31 |
| Madrid | 16°C | 2026-03-22 | 400.0 | $0.022 | $8.80 |
| Lucknow | 33°C | 2026-03-23 | 551.7 | $0.017 | $9.38 |
| Tel Aviv | 16°C | 2026-03-22 | 307.7 | $0.028 | $8.62 |
| Warsaw | 12°C | 2026-03-22 | 551.7 | $0.017 | $9.38 |

**Strategy:** Low-price YES shares on daily temperature binary markets. EV threshold ≥5% at entry, medium confidence positions, typical risk $6-12 per trade.

---

## 4. Codebase Structure (CLAUDE/Polymarket/)

### Root Files
- `SKILL.md` — Polymarket trading skill definition
- `ai-polymarket-variance-report.md` — Variance analysis of AI trading approaches
- `polymarket-v5-vs-ecosystem-gap-analysis-2026-03-17.md` — Architecture comparison
- `polymarket-simulation-playbook-2026-03-15.xlsx` — Simulation parameters

### `/dashboard/`
- `index.html` — Main trading dashboard (served via VPS nginx)
- `sprint-dashboard.html` — Sprint-specific dashboard view
- `polymarket-dashboard.jsx` — React component version

### `/deploy/`
- `armorstack_vps_key` / `.pub` — SSH keypair for VPS access
- `setup_vps.sh` — Full VPS provisioning script

### `/scripts/`
- `RUN_TRADES.py` — Trade execution wrapper
- `local_sprint_trader.py` — Local version of sprint trader
- `sprint_trades_ready.json` — Pre-computed trade candidates
- `arb_scanner.py` — Arbitrage opportunity scanner
- `calibration_scorer.py` — Forecast calibration analysis
- `ev_calculator.py` — Expected value computation

### `/scripts/simulator/` (Full Trading Engine — 40+ modules)

**Core Trading:**
- `auto_trader.py` — Main autonomous trading loop (93KB, largest module)
- `live_trader.py` — Live execution bridge
- `sprint_scanner.py` — Sprint market discovery
- `config.py` — Configuration and parameters

**Market Analysis:**
- `arbitrage_scanner.py` — Cross-market arbitrage detection
- `negrisk_scanner.py` — Negative risk market analysis
- `sharp_odds_comparator.py` — Odds comparison with sharp bookmakers
- `clob_orderbook.py` — Central limit order book analysis
- `orderbook_websocket.py` — Real-time orderbook streaming
- `spot_price_feed.py` — External price feeds

**Forecasting:**
- `ensemble_forecaster.py` — Multi-model forecast aggregation
- `bayesian_updater.py` — Bayesian probability updates
- `weather_ensemble.py` — Weather-specific forecasting
- `xgboost_predictor.py` — ML-based prediction
- `calibration_engine.py` — Forecast calibration
- `evidence_scorer.py` — Evidence strength assessment

**Risk & Portfolio:**
- `heat_system.py` — Position heat / risk management
- `hedging_engine.py` — Hedge construction
- `category_caps.py` / `dynamic_category_caps.py` — Exposure limits
- `exit_engine.py` — Exit strategy execution
- `partial_exits.py` — Partial position unwinding
- `slippage_model.py` — Execution slippage estimation
- `dynamic_fees.py` — Fee optimization

**Intelligence:**
- `researcher.py` — Market research engine
- `news_sentiment_pipeline.py` — News sentiment analysis
- `news_speed_pipeline.py` — Breaking news detection
- `news_vector_db.py` — Semantic news search
- `whale_mirror.py` / `whale_tracker.py` — Large trader tracking
- `agent_swarm.py` — Multi-agent market analysis

**Tracking & Reporting:**
- `performance_tracker.py` — P&L and performance metrics
- `trade_journal.py` — Trade logging
- `resolution_tracker.py` — Market resolution monitoring
- `stale_detector.py` — Stale market detection
- `paper_trader.py` — Paper trading simulation

**US Market Access (experimental):**
- `polymarket_us_auth.py` — Authentication for US access
- `polymarket_us_client.py` — Client wrapper
- `polymarket_us_config.py` — Configuration
- `polymarket_us_websocket.py` — WebSocket streaming

### `/scripts/simulator/state/` (Runtime State)
- `portfolio.json` — Current portfolio positions
- `heat_log.json` — Risk heat tracking
- `auto_trade_log.json` — Trade execution log
- `performance.json` — Performance metrics
- `scalp_log.json` / `scalp_state.json` — Scalping activity
- `sprint_run_*.json` — Sprint execution records
- `weather_ensemble_cache.json` — Weather forecast cache
- `kill_switch.json` — Emergency stop flag
- `api_keys.json` — API credentials (sensitive)

### `/vps-dashboard/`
- `dashboard_server.py` — Flask server source
- `index.html` — Dashboard HTML source
- `deploy_dashboard.sh` — Deployment script

### `/github-pages/`
- `index.html` — Public-facing dashboard (GitHub Pages deployment)

### `/references/`
Research documents: weather trading, timing strategies, capital lockup, correlated hedging, international access, tax reporting, resolution risk, multi-outcome markets, AI research approaches.

---

## 5. Access Points

| Service | URL / Command | Credentials |
|---------|--------------|-------------|
| SSH to host | `ssh -i armorstack_vps_key root@178.62.225.235` | Key-based auth |
| Trading Dashboard | `https://178.62.225.235/` | No auth (self-signed cert) |
| noVNC Console | `https://178.62.225.235:6080/vnc_lite.html` | No auth (self-signed cert) |
| Windows RDP | `178.62.225.235:3389` | `dale` / `Armorstack2026!` |

---

## 6. Windows VM Software (Installed/Pending)

| Software | Status | Purpose |
|----------|--------|---------|
| Windows 11 Pro 25H2 | **Installed** | Base OS — build 26100.1, local admin `dale` |
| VirtIO Guest Tools + Drivers | **Installed** | Network (NetKVM), balloon, guest agent — manually via pnputil |
| Google Chrome | **Installed** | Default browser, Google Drive access |
| Git for Windows 2.47.1 | **Installed** | Version control |
| Claude Desktop | **Installed & Signed In** | MSIX package — Chat, Cowork, Code modes active. Native Google Drive + Gmail integration. |
| NinjaRMM Agent | **Installed** | Caspian Technology Concepts / Main Office — silent MSI install, checking in as ARMORSTACK-VM |
| Google Drive | **Accessible via Claude Desktop** | Native "From Drive" integration in Claude Desktop. Google Drive for Desktop local mount pending. |
| Windows Updates | **Installed** | First round complete (Defender + security KBs). Auto-rebooted and back online. Check for more in Settings > Windows Update. |
| Power Management | **Configured** | All sleep/hibernate/display timeout disabled, High Performance plan active |
| DNS | **Configured** | Set to 8.8.8.8 / 8.8.4.4 (Google DNS) |
| Language | **Configured** | Set to en-US (English). Applied after sign-out/sign-in. |
| Swap (Host) | **Configured** | 4GB swap file added to host — persisted in /etc/fstab |

---

## 7. Architecture Rationale

**Why Amsterdam (AMS3)?**
- Polymarket CLOB API servers are EU-hosted — lower latency for order execution
- Geographic separation from US for trading operations
- DigitalOcean AMS3 datacenter availability

**Why Windows 11 VM instead of bare Linux?**
- Claude Desktop requires Windows or macOS — no native Linux build
- NinjaRMM agent provides company management integration
- Google Drive desktop sync for file management
- RDP provides full GUI access from anywhere

**Why KVM/QEMU on the same host?**
- Single $48/mo server runs everything: bot, dashboard, and desktop
- VM uses only 4GB of 8GB available — leaves 4GB for host services
- VirtIO provides near-native I/O performance
- noVNC provides emergency console access if RDP fails

---

## 8. Operational Notes

### Bot Operation
The sprint trader runs on-demand via `run_sprint.sh` and targets daily weather binary markets on Polymarket. It scans for markets with positive expected value (EV ≥ 5%), places YES bets at low prices ($0.01-0.03 range), and monitors resolution. The strategy accepts many small losses for occasional large wins when temperature predictions hit.

### Monitoring
- Dashboard at `https://178.62.225.235/` shows live portfolio, positions, and P&L
- noVNC at port 6080 provides direct VM console
- SSH for host-level operations and bot management

### Security Considerations
- SSH key-only authentication (no password auth)
- UFW firewall restricting to ports 22, 80, 443, 3389, 6080
- Self-signed SSL (domain + Let's Encrypt planned)
- VM isolated on internal NAT network
- API keys and wallet stored with restricted permissions (600)

### Maintenance
- `virsh start win11` — Start VM
- `virsh shutdown win11` — Graceful shutdown
- `virsh console win11` — Serial console (if configured)
- VM auto-starts on host reboot via `/etc/rc.local`
- iptables NAT rules persist via `netfilter-persistent`

### Helper Scripts (on VPS)
- `/opt/vm/type_in_vm.sh "text"` — Types text into VM via `virsh send-key` (bypasses noVNC keyboard mapping issues)
- Usage: `/opt/vm/type_in_vm.sh "command here" && virsh send-key win11 KEY_ENTER`

---

## 9. Claude Desktop Workspace (C:\CLAUDE\)

### Workspace Layout
```
C:\CLAUDE\
├── CLAUDE.md                         # Claude Desktop operating instructions
└── Polymarket\
    ├── sprint_trader.py              # Main trading engine (reference copy)
    ├── dashboard.py                  # Dashboard server
    ├── run_sprint.sh                 # Bot execution script
    ├── api_keys.json                 # Polymarket CLOB credentials
    ├── wallet.json                   # Ethereum signing wallet
    ├── dashboard\                    # Dashboard HTML + Flask server
    ├── deploy\                       # SSH keys
    │   └── id_ed25519              # Private key for host access
    ├── scripts\simulator\            # Full trading engine (69 files)
    │   ├── auto_trader.py           # Autonomous trading loop (largest module)
    │   ├── sprint_scanner.py        # Sprint market discovery
    │   ├── ensemble_forecaster.py   # Multi-model forecasting
    │   ├── weather_ensemble.py      # Weather forecasts
    │   ├── arbitrage_scanner.py     # Cross-market arbitrage
    │   ├── heat_system.py           # Risk management
    │   └── ... (52 Python modules + docs + state)
    └── state\                        # Portfolio and trade state
        ├── portfolio.json           # Current positions
        ├── trade_history.json       # All executed trades
        ├── equity.json              # Equity curve
        └── sprint_analysis.json     # Sprint market analysis
```

### SSH from VM to Host
- **Key**: `C:\Users\dale\.ssh\id_ed25519` (dale-only permissions)
- **Config**: `C:\Users\dale\.ssh\config` (alias: `polybot-host`)
- **Usage**: `ssh polybot-host` or `ssh -i C:\Users\dale\.ssh\id_ed25519 root@192.168.122.1`

### Claude Desktop Cowork Mode
- Point Cowork workspace to `C:\CLAUDE\`
- CLAUDE.md provides full operating instructions for trading bot management
- Claude Desktop can SSH to host to run trades, check portfolio, view logs

---

## 10. Manual Tasks for Dale (Post-Setup)

Connect via RDP: `178.62.225.235:3389` — user `dale` / `Armorstack2026!`

1. **Sign into Google Drive for Desktop** — Google Drive is installed and running but needs Google account sign-in. Open Google Drive from system tray, sign in. Once signed in, a G: drive will appear.
2. **Set up Google Drive sync for C:\CLAUDE** — After Google Drive sign-in, create a directory junction: open PowerShell as Admin and run `mklink /J "G:\My Drive\CLAUDE" "C:\CLAUDE"` to sync the workspace to Google Drive. (Or configure Google Drive to "Mirror files" mode and move workspace there.)
3. **Open Claude Desktop in Cowork mode** — Launch Claude Desktop, switch to Cowork mode, select `C:\CLAUDE\` as the workspace folder. Claude will read CLAUDE.md and be ready to manage the trading bot.
4. **Test SSH to host** — In Claude Desktop or PowerShell, run `ssh polybot-host hostname` — should return `armorstack-vps-ams3`.

---

*This document serves as the complete operational reference for the AMS3 Polymarket deployment. Keep updated as infrastructure changes.*

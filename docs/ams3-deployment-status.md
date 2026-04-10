# AMS3 VPS Deployment Status — 2026-03-22

## Infrastructure
| Component | Status | Details |
|-----------|--------|---------|
| DigitalOcean Droplet | Running | 178.62.225.235, AMS3, 4 vCPU / 8GB RAM |
| Windows 11 VM | Running | KVM/QEMU, auto-login enabled, UEFI boot |
| RDP Access | Active | 178.62.225.235:3389 → VM (user: dale / Armorstack1!) |
| DNAT Forwarding | Active | Host:3389 → 192.168.122.10:3389 |

## Software Installed on VM
| Software | Version | Path |
|----------|---------|------|
| Python | 3.12.3 | C:\Program Files\Python312\ |
| Node.js | 20.12.2 | C:\Program Files\nodejs\ |
| Google Chrome | Latest | Installed |
| Claude Desktop | Latest MSIX | Claude_pzs8sxrjxfjjc (all-users) |
| Windows OpenSSH | Built-in | C:\Windows\System32\OpenSSH\ |
| QEMU Guest Agent | Active | Service running |

## Python Packages (pip)
requests, websockets, aiohttp, python-dotenv, web3, eth-account

## Trading Bot Files (C:\CLAUDE\Polymarket\)
- sprint_trader.py (25,714 bytes) — Main trading bot
- dashboard.py (12,433 bytes) — Trading dashboard
- api_keys.json (373 bytes) — API credentials
- wallet.json (148 bytes) — Wallet config
- run_sprint.sh (299 bytes) — Launch script
- polybot.tar.gz (33,009 bytes) — Archive
- Directories: dashboard/, deploy/, docs/, scripts/, state/

## Claude Desktop Configuration
- Config: C:\Users\dale\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\
- Cowork web search: Enabled
- Scheduled tasks: Enabled
- CLAUDE.md workspace: C:\CLAUDE\CLAUDE.md (4,827 bytes)

## SSH Access (VM → Host)
- Key: C:\Users\dale\.ssh\id_ed25519 (SYSTEM-only perms for guest agent)
- Dale copy: C:\Users\dale\.ssh\id_ed25519_dale (dale-only perms)
- SSH Agent: Running (Automatic startup), key loaded
- SSH Config: C:\Users\dale\.ssh\config (Host vps → root@192.168.122.1)
- Verified: VM can SSH to host successfully

## Boot Recovery (Completed)
- NVRAM corruption from prior RAM change → Reset from template
- BCD rebuild → bcdboot C:\Windows /s S: /f UEFI
- DISM pending actions → Reverted with /cleanup-image /revertpendingactions
- Auto-login configured via registry

## Remaining Tasks (Require Dale's RDP Session)
1. **Close Run dialog** — Stuck on dale's desktop, will close when you interact via RDP
2. **Sign into Claude Desktop** — Requires Anthropic account OAuth login
3. **Set Cowork workspace folder** — Point to C:\CLAUDE\ when prompted
4. **Google Drive sign-in** — OAuth required in Chrome
5. **DigitalOcean droplet resize** — Upgrade to 8 vCPU / 16GB ($96/mo) via DO dashboard
6. **After resize**: Increase VM RAM allocation in libvirt config (virsh edit win11)
7. **End-to-end test**: Claude Desktop → instruct to SSH to host → run trading bot

## Connection Quick Reference
```
RDP: 178.62.225.235:3389
User: dale
Password: Armorstack1!

SSH to host from VM: ssh vps  (or ssh -i ~/.ssh/id_ed25519_dale root@192.168.122.1)
SSH to VPS externally: ssh root@178.62.225.235 -i armorstack_vps_key
```

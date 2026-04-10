# v2 Deploy Archive

> **Status**: ARCHIVED for historical reference. Do NOT run anything in this directory on a v3 system.

Contents migrated here 2026-04-10 from `Polymarket/deploy/` as part of the
OneDrive→git consolidation. These are the deploy scripts from the v1/v2 era
(roughly March–April 2026) before the v3 rebuild.

## Why keep them (instead of delete)

Some of these scripts contain reference logic that the v3 rebuild ports to
TypeScript. Examples:

- `kalshi_reference.py` — the original Kalshi integration research that
  became `src/market/kalshi-client.ts`
- `deploy_auto_redeem_v3.sh` — the v1 auto-redeem flow that informs
  `src/execution/neg-risk-redeemer.ts`
- `apply_rd_tuning.py` — R&D config tuning that was folded into
  `config/rd-default.yaml`
- `provision_entities.py` — multi-entity provisioning that R3c will revisit

None of these are imported or run by v3. The v3 deploy flow is documented in
`docs/deploy.md`. The canonical flow is: edit workstation → `git push` → VPS
`git pull` → `npm run build` → `systemctl restart`.

## What the files are

| File | v1/v2 purpose |
|---|---|
| `apply_rd_tuning.py` | Apply R&D config changes at runtime via Python |
| `cleanup_polymarket_root.bat` | Windows batch to clean up workstation tree |
| `deploy_all_dashboards.sh` | Deploy the old Python dashboards to VPS |
| `deploy_auto_deposit.bat` | Windows deploy for auto-deposit cron |
| `deploy_auto_redeem_v3.bat` | Windows deploy for the v1 redeem cron |
| `deploy_auto_redeem_v3.sh` | Linux/VPS version of above |
| `deploy_enhanced_v1.bat` | v1 enhanced deploy (empty stub) |
| `deploy_entity.sh` | Provision a new entity on the VPS |
| `deploy_grinder.sh` | Deploy the old "grinder" trader loop |
| `deploy_provision.sh` | Run provisioning script on VPS |
| `fix_dashboard_performance.py` | One-off fix for dashboard slowness |
| `fix_rd_unrealized_pnl.sh` | One-off fix for R&D unrealized P&L bug |
| `kalshi_reference.py` | **Kalshi integration reference — ported to v3 `kalshi-client.ts`** |
| `list_entities.sh` | List all entities configured on VPS |
| `open_book_report.py` | Generate an open-book position report |
| `provision_entities.py` | Provision 16 R&D entities (v1 logic) |
| `rd_6h_review.py` | Every-6-hours R&D review script |
| `run_grinder.sh` | Run the old grinder loop |
| `setup_vps.sh` | Full VPS setup from scratch (v1) |
| `update_crontab.py` | Modify the VPS crontab programmatically |

## Secrets removed before archive

The original `Polymarket/deploy/` directory also contained:

- `armorstack_vps_key` (SSH private key)
- `armorstack_vps_key.pub` (SSH public key)

Both were moved to `C:\Users\dboehm\.armorstack-vault\polymarket\` on 2026-04-10
and are explicitly excluded from git via `.gitignore`.

## Deletion schedule

Per the rebuild plan's R3c cleanup gate, this entire archive directory should
be deleted after 30 days of v3 running clean without any need to reference v2
deploy logic. That's around 2026-05-10. Add a reminder to `docs/todo.md`.

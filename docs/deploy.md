# Deploy Discipline — Polybot v3

> **Created 2026-04-10** after a day of hot-patch drift caused repeat bugs.
> **Updated 2026-04-10 21:30** — migrated from scp-based sync to git-based sync.
> **GitHub repo**: https://github.com/daleboehm/polybot-v3 (private)
> This document is the single source of truth for how code changes reach the VPS.
> Do NOT deviate. Every deviation compounds future debugging time.

## The rule

**GitHub `main` is the single source of truth. Workstation and VPS both pull from it. The VPS `dist/` is always rebuilt from the synced `src/` — never hand-edited, never patched, never `sed`-ed.**

Four layers exist. All four must stay in lockstep or future rebuilds will silently overwrite fixes:

| Layer | Location | Role |
|---|---|---|
| GitHub `main` | `daleboehm/polybot-v3` | **Single source of truth.** All edits land here via commit + push. |
| Workstation source | `C:\...\Polymarket\polybot-v3\` (git repo) | Edit locally, commit, push. Never edit and skip the commit. |
| VPS source | `/opt/polybot-v3/` (git repo) | `git pull` from origin/main. Never edited directly on VPS. |
| VPS compiled | `/opt/polybot-v3/dist/` (gitignored) | Output of `tsc`. Never edited directly. Rebuilt on every deploy. |

A hot-patch to `dist/` is invisible to git. Next `git pull + npm run build` compiles the stale upstream `src/` → wipes the patch → bug returns. This happened on 2026-04-10 with the fee-rate fix before git was set up.

## Canonical deploy flow (every code change)

```
1. Edit in workstation src/ (via Claude or manually)
2. git add + git commit -m "..." on workstation
3. git push origin main
4. ssh to VPS: cd /opt/polybot-v3 && git pull
5. ssh to VPS: npm run build
6. ssh to VPS: rsync -a --delete /opt/polybot-v3/dist/ /opt/polybot-v3-rd/dist/
7. ssh to VPS: systemctl restart polybot-v3 polybot-v3-rd
8. Verify: /health endpoint returns 200 for both services
9. Verify: scan cycle logs show the expected new behavior
```

No step skipped. Ever. The commit is load-bearing — it's what makes the workstation/VPS/GitHub trio stay consistent. If you hot-patch `dist/` on VPS in an emergency, you MUST still complete steps 1-3 in the same session so the next `git pull` doesn't regress you.

## Which files go where

Everything except runtime state is tracked in git. Workstation and VPS both check out the same files.

**Tracked in git** (committed to `daleboehm/polybot-v3`):
- `src/**/*.ts` — TypeScript source
- `config/*.yaml` — engine/risk/entity configuration
- `scripts/*.sh` — deploy helpers
- `systemd/*.service` — unit file templates (not the active copies)
- `package.json` + `package-lock.json` — reproducible dependency install
- `tsconfig.json`, `Dockerfile`, `.gitignore`, `.env.example`
- `src/strategy/archive/` — quarantined strategies (complement, skew, value) kept for 30-day window

**Gitignored** (never in the repo, VPS-only):
- `dist/` — TypeScript build output, rebuilt on every deploy
- `node_modules/` — installed via `npm ci` from lockfile
- `data/` + `*.db` — SQLite runtime state, positions, trades, resolutions
- `.env` — secrets (DASHBOARD_PASSWORD, ODDS_API_KEY, FRED_API_KEY, live-mode gates)
- `archive/` — db snapshots from wipe/restart cycles
- `logs/` — runtime logs (systemd journal is the real source)

### Config file nuances

- `default.yaml` → read by prod service
- `rd-default.yaml` → read by R&D service (via `CONFIG_PATH` env var in systemd unit)
- `entities.yaml` → prod entity list
- `rd-entities.yaml` → R&D entity list
- All four live in `/opt/polybot-v3/config/` (git-managed) and are referenced by absolute path in the systemd environment. No separate R&D config directory.

Config files are read at service startup. Change → commit → push → pull → restart. No rebuild needed for config-only changes.

### Both engines share the same compiled dist/

`/opt/polybot-v3-rd/dist/` is an rsync of `/opt/polybot-v3/dist/` after every rebuild. This is deliberate — both engines run the same v3 binary, just with different configs and databases. After rebuild on prod, always:

```bash
rsync -a --delete /opt/polybot-v3/dist/ /opt/polybot-v3-rd/dist/
```

## Standard deploy command (copy-paste ready)

```bash
# On workstation (from Polymarket/polybot-v3/)
cd "/c/Users/dboehm/OneDrive - thinkcaspian.com/1-Working Files/CLAUDE/Polymarket/polybot-v3"
git add <changed files>
git commit -m "your message"
git push origin main

# On VPS via ssh (single command block)
ssh -i "Polymarket/deploy/armorstack_vps_key" -p 2222 root@178.62.225.235 '
  set -e
  cd /opt/polybot-v3
  git pull origin main
  npm run build
  rsync -a --delete /opt/polybot-v3/dist/ /opt/polybot-v3-rd/dist/
  systemctl restart polybot-v3 polybot-v3-rd
  sleep 5
  systemctl is-active polybot-v3 polybot-v3-rd
  curl -s http://127.0.0.1:9100/health | head -c 300 && echo
  curl -s http://127.0.0.1:9200/rd/health | head -c 300 && echo
'
```

## Initial VPS setup (done 2026-04-10 21:30, reference only)

```bash
# Run as root on VPS — one-time migration from scp-based sync to git
git config --global --add safe.directory /opt/polybot-v3
git config --global --add safe.directory /opt/polybot-v3-rd
cd /opt/polybot-v3
git init
git remote add origin https://github.com/daleboehm/polybot-v3.git
git fetch origin main
git reset --hard origin/main   # aligns working tree to HEAD; gitignored files preserved
npm run build
rsync -a --delete /opt/polybot-v3/dist/ /opt/polybot-v3-rd/dist/
systemctl restart polybot-v3 polybot-v3-rd
```

## Prohibited

- **Never** edit `dist/` directly. It is rebuilt from git-tracked source on every deploy and any hand edit will silently disappear.
- **Never** edit files on the VPS `src/` directly (unless you're about to also commit on workstation and pull). `git status` on the VPS will surface the drift and the next `git pull` will conflict or overwrite.
- **Never** commit secrets. The `.gitignore` covers the known-dangerous paths (`.env`, `api_keys.json`, `wallet.json`, `*.key`, `*.pem`), but always `grep` the staged diff before pushing anything new.
- **Never** skip the rsync step to R&D's `dist/`. Prod and R&D must run identical compiled code.
- **Never** run `npm run build` on the workstation. Node.js isn't installed there. Build on VPS only.
- **Never** force-push to `main` unless you're wiping history intentionally (e.g., initial repo setup). Force-push destroys any commit you didn't include locally.

## Verification checklist (run after every deploy)

```bash
# 1. Source matches across workstation and VPS for the changed file
#    (run on workstation, substitute your file)
diff Polymarket/polybot-v3/src/execution/paper-simulator.ts \
  <(ssh -i Polymarket/deploy/armorstack_vps_key -p 2222 root@178.62.225.235 \
    'cat /opt/polybot-v3/src/execution/paper-simulator.ts')

# 2. Dist reflects the new source on VPS
ssh -i Polymarket/deploy/armorstack_vps_key -p 2222 root@178.62.225.235 \
  'grep -n "const feeRate" /opt/polybot-v3/dist/execution/paper-simulator.js'

# 3. Prod and R&D dist are identical
ssh -i Polymarket/deploy/armorstack_vps_key -p 2222 root@178.62.225.235 \
  'diff -q /opt/polybot-v3/dist/execution/paper-simulator.js /opt/polybot-v3-rd/dist/execution/paper-simulator.js'

# 4. Both services healthy
ssh -i Polymarket/deploy/armorstack_vps_key -p 2222 root@178.62.225.235 \
  'systemctl is-active polybot-v3 polybot-v3-rd; curl -s http://127.0.0.1:9100/health; curl -s http://127.0.0.1:9200/rd/health'

# 5. No ERROR or kill-switch activation in the last 5 minutes
ssh -i Polymarket/deploy/armorstack_vps_key -p 2222 root@178.62.225.235 \
  'journalctl -u polybot-v3 -u polybot-v3-rd --since "5 minutes ago" | grep -E "ERROR|kill.switch|drawdown" | head -10'
```

If any verification step fails, STOP, diagnose, re-deploy. Never leave a half-deployed state overnight.

## What the 2026-04-10 drift cost

To make the cost concrete so this doc gets followed:

- **9:00 AM**: reconciler rewrite (correct). Hot-patched dist/. src/ updated in workstation. VPS src/ NOT updated.
- **11:00 AM**: fee model "fix" deployed (wrong — read market.taker_fee without scaling). Hot-patched dist/. src/ updated in workstation. VPS src/ NOT updated.
- **2:00 PM**: Dale reports dashboards showing crazy numbers. Investigation reveals $51,479 fee on a $51 trade.
- **2:30 PM**: Hot-patch dist/ to `feeRate = 0`. Temporary fix.
- **3:00 PM**: Dale asks "how do we stop patching things that get overwritten?"
- **3:30 PM**: This document is written. workstation → VPS src/ → rebuild → restart is now the only path.

That's 6.5 hours of debugging that would have been 30 minutes if the rebuild flow had been followed the first time.

## When the rule must bend (emergencies only)

If live trading is actively losing money and you must hot-patch `dist/` right now:

1. Do the hot-patch.
2. In the SAME session, also update workstation `src/`.
3. Before ending the session, `scp` the workstation `src/` to VPS and `npm run build`.
4. Verify dist matches intent.
5. Add a line to `Polymarket/docs/lessons.md` documenting why the emergency path was taken.

No exceptions. The emergency hot-patch is step 1 of a 5-step sequence, not a replacement for the sequence.

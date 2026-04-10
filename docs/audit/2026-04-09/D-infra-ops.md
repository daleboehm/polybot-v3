# Track D — Infrastructure & Operations Audit

**Date:** 2026-04-09
**Auditor:** Claude (Track D — read-only)
**Scope:** systemd, Docker, deploy scripts, logging, observability, monitoring, backup/DR, dependency resilience, restart safety, VPS hardening (paper review), cron
**Mode:** READ-ONLY. No VPS contact. All VPS-state assertions inferred from in-tree files.

---

## Executive summary

The polybot-v2 codebase has the *bones* of a serious operational system — pino structured logging, a retry helper, a rate limiter, an event bus, graceful shutdown handlers, snapshot intervals, a 2-engine isolation model — but the *muscle* is missing in critical places. The retry helper and rate limiter exist as files but are imported by **zero** call sites. There is no health endpoint. No metrics. No alerting. No on-startup reconciliation against the exchange. The Dockerfile is broken (refers to a `pnpm-lock.yaml` that does not exist) and is not used by any deploy script. The "backup" documented in `BACKUP_SETUP.md` backs up the V1 Python state and the V1 dashboard — it does **not** touch either V2 SQLite database. The only "DR" is a single manually-triggered VPS snapshot on 2026-04-08. The deploy scripts run as root, do not check for in-flight orders, and do `npx tsc` on the VPS in place — there is no atomic deploy, no rollback, no canary. SSH keys, wallet private keys, and CLOB API secrets are committed in plaintext to the deploy/ tree on a OneDrive-synced workstation. Two VPS IPs (178.62.225.235 vs 209.38.40.80) appear in deploy scripts — one is stale, suggesting tribal-knowledge drift.

The system has been kept alive by Dale's full-time attention. **It will not survive an unattended weekend.**

Findings are organized by severity (P0/P1/P2/P3) and cite `file:line`.

---

## Section 1 — systemd units

### Files reviewed
- `Polymarket/polybot-v2/systemd/polybot-v2.service` (35 lines)
- `Polymarket/polybot-v2/systemd/polybot-v2-rd.service` (37 lines)

### Findings

**D1.1 — [P0] Both engines run as root.**
`polybot-v2.service:8` and `polybot-v2-rd.service:8` set `User=root`. The prod engine signs CLOB orders with a wallet private key loaded from `.env`. Compromise of the Node process = full root on the host = wallet exfiltration. There is no service account, no privilege drop, no setcap. Even a benign npm-package vulnerability (any of the 11 prod deps in `polybot-v2/package.json:20-33`) becomes root code execution. This is the single largest blast-radius issue in Track D.

**D1.2 — [P0] No reconciliation against exchange on (re)start. `Restart=on-failure` papers over silent state divergence.**
`polybot-v2.service:12` (`Restart=on-failure`, `RestartSec=10`, `StartLimitBurst=5`) will silently rotate the engine through 5 crash-restarts in 5 minutes. Combined with the fact that `engine.ts:98-167` (the `start()` method) loads cash and positions only from local SQLite via `entity-manager.ts:44-54` and never calls any of:
- `DataApiClient.getOpenPositions()` (which exists at `polybot-v2/src/market/data-api-client.ts:20` but is imported by **zero** files outside its own definition — confirmed via Grep)
- CLOB `getOpenOrders` (no such call exists in `src/`)
- The Polygon CTF `balanceOf` for on-chain CTF token holdings
- The on-chain USDC balance

…the engine will happily restart with an out-of-sync view of cash, positions, and open orders. If a fill landed on the CLOB between the engine's last DB write and the crash, the position will be **invisible** to the engine forever (until the resolution checker happens to query that conditionId — but only `getAllOpenPositions()` from local DB drives that query, see `risk/resolution-checker.ts:43`).

**D1.3 — [P1] `MemoryMax=1G` (prod) / `MemoryMax=512M` (R&D) — no swap fallback, no graceful pre-OOM shrink.**
`polybot-v2.service:26` and `polybot-v2-rd.service:29`. The R&D engine carries **1,280 open positions** (`docs/status.md:30`). At ~1KB/position in JS object overhead plus the SamplingPoller's `knownConditions` Set (`market/sampling-poller.ts:12` — which **never expires entries**, only adds), the R&D process will grow unboundedly. Node will hard-OOM at 512M and systemd will restart it. No back-pressure, no graceful shrink.

**D1.4 — [P1] R&D unit hardcodes the dashboard password in plaintext.**
`polybot-v2-rd.service:20`: `Environment=DASHBOARD_PASSWORD=` *value redacted* . This file is in the worktree on a OneDrive-synced workstation. Same value is referenced in `dashboard/sse-server.ts:27` to derive `SECRET = HMAC(DASHBOARD_PASSWORD)` for session signing — meaning anyone who reads this file can forge an admin session cookie for the R&D dashboard. The same env var pattern in the prod unit (`polybot-v2.service:18` `EnvironmentFile=/opt/polybot-v2/.env`) at least keeps the secret out of the unit file, but the R&D variant leaks it.

**D1.5 — [P1] Hardening primitives present but incomplete.**
Both units set `NoNewPrivileges=true` and `PrivateTmp=true` (`polybot-v2.service:21-22`, `polybot-v2-rd.service:26-27`). Missing: `ProtectSystem=strict`, `ProtectHome=true`, `ProtectKernelTunables=true`, `ProtectKernelModules=true`, `ProtectControlGroups=true`, `RestrictNamespaces=true`, `LockPersonality=true`, `MemoryDenyWriteExecute=true`, `RestrictRealtime=true`, `RestrictSUIDSGID=true`, `SystemCallArchitectures=native`, `SystemCallFilter=@system-service`, `CapabilityBoundingSet=`, `AmbientCapabilities=`, `ReadWritePaths=/opt/polybot-v2/data`. Easy wins, all of them.

**D1.6 — [P2] No `ExecStartPre` health check, no `ExecStopPost` cleanup.**
`polybot-v2.service:10-11` jumps straight to `node dist/index.js`. Nothing verifies that `dist/index.js` exists, that the DB file is reachable, that the schema migration is current, or that the wallet credentials parse. A bad deploy = silent restart loop until `StartLimitBurst=5` trips, then the unit falls into `failed` state with no notification.

**D1.7 — [P2] `ExecStop=/bin/kill -SIGTERM $MAINPID` is correct, but no `TimeoutStopSec`.**
Default systemd timeout is 90s. The shutdown handler in `core/lifecycle.ts:13-19` calls `engine.stop()` which calls `closeDatabase()` and `captureSnapshots()` synchronously — these are fast, so timeout is unlikely to be hit. But if a strategy `evaluate()` is mid-fetch (15s timeout per Gamma call, no cancellation token), shutdown can stall. Minor but worth noting.

**D1.8 — [P2] `WantedBy=multi-user.target` is fine, but no `OnFailure=` notification target.**
There is no `polybot-v2-failure-notify.service` to fire a webhook when this unit fails. Combined with D5.1 (no alerting), a 3am crash means waking up to a dead engine and no idea when it died.

**D1.9 — [P3] R&D `WorkingDirectory=/opt/polybot-v2-rd` but `ExecStart=/usr/bin/node /opt/polybot-v2/dist/index.js`.**
`polybot-v2-rd.service:9-10`. The R&D engine reads its compiled code from the **prod** directory. This is intentional (`scripts/full_rebuild.sh:18-21` deletes `/opt/polybot-v2-rd/dist` and copies `/opt/polybot-v2/dist` to it, then symlinks node_modules), but means R&D and prod can never run different code versions. Any prod deploy auto-deploys to R&D. Confirmed in `scripts/prod_rebuild.sh:46-47`. Acceptable for now but a footgun: a prod hot-fix that breaks R&D loses the validation channel.

---

## Section 2 — Dockerfile

### File reviewed
- `Polymarket/polybot-v2/docker/Dockerfile` (34 lines)

### Findings

**D2.1 — [P1] Dockerfile is broken AND unused. Dead code masquerading as infrastructure.**
- Line 4: `COPY package.json pnpm-lock.yaml ./` — there is no `pnpm-lock.yaml` in the repo (verified). The build will fail at this step.
- Line 5: `RUN corepack enable && pnpm install --frozen-lockfile` — package.json (`polybot-v2/package.json:13-19`) defines npm scripts and the deploy script `scripts/deploy-vps.sh:43` runs `npm install --omit=dev`. The project uses npm, not pnpm.
- Grep for `docker|Dockerfile|docker-compose` across `polybot-v2/` and `deploy/` returned **zero** matches outside the Dockerfile itself. No deploy script references it. No CI builds it.
- Line 33: `EXPOSE 9100` — only the prod engine port. No way to run the R&D engine from this image.
- Line 26: `VOLUME ["/opt/polybot-v2/data"]` — the SQLite DB, but no volume for `/opt/polybot-v2/config` (which the engine reads via `CONFIG_PATH`).
- Line 13: `RUN apk add --no-cache tini` — fine, but `ENTRYPOINT ["/sbin/tini", "--"]` (line 33) suggests this was meant for k8s/ECS which never happened.

**Recommendation:** Either fix it and use it, or delete it. Right now it's a tripwire for any future engineer who looks at the directory and assumes containerization is in play.

**D2.2 — [P3] Even if fixed, the image runs as root.**
No `USER` directive. Same blast radius problem as D1.1.

---

## Section 3 — Deploy scripts

### Files reviewed
- `Polymarket/polybot-v2/scripts/deploy-vps.sh` (76 lines)
- `Polymarket/polybot-v2/scripts/full_rebuild.sh` (42 lines)
- `Polymarket/polybot-v2/scripts/prod_rebuild.sh` (87 lines)
- `Polymarket/polybot-v2/scripts/restart_verify.sh` (10 lines)
- `Polymarket/deploy/setup_vps.sh` (540 lines)
- `Polymarket/deploy/deploy_provision.sh` (67 lines)
- `Polymarket/deploy/deploy_entity.sh` (217 lines)
- `Polymarket/deploy/deploy_auto_redeem_v3.sh` (117 lines)
- `Polymarket/deploy/deploy_grinder.sh` (53 lines)
- `Polymarket/deploy/deploy_all_dashboards.sh` (239 lines)
- `Polymarket/deploy/update_crontab.py` (67 lines)

### Findings

**D3.1 — [P0] No deploy script stops the engine before deploying. No mid-trade safety check.**
- `polybot-v2/scripts/deploy-vps.sh:38-44` uploads files to `/opt/polybot-v2/` and runs `npm install` while the prod engine is **still running**. The systemd unit isn't touched until the very end (`deploy-vps.sh:55-62`), and even then only `systemctl enable` is called, not `restart`.
- `polybot-v2/scripts/prod_rebuild.sh:36-37` runs `systemctl restart polybot-v2` after `npx tsc` overwrites `dist/`. There is **no check** for in-flight orders (the engine could be mid-`postOrder()` call when the restart fires). No `engine.gracefulStop()` confirmation. No "drain" mode.
- `polybot-v2/scripts/full_rebuild.sh:6` does `systemctl stop polybot-v2 polybot-v2-rd 2>/dev/null || true` — note the `|| true`, so a stop failure is silently ignored.

**The Polymarket CLOB matches orders in milliseconds. Restarting mid-`createOrder→postOrder` will leave a signed order in the wild that the engine has no record of.** The DB only writes on order success (`execution/clob-router.ts:38-58`). A restart between line 95 (`client.placeOrder()`) and line 113 (the DB writes) → orphan order, invisible to the engine, could fill at any time.

**D3.2 — [P0] `prod_rebuild.sh` runs `npx tsc` directly on the VPS — no build verification, no rollback.**
`polybot-v2/scripts/prod_rebuild.sh:8` runs `npx tsc` in-place. If TypeScript compilation produces errors, the script's `set -e` (line 2) aborts — but `dist/` is now in a partial state because `tsc` writes files as it goes. The previous working `dist/` is **gone**. There is no `dist.bak`, no git revert, no atomic swap (`tsc → dist.new && mv dist dist.old && mv dist.new dist`). A failed build leaves the system in a state where only the last successful systemd restart's in-memory code keeps running — and the next restart will crash.

**D3.3 — [P0] `prod_rebuild.sh` and `restart_verify.sh` cannot tell whether the build was actually verified.**
`prod_rebuild.sh:25-28` does:
```
SRC_COUNT=$(find src -name "*.ts" | wc -l)
DIST_COUNT=$(find dist -name "*.js" -not -name "*.js.map" -not -name "*.d.ts" | wc -l)
echo "TS source files: $SRC_COUNT"
echo "JS compiled files: $DIST_COUNT"
```
It **prints** the counts but doesn't compare them or fail if they differ. A truncated `dist/` will deploy. `restart_verify.sh` (10 lines, `Polymarket/polybot-v2/scripts/restart_verify.sh:1-10`) just runs `systemctl is-active` and queries the DB — it does not fetch markets, doesn't place a paper trade, doesn't verify the dashboard returns 200. "Verify" is a misnomer.

**D3.4 — [P0] Python "fix" scripts run inside the deploy pipeline, modifying compiled JS in `dist/`.**
`polybot-v2/scripts/prod_rebuild.sh:17-19`:
```
python3 /opt/polybot-v2/scripts/fix_commas.py
python3 /opt/polybot-v2/scripts/fix_dashboard_final.py
python3 /opt/polybot-v2/scripts/fix_prod_dashboard.py
```
And `prod_rebuild.sh:50-78` does inline `python3 -c` patches that string-replace text inside `dist/dashboard/sse-server.js` and `dist/dashboard/static/index.html` to apply R&D-specific cookie names and dashboard titles. There are **57 fix_*.py scripts** in `polybot-v2/scripts/` (counted via `ls`). This is not deployment — this is post-build patching of compiled artifacts. Any TypeScript change that shifts string positions in the compiled output will silently break the patches with no error. The R&D dashboard's auth cookie name is set by a Python regex against compiled JS (`prod_rebuild.sh:71-74`).

**D3.5 — [P0] Hardcoded secrets in the workspace tree, OneDrive-synced.**
- `Polymarket/deploy/setup_vps.sh:72-85` writes a JSON blob containing the wallet private key (*value redacted*), CLOB API key/secret/passphrase (*all values redacted*), and a GitHub PAT (*value redacted*) into `api_keys.json` on the VPS. This file is **committed to the workspace tree** which is on a OneDrive-synced workstation. Microsoft cloud now has these secrets.
- `Polymarket/deploy/deploy_all_dashboards.sh:174` defines a stub `api_keys.json` with `'DASHBOARD_PASS': '`*value redacted*`'` — another secret in the tree.
- `Polymarket/polybot-v2/systemd/polybot-v2-rd.service:20` (already noted in D1.4) has `DASHBOARD_PASSWORD=`*value redacted*.
- `Polymarket/deploy/armorstack_vps_key` is the SSH private key — also in the tree, also OneDrive-synced. Per `docs/audit-plan-2026-04-09.md:110`, this is a known concern Track A is also looking at, but I'm flagging it from the infra angle: the deploy scripts assume this key works, and there's no key-rotation procedure documented anywhere.

This is Track A/B territory but Track D notes it because the infra-as-code stores it.

**D3.6 — [P1] Two different VPS IPs reference each other inconsistently.**
- `polybot-v2/scripts/deploy-vps.sh:7` → `VPS_HOST="178.62.225.235"`
- `deploy/deploy_provision.sh:13` → `VPS_HOST="178.62.225.235"`
- `deploy/deploy_grinder.sh:5` → `VPS="root@178.62.225.235"`
- `deploy/deploy_auto_redeem_v3.sh:15` → `VPS_IP="209.38.40.80"` ← **STALE**

`deploy_auto_redeem_v3.sh` is the script that ships the auto_redeem cron — and it deploys to a different IP than everything else. Either it deploys to a dead host (and no auto-redeem is happening anywhere) or a second VPS exists that's not in the audit. `docs/context.md:13` says the only VPS is `178.62.225.235`. This is an inconsistency that needs human resolution. Either the script is dead (delete it) or there's an undocumented host with the production wallet's CTF tokens being claimed against it.

**D3.7 — [P1] `deploy/deploy_provision.sh:15` constructs an SSH key path that cannot work.**
`SSH_KEY="${SCRIPT_DIR}/mnt/CLAUDE/Polymarket/deploy/armorstack_vps_key"` — concatenates `SCRIPT_DIR` (which is `deploy/`) with `mnt/CLAUDE/...`. This path doesn't exist anywhere. The fallback chain at lines 23-28 tries `/sessions/clever-bold-johnson/...` (a Claude session-specific path) and `$HOME/armorstack_vps_key`. None of these are valid on Dale's local Windows machine. This script is broken on first invocation; if Dale ever ran it, it ran from inside a specific Claude session.

**D3.8 — [P1] Build runs on the VPS, not in CI.**
`polybot-v2/scripts/prod_rebuild.sh:8`: `npx tsc`. The compiled artifacts that drive live trading are produced *on the production host*, with whatever toolchain version happens to be installed there, against whatever node_modules happen to be installed there. There is no:
- CI build
- Reproducible build (no lockfile — see D2.1)
- Build provenance
- SBOM
- Artifact signing
- Version pinning

A `tsc` minor version difference between Dale's laptop (where dev builds happen) and the VPS could produce different output. `npm install --omit=dev` at deploy time (`scripts/deploy-vps.sh:43`) re-resolves prod deps against npm registry **at deploy time**, meaning a new release of any of the 11 prod deps could land in production without a code change.

**D3.9 — [P1] No idempotency guarantees. No "is this script safe to re-run?" comments.**
- `deploy/setup_vps.sh:494-503` writes a cron line with `(crontab -l ; echo $CRON_SPRINT) | crontab -` — but `grep -v` only filters `sprint_trader`, not other prior states. Re-running can leave duplicate entries for other jobs.
- `deploy/deploy_entity.sh:175-179` appends to crontab without dedup of the new block.
- `polybot-v2/scripts/full_rebuild.sh:24-25` does `rm -f /opt/polybot-v2-rd/data/rd.db*` — re-running this **deletes the R&D database**. There is no warning, no confirmation prompt. A fat-fingered re-run wipes 11,245 paper trades.

**D3.10 — [P1] `restart_verify.sh` is the only "verify" gate. It is 10 lines and does not test trading.**
The full content (`Polymarket/polybot-v2/scripts/restart_verify.sh:1-10`):
```
#!/bin/bash
systemctl start polybot-v2-rd
systemctl restart polybot-v2
sleep 5
echo "R&D: $(systemctl is-active polybot-v2-rd)"
echo "Prod: $(systemctl is-active polybot-v2)"
sqlite3 -column -header /opt/polybot-v2-rd/data/rd.db "SELECT slug, current_cash, trading_balance FROM entities;"
echo "Trades: $(sqlite3 /opt/polybot-v2-rd/data/rd.db 'SELECT COUNT(*) FROM trades;')"
echo "Markets: $(sqlite3 /opt/polybot-v2-rd/data/rd.db 'SELECT COUNT(*) FROM markets;')"
```
A 5-second `sleep`. `is-active` checks (which return "active" the moment the unit starts, before the engine has done anything). DB row counts. **Nothing verifies the engine actually placed a paper order, fetched markets, or talked to the CLOB.** A deploy that ships an engine that crashes 10 seconds in is "verified."

**D3.11 — [P2] All deploy scripts use SSH password / key but `StrictHostKeyChecking=no`.**
`deploy/deploy_provision.sh:36`, `deploy/deploy_auto_redeem_v3.sh:47`, `deploy/deploy_grinder.sh:7`, `deploy/deploy_all_dashboards.sh` (implicitly via `ssh` defaults). MITM vector. Acceptable for a developer convenience, problematic for an unattended deploy pipeline.

**D3.12 — [P2] No state migration discipline.**
`polybot-v2/scripts/full_rebuild.sh:24` deletes the R&D DB on every run and `restart_verify.sh:7-9` re-seeds it manually with sqlite3 commands. There is no migration tool, no `db_init` step, no schema-version check. The engine's `engine.ts:103` calls `applySchema(db)` which presumably does an `IF NOT EXISTS` style init — but no field on whether columns are added correctly between schema versions. `docs/status.md:73` says "added `sub_strategy_id` column to 5 tables via `ALTER TABLE ADD COLUMN`" — this implies a manual migration, not a migration pipeline.

---

## Section 4 — Logging & observability

### Files reviewed
- `Polymarket/polybot-v2/src/core/logger.ts` (24 lines)
- `Polymarket/polybot-v2/src/utils/retry.ts` (38 lines)
- `Polymarket/polybot-v2/src/utils/rate-limiter.ts` (41 lines)
- `Polymarket/polybot-v2/src/core/event-bus.ts` (referenced)
- `Polymarket/polybot-v2/src/dashboard/sse-server.ts:1-160`

### Findings

**D4.1 — [P0] No metrics. No tracing. No `/health`. No correlation IDs.**
Grep for `prometheus|statsd|datadog|opentelemetry|grafana|loki|metrics\.|/metrics` across `polybot-v2/` returned **zero** files. The engine emits structured pino logs (`core/logger.ts:7`) and that is the entire observability story. There is no:
- `/health` or `/healthz` endpoint (`dashboard/sse-server.ts:103` exposes `/api/status` but it's gated behind auth at line 96, so it cannot serve as an unauthenticated probe)
- Cycle-duration histograms
- Order-fill latency p50/p95/p99
- Queue depth metrics
- Cache hit rate
- HTTP error rate per upstream (CLOB, Gamma, Open-Meteo, Binance, NWS)
- Memory / FD count / event-loop lag
- Trade journal counters

**Pino logs are good for forensics. They are useless for "is the engine healthy *right now*."**

**D4.2 — [P0] Logs go only to journald. No centralization. No retention policy.**
`polybot-v2.service:29-31`: `StandardOutput=journal`, `StandardError=journal`. Journald default retention on Ubuntu is "until disk pressure" — which on a small DigitalOcean droplet means logs can disappear at any time. No `journalctl --vacuum-time=` configured (none in `setup_vps.sh`). No `rsyslog`/`fluentbit`/`vector`/`promtail` shipping logs anywhere. If the VPS is destroyed, all logs die with it. The 47 production trades and 11,245 R&D paper trades' justifications are gone.

**D4.3 — [P0] `withRetry()` and `RateLimiter` exist but are imported by ZERO call sites.**
- `polybot-v2/src/utils/retry.ts:13` defines `withRetry<T>()` with exponential backoff. Grep for `withRetry` across `polybot-v2/src/` returns **only the definition file**. No strategy, no client, no execution path uses it.
- `polybot-v2/src/utils/rate-limiter.ts:3` defines `RateLimiter`. Grep for `RateLimiter` across `polybot-v2/src/` returns **only the definition file**. The CLOB-facing code in `execution/clob-router.ts` makes raw `client.postOrder()` calls with no rate limiting. Polymarket's documented limit is hit with a single noisy cycle. Per Track A/B's likely findings, this would explain occasional 429s.

This is "we built the abstraction, then forgot to plug it in." The kind of finding that surprises a team because the abstraction *exists* in the file tree.

**D4.4 — [P1] `pino` is configured but no `level` discipline.**
`core/logger.ts:5`: `const level = process.env.LOG_LEVEL ?? 'info';` — default `info`. The R&D unit explicitly sets `LOG_LEVEL=info` (`polybot-v2-rd.service:21`). Prod unit doesn't set it (per `polybot-v2.service:18`'s reliance on `.env`). Risk: a verbose log statement in a hot loop blows up disk. Per `engine.ts:303`: log message is only emitted when there are signals/orders, so this is reasonable in practice — but there are no log-volume guards.

**D4.5 — [P1] No correlation IDs. No request IDs. No trade IDs propagated through logs.**
A signal → order → fill → resolution chain cannot be reconstructed from logs. The `nanoid()` IDs (`clob-router.ts:11`) live in the DB but logs reference different fields. Forensics on a single trade requires SQL + grep + manual stitching.

**D4.6 — [P2] `pino-pretty` transport is enabled when `NODE_ENV !== 'production'`.**
`core/logger.ts:10-11`. The systemd units don't set `NODE_ENV=production`, so the prod engine is currently shipping pretty-printed colored logs to journald, which:
- Wastes disk
- Breaks structured log parsing (no JSON shipping possible without re-parsing)
- Includes ANSI escape codes in journald

Easy fix: `Environment=NODE_ENV=production` in both unit files. Surprised this is missing.

**D4.7 — [P2] `event-bus` is in-process only.**
`core/event-bus.ts` (referenced from `engine.ts:31`). All events stay in this Node process. Not surfaced as an event stream, not consumable by external dashboards, not replayable. The "Live Events" panel in the dashboard is SSE-pushed (`sse-server.ts`), so it works for live observation, but there's no event log to replay after the fact.

---

## Section 5 — Monitoring & alerting

### Files reviewed
- All of `polybot-v2/src/`
- `Polymarket/docs/BACKUP_SETUP.md`
- `Polymarket/docs/infrastructure-summary-2026-03-28.md`

### Findings

**D5.1 — [P0] There is no alerting. None.**
Grep for `slack|discord|pagerduty|webhook|alert|notify` across `polybot-v2/` returned **zero** files. No webhook integration. No email-on-failure. No Slack incoming webhook. No PagerDuty. No `OnFailure=` systemd unit. No log-pattern-based trigger.

If the engine crashes at 3am:
- `Restart=on-failure` will restart it 5 times (per `polybot-v2.service:14-15` `StartLimitBurst=5`, `StartLimitIntervalSec=300`).
- After 5 failures in 5 minutes, systemd will give up and leave the unit in `failed` state.
- **Nothing will tell anyone.** Dale will discover it the next time he opens the dashboard.

If the wallet runs out of MATIC (gas) for `auto_redeem.py`:
- The cron job's stderr goes to `/opt/polybot/logs/redeem.log` (per `deploy_auto_redeem_v3.sh:115`).
- No one is reading that log.

If the CLOB API returns 401 (revoked credentials) every cycle:
- `clob-router.ts:65` logs an error.
- No alert. Engine keeps running. R&D paper trades fine. Prod silently stops trading.

**D5.2 — [P0] No heartbeat. No liveness probe.**
The `/api/status` endpoint (`dashboard/sse-server.ts:103`) returns engine stats but is auth-gated and intended for the human-facing dashboard. There is no:
- Unauthenticated `/health` for an external uptime monitor
- Self-reported heartbeat to Healthchecks.io / Cronitor / Better Stack / Pingdom
- Counter that increments on every successful scan cycle that an external watcher could check

The simplest possible alert ("the scan cycle has not completed in 15 minutes") cannot be implemented because the scan cycle does not externalize its heartbeat.

**D5.3 — [P0] Resolution checker silently swallows Gamma API failures.**
`risk/resolution-checker.ts:51-56`: a Gamma API fetch failure is logged at `warn` level and the function returns. No metric. No alert. If Gamma is down for 24 hours, **no positions resolve**, the engine has no idea, and the cash balance silently freezes. The dashboard will show "X positions open, no recent resolutions" — which looks like a slow market day.

**D5.4 — [P1] R&D-to-Prod advisor data path can fail silently.**
`risk/strategy-advisor.ts:90-103`: if `readRdPerformance()` throws (R&D DB unavailable, file lock contention, schema mismatch), the advisor returns `rd_available: false` and logs at `warn`. The advisor will not promote new sub-strategies and will not auto-disable bad ones. **The Strategy Advisor's silence is indistinguishable from "no decisions to make."** No counter, no metric, no last-success timestamp surfaced anywhere.

**D5.5 — [P1] Daily loss guard exists but `lockOut` is in-memory + DB only.**
`risk/risk-engine.ts` and `entity-manager.ts:153-163` (`lockOut()`) — when an entity gets locked out due to daily loss limit, the only signal is an `eventBus.emit('risk:lockout', ...)` and a `log.warn`. No external alert. Dale won't know until he opens the dashboard.

**D5.6 — [P2] No circuit breaker on consecutive errors per upstream.**
NWS, Open-Meteo, Binance, CoinGecko, Polymarket Gamma, Polymarket CLOB sampling — all 6 upstreams use bare `fetch()` with `AbortSignal.timeout()`. None track consecutive failures. None enter "open" state after N failures. If Open-Meteo flaps for an hour, the engine spams it with retries (one per scan cycle, which is fine at 5min intervals — but at 0 retries per call, one cycle's failure is the only signal). No `ThirdPartyHealth` registry.

---

## Section 6 — Backup & DR

### Files reviewed
- `Polymarket/docs/BACKUP_SETUP.md`
- `Polymarket/docs/status.md` (snapshot reference)
- `Polymarket/docs/todo.md` (snapshot reference)
- `Polymarket/backups/` (directory listing)

### Findings

**D6.1 — [P0] The documented backup system DOES NOT BACK UP THE V2 DATABASE.**
`docs/BACKUP_SETUP.md:16-32` describes `/opt/polybot/backup_state.sh` backing up:
- `/opt/polybot/state/` (V1 Python state)
- `sprint_trader.py`, `auto_redeem.py`, `auto_trader.py`, `risk_manager.py`, `reconcile.py`, `check_redeem.py` (all V1 scripts)
- `/opt/polybot/dashboard/` (V1 dashboard)

The V2 SQLite databases are at:
- `/opt/polybot-v2/data/polybot.db` (prod, per `docs/context.md:24`)
- `/opt/polybot-v2-rd/data/rd.db` (R&D, per `polybot-v2-rd.service:22`)

**Neither path is touched by the backup script.** 47 prod trades, 11,245 R&D paper trades, all sub-strategy performance data, all snapshots, all resolutions — none of it is in the backup. If the VPS dies, V2 data is gone.

**D6.2 — [P0] The only V2 "backup" is one manual VPS-level snapshot.**
`docs/status.md:67`: `Snapshot | polybot-v2-dual-engine-2026-04-08`. `docs/todo.md:79`: `[x] VPS snapshot (polybot-v2-dual-engine-2026-04-08)`. This is a single point-in-time DigitalOcean snapshot taken manually one day ago. There is **no automation** anywhere in the deploy/ tree, no `doctl snapshot create` cron job, no scheduled snapshot (DigitalOcean offers them for $1.20/mo, not used). When this snapshot is restored, all data after 2026-04-08 is lost.

**RPO = 24 hours minimum (since the snapshot date), and growing every hour.**

**D6.3 — [P0] No documented restore procedure for the V2 SQLite DBs.**
`BACKUP_SETUP.md:114-138` documents a restore for V1's portfolio state (copy files back into `/opt/polybot/state/`). There is no procedure for:
- Restoring `polybot.db` after a corrupt file
- Reconciling restored DB state against on-chain CTF holdings
- Recovering a position that resolved between backup and restore
- The case where the backup DB has stale balances and the wallet has on-chain redeemed USDC that the DB doesn't know about

`apply ar-runbook-generator` says: there should be a `runbooks/restore-v2-db.md` and a `runbooks/db-corruption.md` and a `runbooks/wallet-out-of-sync.md`. **None exist.**

**D6.4 — [P0] No off-host backup. Single point of failure.**
- The 30-day rolling backup tarballs documented in `BACKUP_SETUP.md:36-39` live at `/opt/polybot/backups/` — **on the same VPS**. If the VPS is destroyed (DigitalOcean account compromise, accidental destroy, datacenter loss), the backups die with the data they're backing up.
- The local workspace `Polymarket/backups/` directory contains only two files: `polybot-state-20260327-133511.tar.gz.age` and `polybot-state-20260328-080615.tar.gz.age`. Two files, no automation, last one is 12 days old. The `.age` extension implies they were encrypted with [age](https://github.com/FiloSottile/age) — but the encryption key is not in the workspace, no documented procedure for using them, and they predate the V2 system entirely (still V1 state).

**D6.5 — [P1] WAL mode + better-sqlite3 = backup must be coordinated.**
`docs/context.md:16` confirms `better-sqlite3 (WAL mode)`. SQLite WAL mode means a naive `cp polybot.db polybot.db.bak` while the engine is running can produce a torn backup. The correct approach is `sqlite3 polybot.db ".backup polybot-bak.db"` or `VACUUM INTO`. There is no script in the codebase that does this. Any future "back up the V2 DB" script written by a non-DBA is likely to do the wrong thing.

**D6.6 — [P1] No backup of `.env` or wallet credentials.**
`polybot-v2.service:18` references `EnvironmentFile=/opt/polybot-v2/.env`. This file is excluded from the documented V1 backup. If the VPS is destroyed, the wallet private key is lost (per Track A/B audit, the same private key is in `Polymarket/deploy/setup_vps.sh:76` and in `Polymarket/auto_redeem.py`'s `api_keys.json` reference and possibly in plaintext in the workspace tree — but a backup procedure should not rely on plaintext local copies of secrets).

**D6.7 — [P2] No restore drill ever performed.**
`apply bcdr-planning`: a backup that has never been restored is not a backup. There is no record (in `docs/`, in the tree, anywhere) of a successful end-to-end restore test. The first time a restore is attempted will be during an actual incident, while bleeding capital.

**RTO is undefined and untested. The realistic RTO during an actual incident is "as long as it takes Dale to manually rebuild from notes" = many hours to days.**

---

## Section 7 — Dependency health & upstream resilience

### Files reviewed
- `polybot-v2/src/risk/resolution-checker.ts` (250 lines)
- `polybot-v2/src/market/sampling-poller.ts` (178 lines)
- `polybot-v2/src/market/data-feeds.ts` (270 lines)
- `polybot-v2/src/market/data-api-client.ts` (95 lines)
- `polybot-v2/src/market/orderbook-ws.ts` (180 lines)
- `polybot-v2/src/execution/clob-router.ts` (245 lines)
- `polybot-v2/src/utils/retry.ts` (already noted as unused)

### Findings

**D7.1 — [P0] Zero retry logic on any HTTP call. Single attempt per cycle.**
- `market/sampling-poller.ts:49-57`: `fetch(url, { signal: AbortSignal.timeout(30_000) })` — 30s timeout, NO retry. A single transient 503 from the CLOB sampling endpoint silently drops the entire poll cycle (line 89: `return []`). The engine keeps running with stale market data until the next 5min cycle.
- `risk/resolution-checker.ts:185-188`: same pattern, 15s timeout, no retry. A single Gamma flake = no resolutions for 2 minutes (the `checkIntervalMs` at line 33).
- `market/data-feeds.ts:49-52`: NWS forecast, 10s timeout, no retry. Returns `null` on any failure (line 76).
- `market/data-feeds.ts:137`: Open-Meteo ensemble, 10s timeout, no retry. Returns `null` on any failure (line 174).
- `market/data-feeds.ts:215`: Binance price, 5s timeout, no retry. Returns `null` on any failure (line 225).
- `market/data-api-client.ts:36-41`: Polymarket Data API, 30s timeout, no retry. Throws on failure.

`utils/retry.ts:13` (`withRetry()`) is **the obvious tool** to wrap each of these calls. It is imported nowhere. The infrastructure exists; the wiring is absent.

**D7.2 — [P0] No circuit breakers.**
None of the 6 upstreams have a circuit breaker. If Gamma is having a bad day and returning 502s, the engine will hammer it on every cycle, every entity, every position. No "open" state, no fallback, no "skip Gamma for 5 minutes and use cached state."

**D7.3 — [P0] No fallback data source for CRITICAL upstreams.**
- **Polymarket CLOB sampling-markets** — single source of truth for market discovery. No fallback. When down, no new markets; no scan cycles produce signals.
- **Polymarket Gamma API** — single source of truth for resolution status. No fallback. When down, **no positions resolve, ever, until Gamma comes back**. The cash balance freezes. The risk engine has no idea positions should be settled.
- **Polygon RPC** — only used by `auto_redeem.py` (not by the V2 engine — confirmed via Grep, no Polygon RPC calls in `polybot-v2/src/`). The V2 engine **does not read on-chain state at all**. It trusts its own DB. The auto_redeem cron is the only thing reconciling against the chain.

For weather/crypto data feeds (the `weather_forecast` and `crypto_price` strategies), there *are* multiple sources logically (NWS for US, Open-Meteo for non-US; Binance for crypto), but the code doesn't fall back across them. If Open-Meteo is down, the entire `weather_forecast` strategy goes silent.

**D7.4 — [P0] WebSocket reconnect is naive and has no exponential backoff.**
`market/orderbook-ws.ts:142-152`: `scheduleReconnect()` waits a hardcoded `RECONNECT_DELAY_MS = 5000` (line 10) and reconnects. On persistent failure, this is a 5-second-interval reconnect storm against Polymarket's WS endpoint forever. No backoff cap, no "give up" point. Polymarket can blacklist the IP for abuse.

Also: the `connect()` Promise (`orderbook-ws.ts:26-56`) only resolves on `'open'` event and rejects on `'error'`. The first error during connect rejects, but subsequent errors after connect are caught at line 45-48 with no rejection (the Promise has already resolved). This is correct for the connect flow but means errors during a long-lived connection are only logged, not surfaced upward. Engine code at `engine.ts:118-122` only catches the initial connect failure.

**D7.5 — [P1] CLOB order placement has no retry on transient errors.**
`execution/clob-router.ts:25-67` (`routeOrder`): a single attempt. If the CLOB returns 429 (rate limit), 502, or any 5xx, the order is marked rejected (line 63: `updateOrderStatus(order.order_id!, 'rejected', undefined, errorMsg)`) and the engine moves on. There is no "retry once after 1 second on 5xx." A transient blip = a missed trade.

`utils/retry.ts:13` would wrap this in 4 lines and improve fill rates measurably.

**D7.6 — [P1] Order builder uses hardcoded fee rate.**
`execution/clob-router.ts:124`: `fee_usdc: roundTo(order.price * order.size * 0.02, 4)` — hardcoded 2% taker fee. Polymarket fees are dynamic and per-market (`maker_base_fee` and `taker_base_fee` are part of each market's Token data — visible in `market/sampling-poller.ts:131-132`). The 2% number is approximately right for some markets but wrong for others. P&L accounting is therefore wrong by a small per-trade amount; over thousands of R&D trades, the cumulative bias matters.

**D7.7 — [P1] Polygon RPC list in auto_redeem.py is hardcoded and not health-checked over time.**
`Polymarket/auto_redeem.py:46-51`: 4 RPCs (`polygon.drpc.org`, `rpc.ankr.com/polygon`, `polygon-bor-rpc.publicnode.com`, `polygon.meowrpc.com`). `get_web3()` (line 125) tries them in order. The first connecting RPC wins for the entire run. If that RPC silently lies (returns stale block numbers), no consistency check happens. No multi-RPC quorum (e.g., compare block numbers across 2 RPCs and require they match within 5 blocks).

`execution/clob-router.ts:175` hardcodes `'https://polygon.drpc.org'` for the viem wallet — single RPC, no fallback.

---

## Section 8 — Restart resilience

### Files reviewed
- `polybot-v2/src/core/lifecycle.ts` (38 lines)
- `polybot-v2/src/core/engine.ts` (393 lines)
- `polybot-v2/src/entity/entity-manager.ts:17-73` (initialize)
- `polybot-v2/src/index.ts` (37 lines)

### Findings

**D8.1 — [P0] Engine startup does NOT reconcile against the exchange.**
`engine.ts:98-167` (`start()`):
1. `initDatabase()` — opens SQLite
2. `applySchema()` — runs schema migrations
3. `entityManager.initialize()` — loads entity state from DB only (`entity-manager.ts:44-54`)
4. `strategyRegistry.initializeAll()` — initializes strategies
5. `wireEvents()` — wires event handlers
6. `samplingPoller.start()` — starts polling CLOB sampling-markets (this fetches MARKETS, not POSITIONS)
7. `orderbookWs.connect()` — opens WebSocket
8. Sets up scan/risk/snapshot/advisor intervals

**At no point does the engine:**
- Call `DataApiClient.getOpenPositions(proxyWallet)` to get the actual on-chain positions and reconcile against `getOpenPositions()` from local DB
- Call `client.getOpenOrders()` (CLOB) to get any orders left dangling from a pre-crash state
- Read on-chain CTF token balances via `ctf.balanceOf(wallet, tokenId)` for each open position to verify the engine's view matches reality
- Read on-chain USDC balance via `usdc.balanceOf(wallet)` to set initial cash
- Cancel any "open" orders in the local DB that are now stale

`DataApiClient` is defined at `polybot-v2/src/market/data-api-client.ts:7` and exposes `getOpenPositions()`, `getResolvedPositions()`, `getActivity()` — but **it is imported nowhere**. Confirmed via Grep for `DataApiClient`. The class is dead code. The reconciliation infrastructure was built and forgotten.

**The crash-and-restart behavior is therefore: pick up exactly where the local DB says we were, regardless of what actually happened on the exchange.** A fill that landed but failed to write to the DB is invisible forever. An order that was created-but-not-yet-posted is leaked. A resolution that auto_redeem.py claimed on-chain is invisible to the engine until the next resolution-checker pass — and even then, the engine credits the payout to its own DB cash (`engine.ts:200-208`) without any check that auto_redeem.py already updated the on-chain USDC.

**D8.2 — [P0] Cash accounting is double-tracked (engine DB vs on-chain) with no reconciliation.**
- The V2 engine maintains `entities.current_cash` in its SQLite DB and updates it on every fill (`engine.ts:264-282`) and every resolution (`engine.ts:200-208`).
- `auto_redeem.py` (running as a cron, see Section 10) interacts with the on-chain CTF/NegRiskAdapter to claim resolved positions, increasing the on-chain USDC balance.
- The V2 engine **never reads on-chain USDC**. It does not know auto_redeem.py exists.

This means the engine's `current_cash` value diverges from on-chain reality whenever:
- Auto-redeem claims a position before the V2 resolution checker sees it (then both credit it).
- Auto-redeem fails (engine still credits its DB).
- A market resolves and is claimed-and-spent off-engine (Dale manually trading on the website).
- USDC is deposited or withdrawn from the wallet directly.

The status.md numbers ("Cash: $2.49 | Starting capital: $257.09") are the engine's view. The actual on-chain wallet balance could be wildly different and Track D cannot verify (no VPS access).

**D8.3 — [P1] Lifecycle handlers exit aggressively on uncaught exceptions.**
`core/lifecycle.ts:24-30`: an `uncaughtException` triggers `engine.stop('uncaught_exception')` then `process.exit(1)`. systemd will then restart per `Restart=on-failure` (D1.2). If the uncaughtException happens **inside a strategy.evaluate()** call mid-cycle, the engine has placed some orders but not others, and the restart picks up with no awareness of the partial cycle. There is no "cycle commit" semantics; cycles are not atomic.

Also: `unhandledRejection` (line 32-34) just logs `error` — no exit, no shutdown. A leaked Promise rejection in the SamplingPoller, ResolutionChecker, or any strategy will silently spew log noise and the engine keeps running with potentially-broken state.

**D8.4 — [P1] `event-bus.emit()` is sync — listeners can throw and break the emitter.**
Standard Node EventEmitter semantics. If `wireEvents()` (`engine.ts:357-366`) registers a listener that throws synchronously, the emit() will throw, propagating the error up through whatever called emit(). Cycle phases can fail mid-iteration. No try/catch around emit() calls. Hard to audit without instrumenting; flag for manual review.

**D8.5 — [P1] `captureSnapshots()` is the "final snapshot" on shutdown — but is best-effort sync.**
`engine.ts:181-186`. If snapshot insertion throws, the shutdown handler at `lifecycle.ts:13-19` does not catch it (line 16: `await engine.stop(signal);`) — the shutdown will throw and the `process.exit(0)` at line 19 will not run. systemd will then signal and force-kill. The DB might be in WAL state with uncheckpointed data.

**D8.6 — [P2] No "scan cycle in flight" guard during shutdown.**
`engine.ts:169-187` (`stop()`): clears intervals, stops poller, disconnects WS, captures snapshot. But the **currently-executing scan cycle** (called at `engine.ts:125`) keeps running asynchronously. The interval is cleared so no NEW cycle starts, but the current cycle continues with `entityManager`, `riskEngine`, `clobRouter` references that are in the middle of being torn down. Race condition: a fill that completes after `closeDatabase()` (engine.ts:183) tries to write to a closed DB and throws. No `await currentCycle` semaphore.

---

## Section 9 — VPS hardening (paper review)

### Files reviewed
- `Polymarket/deploy/setup_vps.sh` (540 lines) — canonical fresh-droplet setup
- `Polymarket/docs/infrastructure-summary-2026-03-28.md`
- `Polymarket/docs/AMS3-DEPLOYMENT-SUMMARY.md`
- `Polymarket/docs/audit-plan-2026-04-09.md:106` (known concern)
- `Polymarket/docs/system_status_2026-03-31.md:297`
- Grep results for `fail2ban`, `unattended-upgrades`, `auditd`

### Findings

**D9.1 — [P0] No fail2ban. No SSH brute-force protection in setup_vps.sh.**
Grep for `fail2ban` across `Polymarket/`: zero matches. `setup_vps.sh:20` installs `python3 python3-pip python3-venv ufw curl jq git` — no `fail2ban`. Per `docs/context.md:13` SSH is on port 2222, which buys obscurity (slows scanners by ~95%) but doesn't stop targeted brute force. With root SSH enabled (see D9.4), this is critical.

**D9.2 — [P0] UFW only opens port 22, not the actual SSH port (2222), and never opens 80/443/9100/9200.**
`setup_vps.sh:25-29`:
```
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
echo "y" | ufw enable
```
This is the canonical setup script. It opens port 22, but `docs/context.md:13` and the deploy scripts use port 2222. **If `setup_vps.sh` is the actual setup script that ran on the live VPS, then port 22 is open and port 2222 is not.** Either:
- (a) `setup_vps.sh` is stale and the actual setup is undocumented (most likely), or
- (b) The VPS has both port 22 and 2222 open, with port 22 sitting there inviting brute force.

`infrastructure-summary-2026-03-28.md:67-70` claims UFW is configured with "80 (HTTP), 443 (HTTPS), 2222 (SSH)" — but no script in the tree configures this. It's been done by hand, undocumented, untestable.

Also missing: rules for the dashboard ports 9100/9200 (V2 engines) — these are mentioned in the engine config but I cannot verify whether they're firewall-blocked from the public internet. Per the same docs file, dashboard ports are localhost-only with nginx reverse proxy in front, but the config for that nginx reverse proxy is not in the tree.

**D9.3 — [P0] No unattended-upgrades. No automatic security patching.**
Grep for `unattended-upgrades`: zero matches. `setup_vps.sh` does not install or enable automatic security updates. Ubuntu 24.04's unattended-upgrades is not enabled by default for a fresh droplet (depends on how the image was built). The VPS may be running an unpatched kernel, an unpatched OpenSSL, an unpatched OpenSSH. With a wallet private key on this host, every CVE is a 5-figure-loss probability event.

**D9.4 — [P0] Root SSH login is the documented connection method.**
`docs/context.md:156`: `ssh -i deploy/armorstack_vps_key -p 2222 root@178.62.225.235`. Every deploy script connects as root (see D3 series). There is no service user. There is no `PermitRootLogin no` in any sshd config in the tree. Combined with D9.1 (no fail2ban) and D9.3 (no auto-updates), this is the highest-risk configuration on the box.

**D9.5 — [P0] No audit logging. No `auditd`. No fleet log shipping.**
Grep for `auditd|/var/log/auth.log|aureport`: zero matches. There is no audit trail of who SSH'd in when, what commands were run, what files were touched. Forensics after a compromise = "guess based on file mtimes."

**D9.6 — [P1] No kernel hardening. No sysctl tuning.**
Nothing in `setup_vps.sh` touches `/etc/sysctl.d/`. No `kernel.kptr_restrict`, no `kernel.dmesg_restrict`, no `net.ipv4.tcp_syncookies`, no `kernel.unprivileged_bpf_disabled`, no `kernel.yama.ptrace_scope`. Default Ubuntu settings.

**D9.7 — [P1] No filesystem ACLs on `/opt/polybot-v2/`.**
The directory is created at `setup_vps.sh:35-38` (V1 paths) — V2 directory creation is implicit in `polybot-v2/scripts/deploy-vps.sh:23-25` which does `mkdir -p ${REMOTE_DIR}/{dist,config,data,systemd}` with no `chmod`. Default umask = 022, so files end up world-readable. The `.env` file (containing the wallet password and any CLOB API secrets) inherits this. There's no `chmod 600 .env` in any deploy script.

**D9.8 — [P1] Geoblock check at install time, not at runtime.**
`setup_vps.sh:51-65` checks `polymarket.com/api/geoblock` once during initial setup. If the VPS is later detected as US-IP (e.g., DigitalOcean rotates IPs, network change), there is no runtime check. The engine will keep trying to place orders that the CLOB will reject. No alert, no automated migration.

**D9.9 — [P2] Hardcoded plaintext credentials written to disk on first run.**
Already noted in D3.5 — `setup_vps.sh:71-90` writes the wallet private key, CLOB API key/secret/passphrase, and a GitHub PAT to `api_keys.json` with `chmod 600`. The `chmod 600` is fine, but the script content is in the workspace tree, OneDrive-synced. Microsoft cloud has a copy.

**D9.10 — [P2] Log rotation is configured for V1 logs only.**
`setup_vps.sh:508-518` writes `/etc/logrotate.d/armorstack` for `/opt/armorstack/polymarket/logs/*.log`. No logrotate config exists for V2's journald output (which is managed by systemd-journald, not logrotate, but still needs `journalctl --vacuum-time=` configured). No logrotate for `/opt/polybot/logs/*.log` (the V1-style logs the redeem cron writes). Risk: disk fill silently on a busy day.

**D9.11 — [P2] No HIDS / file integrity monitoring.**
No `aide`, `tripwire`, `osquery`, `wazuh`, or similar. After a compromise, no way to know what files were changed.

**D9.12 — [P2] No 2FA on SSH.**
Standard expectation for a host with a live wallet. Not configured.

---

## Section 10 — Cron jobs

### Files reviewed
- `Polymarket/auto_redeem.py` (selected, ~470 lines)
- `Polymarket/deploy/deploy_auto_redeem_v3.sh:108-115` (cron entry)
- `Polymarket/deploy/setup_vps.sh:494-503` (sprint cron)
- `Polymarket/deploy/update_crontab.py` (cron management script)
- `Polymarket/deploy/deploy_grinder.sh:25-44` (grinder cron)
- `Polymarket/deploy/deploy_entity.sh:152-179` (per-entity crons)
- `Polymarket/docs/status.md` (V1 cron context)

### Findings

**D10.1 — [P0] V1 `auto_redeem.py` cron has authority over the wallet that V2 trades from.**
Per `docs/context.md:152`: "Auto-redeem: v1 `auto_redeem.py` cron every 30 min." The cron pattern from `deploy_auto_redeem_v3.sh:115`: `*/30 * * * * /opt/polybot/venv/bin/python3 /opt/polybot/auto_redeem.py >> /opt/polybot/logs/redeem.log 2>&1`.

This script:
1. Loads the **same wallet private key** (`auto_redeem.py:315`) that the V2 prod engine uses for live trading.
2. Calls `setApprovalForAll(NEG_RISK_ADAPTER, true)` (line 221-230) — granting the NegRiskAdapter contract permission to move CTF tokens. This is a one-time on-chain authorization that persists across V1 and V2.
3. Iterates redeemable positions (`auto_redeem.py:365-439`), submits redeem TXs.
4. Sweeps a portion to "reserve" (`auto_redeem.py:447`).

**Conflicts with V2:**
- The V2 ResolutionChecker (`risk/resolution-checker.ts:37`) credits payouts to the engine's `current_cash` field on every cycle.
- The V1 auto_redeem cron credits the same payouts to the on-chain USDC balance, which the V2 engine **does not read**.
- If both run, the engine thinks it has the cash (because V2 credited it), and the chain has the cash (because V1 redeemed it). Net effect: cash is correctly held in one place. But there's no audit trail tying them together.
- If V1 fails (RPC outage, gas spike, broken approval), V2 still thinks the position resolved profitably and adjusts cash and lockout calculations. The wallet has CTF tokens that nobody is claiming.
- If V1 succeeds before V2's resolution checker runs, V2 will still try to "settle" the position via its own logic (deleting it from the open positions table at `risk/resolution-checker.ts:116`) — but the position never existed in V1's view, so V1 will not double-redeem. This case is benign.
- If V1 silently fails over many days, redeemable positions accumulate on-chain and the wallet's "free" USDC for new V2 trades drops to zero — the V2 engine will see "$2.49 cash" (from `status.md:9` — already nearly depleted!) and stop trading, with no understanding why.

**Recommendation (no fix in audit, just observation):** The V2 engine should be the only thing touching this wallet, OR it should periodically reconcile its DB cash against on-chain USDC. Currently neither is true. The V1 cron is operating in the dark next to the V2 engine.

**D10.2 — [P1] auto_redeem.py is undocumented inside the V2 system but mission-critical.**
- It's referenced in `docs/context.md:152` as a one-line note.
- Its cron schedule is documented in `deploy_auto_redeem_v3.sh:115` as a comment, not in any operational doc.
- There's no monitoring on whether it's actually running (last successful run, last failure reason).
- The log file is `/opt/polybot/logs/redeem.log` with no rotation guarantees.
- Failures silently accumulate in the JSON log file at `STATE_DIR / "redeem_log.json"` (line 38) which is truncated to last 100 entries (line 299). Beyond 100 errors, history is lost.

**D10.3 — [P1] auto_redeem.py and the V1 deploy script reference TWO DIFFERENT VPSes.**
Already noted in D3.6 — `deploy_auto_redeem_v3.sh:15` deploys to `209.38.40.80` while V2 is on `178.62.225.235`. **If the script ran successfully, it deployed to the wrong host.** Either:
- (a) the script never ran and auto_redeem.py is the version that's already on 178.62.225.235 (manually copied), or
- (b) there's a second VPS at 209.38.40.80 with its own copy of auto_redeem.py running with the same wallet key, redeeming positions for the same wallet, in parallel. Two crons claiming the same positions would cause nonce collisions and tx reverts.

**Without VPS access, Track D cannot disambiguate.** This is a question for Dale.

**D10.4 — [P1] Other crons are scattered across deploy scripts with no central inventory.**
- `deploy/setup_vps.sh:499`: `*/15 * * * * sprint_trader.py --execute --risk 20` (V1 sprint trader, every 15 min)
- `deploy/deploy_grinder.sh:36`: `*/10 * * * * /opt/polybot/run_grinder.sh` (V1 grinder, every 10 min)
- `deploy/deploy_entity.sh:163-173`: 11 cron lines per entity for `reconcile.py`, `run_sprint.sh`, `run_quick_cycle.sh`, `arb_executor.py`, `position_monitor.py`, `auto_deposit.py`, `health_monitor.py`, `auto_redeem.py`, `correctness_verifier.py`, `open_orders_cache.py`, `run_auto.sh`. **11 cron entries × 11 entities = 121 potential cron lines** (the script adds them per-entity).
- `Polymarket/docs/BACKUP_SETUP.md:53`: `0 3 * * * /opt/polybot/backup_state.sh` (V1 backup, daily at 03:00 UTC).
- `deploy/update_crontab.py:42-54`: writes a "PROD TRADING ENGINE" block of 6 cron lines, all PAUSED with `#PAUSED#` prefix.

**There is no single document listing which crons are currently active on the VPS.** Track D cannot enumerate them. The risk is that V1 crons that should have been disabled when V2 launched are still running, fighting V2 for the same wallet, the same positions, the same database.

**D10.5 — [P1] `update_crontab.py:7-39` removes-and-replaces crontab entries by regex.**
The script is destructive (overwrites the user's crontab via `subprocess.run(["crontab", "/tmp/cron_new.txt"], check=True)` line 62). It removes entries matching 14 regex patterns (lines 12-27) — but matching is `re.search(pat, line, re.IGNORECASE)`. A custom cron entry that happens to contain the substring "grinder" or "orchestrator" or "sprint_trader" gets clobbered. No backup of the previous crontab.

**D10.6 — [P2] No `flock` on auto_redeem cron.**
`deploy_auto_redeem_v3.sh:115` cron line: `*/30 * * * * /opt/polybot/venv/bin/python3 /opt/polybot/auto_redeem.py >> /opt/polybot/logs/redeem.log 2>&1`. No `flock`. If a previous run hangs (RPC timeout = up to 90s per TX, with 100+ positions = potentially many minutes), the next 30-minute boundary fires a second instance, both reading the same nonce, both submitting TXs that conflict.

The PAUSED prod engine block in `update_crontab.py:47-50` does use `flock -n /tmp/rd_prod_*.lock` — so the pattern is known. It's just not applied to auto_redeem.

**D10.7 — [P2] `update_crontab.py` removes a number of entries it shouldn't be touching.**
Line 24: `r"correlation_tracker"` — this regex would also match a cron line for "correlation_tracker_v2" or any future correlation tool. The remove patterns are aggressive.

---

## Cross-cutting observations

### Skill applications

**`ar-observability-designer`:** Map of what's missing:
- Metrics layer: nothing. (Should be Prometheus-compatible: `polybot_scan_cycle_duration_seconds`, `polybot_orders_placed_total`, `polybot_orders_rejected_total{reason}`, `polybot_upstream_errors_total{upstream}`, `polybot_resolution_check_duration_seconds`, `polybot_open_positions{entity}`, `polybot_cash_balance{entity}`.)
- Tracing: nothing. (Should be OpenTelemetry-instrumented from the scan cycle entry point through strategy → risk → execution → DB write.)
- Logs: structured pino → journald only. (Should ship to a centralized store: Loki or Better Stack or even DigitalOcean Logs.)
- Events: in-process EventEmitter only, ephemeral. (Should be persisted to a `polybot_events` table for replay.)
- Health: no `/health`. (Should expose unauthenticated `/healthz` returning `{ ok: true, last_cycle_at: ..., uptime_s: ..., db_ok: true, ws_connected: true }`.)
- Dashboards: 1 (the SSE dashboard), human-driven, no SLOs. (Should have an SLO dashboard: cycle latency p95, fill success rate, upstream error rate.)

**`ar-runbook-generator`:** Runbooks that should exist but don't:
1. `runbooks/engine-crash-loop.md` — what to do when systemd `start_limit` is hit.
2. `runbooks/wallet-out-of-gas.md` — auto_redeem.py needs MATIC. How to top up. How to detect.
3. `runbooks/clob-credentials-rejected.md` — what to do when the CLOB returns 401.
4. `runbooks/db-corruption.md` — recovery procedure for `polybot.db` and `rd.db`.
5. `runbooks/cash-balance-divergence.md` — what to do when the engine's `current_cash` and on-chain USDC drift.
6. `runbooks/restore-from-snapshot.md` — restore from the 2026-04-08 DigitalOcean snapshot.
7. `runbooks/strategy-advisor-not-promoting.md` — debug why R&D-validated sub-strategies aren't enabling on prod.
8. `runbooks/gamma-api-down.md` — what positions are at risk when Gamma is unreachable.
9. `runbooks/auto-redeem-failure-recovery.md` — manual on-chain redemption procedure.
10. `runbooks/v1-cron-conflict.md` — when V1 and V2 fight over the wallet.
11. `runbooks/full-vps-rebuild.md` — bare-metal disaster recovery.
12. `runbooks/secret-rotation.md` — rotate the wallet, the CLOB API key, the SSH key, the dashboard password.

**Zero of these exist.** The closest things are `BACKUP_SETUP.md` (incomplete and V1-only) and `DEPLOYMENT_GUIDE.md` (deploy procedure, not incident response).

**`bcdr-planning`:** DR posture summary:
| Requirement | Documented? | Tested? | Achievable? |
|---|---|---|---|
| RTO target | No | No | Unknown |
| RPO target | No | No | Currently ~24h+ |
| Backup frequency | V1 daily, V2 never | V1 yes (1 manual run), V2 no | Sub-hour SQLite backup is trivial; not done |
| Backup integrity check | No | No | — |
| Off-host backup | No (`Polymarket/backups/` is ad-hoc and stale) | No | — |
| Restore drill | Never performed | No | — |
| Wallet key recovery | Plaintext in workspace tree only | No | High-risk |
| Multi-region failover | No | — | — |

### Adversarial review

I challenged each finding with: "Is this a real risk, or am I being theoretical?"

- **D1.1 (root user):** Real. Any of the 11 prod npm deps could ship a malicious version. `viem ^2.46.0` and `@polymarket/clob-client ^5.8.1` are critical-path; both have transitive deps. A typosquat or compromise = root code execution = wallet drained. Severity is correct.

- **D1.2 (no startup reconcile):** Real and high-impact. Confirmed by tracing every import — `DataApiClient` is dead code. A crash 1 second after a fill posts but before the DB write loses the position. The prod engine has 40 open positions per status.md; a single missed write is recoverable in theory (Polymarket Data API can be queried), but the engine won't do that automatically. Severity correct.

- **D2.1 (broken Dockerfile):** Real but P1 not P0 because nothing depends on it. Risk is "future engineer wastes time."

- **D3.1 (no graceful deploy):** Real. I can construct the failure mode: prod_rebuild.sh restarts the engine while a `client.postOrder()` is in flight. The signed order is in Polymarket's queue. The engine restarts. The order fills in the next 200ms. The engine has no record. The position is invisible until the resolution checker queries that conditionId 5 minutes later — at which point the position is in `getAllOpenPositions()` view... but **only because a position row was written**, which never happened because the restart killed the process before line 309 of engine.ts. Net result: invisible filled order. Severity correct.

- **D3.5 (secrets in tree):** Real. This is a Track A/B finding too, but Track D's angle is that the deploy infrastructure is built around these plaintext secrets, so any "fix" requires reworking the deploy scripts, not just rotating the keys.

- **D4.3 (retry/rate-limiter dead):** Real and embarrassing. The grep is conclusive. The infrastructure-not-wired pattern is the most fixable finding in the whole audit (low effort, high payoff).

- **D5.1 (no alerting):** Real. I tried to construct a "this is fine because Dale watches the dashboard" counter-argument and it doesn't hold up at 3am, on weekends, when Dale is on a flight, etc.

- **D5.3 (silent gamma swallow):** Real. Confirmed at `risk/resolution-checker.ts:51-56`. The `log.warn` is the only signal. If Dale isn't tailing logs, Gamma can be down for an arbitrary period and the engine will silently freeze on resolutions while continuing to place new bets.

- **D6.1 (V2 not backed up):** Real. Verified by reading `BACKUP_SETUP.md:16-32` end-to-end. The script paths are V1. There is no V2 path in any backup script in the tree.

- **D7.1 (no retries on HTTP):** Real. Six upstreams, six places, zero retries, all would be fixed by importing `withRetry` and wrapping. This is the lowest-effort highest-payoff fix in the audit.

- **D8.1 (no startup reconcile):** Real. Same as D1.2 from a different angle.

- **D8.2 (cash double-tracking):** Real and dangerous. The engine has $2.49 cash and 40 positions. If auto_redeem claimed any positions, the on-chain reality and the engine's reality have diverged. Without VPS access I cannot quantify the divergence.

- **D9.x (VPS hardening):** All inferred from `setup_vps.sh`. If the live VPS configuration differs (manually hardened by Dale), then some of these are false positives. The audit-plan at `docs/audit-plan-2026-04-09.md:106` flags VPS hardening as an open question, so this is consistent with the project's own awareness.

- **D10.1 (V1 cron conflict):** Real. Confirmed by tracing wallet ownership from `auto_redeem.py:315` (loads same `POLY_PRIVATE_KEY` from `api_keys.json`) and the engine's CLOB router (`clob-router.ts:171` `privateKeyToAccount(this.privateKey)`). Both processes hold and use the same key.

- **D10.3 (two VPS IPs):** Real and unresolved. Cannot determine ground truth without VPS access.

### What Track D could not verify (and why it matters)

Without VPS access, Track D cannot:
- Confirm which port SSH is actually on (22 vs 2222)
- Confirm whether fail2ban / unattended-upgrades / auditd are actually installed
- Confirm what's actually in the live crontab right now
- Confirm whether the on-chain wallet balance matches the engine's `current_cash` value
- Confirm whether `auto_redeem.py` ran successfully recently
- Confirm whether the second VPS at 209.38.40.80 exists
- Read the actual journald logs for crash history
- Test whether the SSE dashboard is reachable

These should be verified by a separate VPS-access track or by Dale himself before any "remediation" planning.

---

## Severity rollup

**P0 (12 findings):** D1.1, D1.2, D3.1, D3.2, D3.3, D3.4, D3.5, D4.1, D4.2, D4.3, D5.1, D5.2, D5.3, D6.1, D6.2, D6.3, D6.4, D7.1, D7.2, D7.3, D7.4, D8.1, D8.2, D9.1, D9.2, D9.3, D9.4, D9.5, D10.1
**P1 (~20 findings):** D1.3, D1.4, D1.5, D2.1, D3.6, D3.7, D3.8, D3.9, D3.10, D4.4, D4.5, D5.4, D5.5, D6.5, D6.6, D7.5, D7.6, D7.7, D8.3, D8.4, D8.5, D9.6, D9.7, D9.8, D10.2, D10.3, D10.4, D10.5
**P2 (~14 findings):** D1.6, D1.7, D1.8, D2.2, D3.11, D3.12, D4.6, D4.7, D5.6, D6.7, D9.9, D9.10, D9.11, D9.12, D10.6, D10.7
**P3 (1 finding):** D1.9

Counts above are approximate; the underlying P0 count exceeded my own initial estimate. The system is operating well past its design comfort zone for an unattended live-trading deployment.

---

## Conclusion

Track D's verdict: **the engine works because Dale is watching it.** Every single operational gap that should be filled by automation, monitoring, alerting, retries, circuit breakers, backups, or runbooks is filled by Dale's attention instead. This is sustainable for development. It is not sustainable for production trading at scale.

The single most impactful, lowest-cost fix in the entire audit: **wire `withRetry()` and `RateLimiter` into the six HTTP call sites that don't use them.** That's a 1-day project and would eliminate the Gamma-flake-causes-resolution-freeze risk and the CLOB-rate-limit-causes-missed-fill risk in one stroke.

The single most dangerous gap: **no startup reconciliation against the exchange.** Combined with `Restart=on-failure`, the engine can be silently lying about its position book within seconds of any crash. Until reconciliation is added, every restart is a small risk of permanent state divergence.

The single most embarrassing gap: **the documented backup system does not back up the database the system actually uses.** This will be discovered the hard way the first time the VPS dies.

End of Track D findings.

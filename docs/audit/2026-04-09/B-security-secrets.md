# Track B — Security & Secrets Audit

> Audit date: 2026-04-09
> Auditor: subagent (Track B — Security & Secrets, P0 financial-impact track)
> Scope: V2 dual-engine (`polybot-v2/`) plus surrounding workspace tree under `Polymarket/`. Read-only paper review. No VPS commands, no value exfiltration.

---

## Summary

This workspace is in a **post-breach posture**. The single highest-severity finding is not the pre-flagged SSH key — it is an **active live-trading wallet credential set committed in plaintext inside `Polymarket/deploy/setup_vps.sh`** (an Ethereum private key controlling `0x2B46…3DB9` and the proxy wallet `0x606A…F09E`, plus Polymarket CLOB API key/secret/passphrase, plus a GitHub PAT). This file lives in a OneDrive-synced workstation directory and has therefore been replicated to Microsoft cloud, OneDrive version history, and any device that has ever touched the OneDrive root. The pre-flagged SSH key (`Polymarket/deploy/armorstack_vps_key`) has the same exposure surface and gives root on the VPS at `178.62.225.235:2222`. A second copy of the same credential JSON exists at `scripts/simulator/state/api_keys.json`. The dashboard auth, while reasonably built, derives its HMAC session-signing key directly from `DASHBOARD_PASSWORD`, which is itself committed in plaintext at `polybot-v2/systemd/polybot-v2-rd.service:20` — meaning any reader of the repo can both log in **and** forge arbitrary session cookies for both the prod and R&D dashboards. Both systemd units run as **root** with no user isolation. Treat the wallet, the VPS, and the dashboard as fully compromised pending rotation. Code-level posture inside `polybot-v2/src/` is otherwise reasonable: no `eval`/`exec`/`spawn`, parameterised SQL, log hygiene clean, dual-flag live-mode gate is honoured at startup. Supply chain is small and well-known.

---

## P0 Findings (active financial risk — rotate before any other work)

### B-P0-1: Live wallet private key + CLOB API credentials + GitHub PAT committed in plaintext (setup_vps.sh)

- **File**: `Polymarket/deploy/setup_vps.sh:71-90`
- **Severity**: **P0 — CRITICAL — wallet compromise**
- **Evidence (values redacted)**:
  - `setup_vps.sh:74` — `GITHUB_TOKEN — type: github_pat — value redacted` (live PAT, committed in heredoc)
  - `setup_vps.sh:76` — `POLY_PRIVATE_KEY — type: ethereum_private_key (0x + 64 hex) — value redacted` (controls live trading wallet)
  - `setup_vps.sh:77` — `POLY_API_KEY — type: polymarket_clob_api_key — value redacted`
  - `setup_vps.sh:78` — `POLY_SECRET — type: polymarket_clob_api_secret — value redacted`
  - `setup_vps.sh:79` — `POLY_PASSPHRASE — type: polymarket_clob_passphrase — value redacted`
  - `setup_vps.sh:80` — `POLY_ACCOUNT_ADDRESS — type: ethereum_address — 0x2B46…3DB9` (public address; safe to log)
  - `setup_vps.sh:81` — `POLY_PROXY_ADDRESS — type: polymarket_proxy_wallet — 0x606A…F09E` (public address)
- **Root cause** (per `obra-root-cause-tracing`): A bootstrap shell script was written to provision the VPS in one shot; the author inlined the production credentials directly into a heredoc instead of templating them or pulling from a secrets store. The script was then saved to a folder synced by OneDrive. Every subsequent edit to the workspace propagated the file (and its history) to Microsoft cloud storage.
- **Exposure surface**:
  1. OneDrive cloud sync (Microsoft retains version history — even if the file is deleted today, prior versions are recoverable for ~30 days under default retention, longer with retention policies).
  2. Any Windows machine ever signed into the same OneDrive account.
  3. Local Windows file index (Windows Search), Recycle Bin, NTFS USN journal, Volume Shadow Copies.
  4. Any backup tool that has ever scanned the workspace (Veeam, Carbonite, BackBlaze, Time Machine if mirrored).
  5. Any AI assistant session that has read the workspace tree (Claude Code sessions, Copilot indexing, Cursor).
- **Impact**: Full custody of the live trading wallet. Anyone with the private key can sign withdrawals, drain USDC and PolySys positions to an attacker-controlled address. The CLOB API credentials enable order placement and cancellation on behalf of the entity. The GitHub PAT enables repository writes (potential supply-chain pivot back into the trading codebase).
- **Recommended fix** (do not implement — findings only): (a) Treat wallet as compromised — sweep all USDC, USDC.e, and conditional tokens to a freshly generated wallet **before** doing anything else. (b) Revoke the Polymarket CLOB API key via `curl -X DELETE https://clob.polymarket.com/auth/api-key` (or via the CLOB SDK). (c) Revoke the GitHub PAT immediately at https://github.com/settings/tokens. (d) Rewrite git history if any git mirror exists (it doesn't appear to — the workspace is not a git repo — but check `Polymarket/backups/`, `Polymarket/Polymarket Project Summary Info/`, and any other archive locations). (e) Replace the heredoc in `setup_vps.sh` with a template that reads from environment variables passed via SSH at deploy time, or from a secrets manager (Doppler / 1Password CLI / HashiCorp Vault / DigitalOcean App Platform secrets). (f) Add this file to a `.gitignore` and to a OneDrive exclusion rule (`%OneDrive%\…\Polymarket\deploy\` excluded from sync).
- **Effort**: 30 min to revoke + sweep, 2 h to redo provisioning with secret injection. The hard part is the wallet sweep — gas costs and CLOB-side position unwinding.
- **REBUILD scope**: MUST be remediated before resuming live trading on the rebuilt V2 stack. Cannot be carried into the rebuild as-is.
- **Skills cited**: `ar-env-secrets-manager`, `ar-secrets-vault-manager`, `ar-incident-response`, `mcs-conducting-cloud-incident-response`, `obra-root-cause-tracing`.

### B-P0-2: SSH private key for live VPS (`armorstack_vps_key`) in OneDrive-synced folder

- **File**: `Polymarket/deploy/armorstack_vps_key`
- **Metadata** (no `cat`, no read): size **419 bytes**, mode `-rw-r--r--` (world-readable on the local filesystem), owner `dboehm`, mtime `Mar 21 23:05`. Public counterpart `armorstack_vps_key.pub` is also present (106 bytes, same mode).
- **Severity**: **P0 — CRITICAL — VPS root compromise**
- **Evidence**: `Polymarket/deploy/armorstack_vps_key` (existence + metadata only — file contents NOT read per audit rules)
- **Root cause**: SSH keypair generated locally for VPS bootstrap; placed alongside the deploy scripts for convenience; the parent folder is OneDrive-synced.
- **Exposure surface**: Same as B-P0-1 (OneDrive cloud, version history, any synced device, backups, AI sessions). The 419-byte size and `-rw-r--r--` mode are consistent with an unencrypted ED25519 OpenSSH private key with no passphrase. The Windows file mode `644` does not provide the `0600` confidentiality that OpenSSH expects on POSIX hosts; on the VPS, ssh-agent and sshd would refuse this mode and demand `chmod 600` — but on Windows that protection doesn't apply.
- **Impact**: Anyone holding this key gets `root@178.62.225.235` on port 2222 (per `scripts/deploy-vps.sh:8-10`). That is full control of: the running prod and R&D engines; the SQLite databases at `/opt/polybot-v2/data/` and `/opt/polybot-v2-rd/data/`; the on-VPS `.env` file (which contains `DASHBOARD_PASSWORD` and the live-mode dual-flag values); any wallet credentials cached at `/opt/polybot/state/api_keys.json` per `wallet-loader.ts:30`. From root on the VPS, the attacker can also pivot to the live wallet by reading the entity api_keys.json files.
- **Recommended fix**: (a) Generate a new VPS keypair on a non-synced location (e.g. `%USERPROFILE%\.ssh\` excluded from OneDrive). (b) On a trusted out-of-band channel (e.g. DigitalOcean web console serial), add the new public key to `/root/.ssh/authorized_keys`, remove the old one, and restart sshd. (c) Delete the old key from the workspace AND purge OneDrive version history for the file (Microsoft Admin Center > OneDrive > restore/permanently delete). (d) Move the new key to a Windows directory excluded from OneDrive sync. (e) Long-term: set up a non-root deploy user (`polybot`), enforce key-only auth, disable root SSH login. See B-P2-2.
- **Effort**: 15 min to rotate; 1 h to also rebuild the deploy user posture.
- **REBUILD scope**: MUST be rotated before next deploy. The new key MUST NOT live in the workspace tree.
- **Skills cited**: `ar-secrets-vault-manager`, `mcs-implementing-zero-trust-network-access`, `obra-root-cause-tracing`.

### B-P0-3: Wallet credentials JSON also present in `scripts/simulator/state/api_keys.json`

- **File**: `Polymarket/scripts/simulator/state/api_keys.json`
- **Metadata**: size **690 bytes**, mode `-rw-r--r--`, mtime `Mar 21 18:54`
- **Severity**: **P0 — CRITICAL — duplicate exposure of the same credentials as B-P0-1**
- **Evidence**: file existence + size only. The `setup_vps.sh` heredoc total (GitHub PAT + private key + API trio + addresses + chain id + host) is approximately the same byte count as 690 bytes, making it overwhelmingly likely that this file is the **source** of the heredoc in `setup_vps.sh`. Confirmed by-reference via `wallet-loader.ts:30-31` which reads `state/api_keys.json` and `api_keys.json` in entity directories using exactly the schema in `setup_vps.sh`.
- **Root cause**: `scripts/simulator/` was the early local paper-trading harness; the wallet creds JSON was placed there for the simulator to load via Python (`scripts/simulator/live_trader.py`), then copied verbatim into the VPS provisioning script. Two synced copies; same exposure surface as B-P0-1.
- **Impact**: Identical to B-P0-1. Rotation of the wallet handles both.
- **Recommended fix**: Delete this file after wallet rotation. Add `state/api_keys.json` and `**/api_keys.json` to `.gitignore` and to a OneDrive sync exclusion. The committed `api_keys.json.template` (130 bytes, same dir) is fine and should be kept as the documented schema.
- **REBUILD scope**: MUST be removed in REBUILD. The simulator should load credentials from environment variables only.
- **Skills cited**: `ar-env-secrets-manager`, `obra-root-cause-tracing`.

### B-P0-4: Dashboard HMAC session-signing key derived from DASHBOARD_PASSWORD, which is plaintext-committed

- **File**: `polybot-v2/src/dashboard/sse-server.ts:27` and `polybot-v2/systemd/polybot-v2-rd.service:20`
- **Severity**: **P0 — CRITICAL — full dashboard auth bypass**
- **Evidence**:
  - `sse-server.ts:27` — `const SECRET = createHmac('sha256', process.env.DASHBOARD_PASSWORD ?? 'polybot-v2-session-key').update('session-secret').digest('hex');`
  - `polybot-v2-rd.service:19` — `Environment=DASHBOARD_USER=dboehm@thinkcaspian.com`
  - `polybot-v2-rd.service:20` — `Environment=DASHBOARD_PASSWORD=<plaintext password redacted from this report>`
- **Root cause** (per `obra-root-cause-tracing`):
  1. The session token is `base64(user:expires:hmac_sha256(SECRET, user:expires))` (`sse-server.ts:181-184`).
  2. The signing `SECRET` is deterministically derived from `DASHBOARD_PASSWORD`. There is no separate `SESSION_SECRET` env var.
  3. `DASHBOARD_PASSWORD` for the R&D engine is committed verbatim in the systemd unit file at `polybot-v2-rd.service:20`.
  4. `DASHBOARD_PASSWORD` for prod is loaded from `/opt/polybot-v2/.env` on the VPS — but anyone with the VPS SSH key (B-P0-2) reads it trivially.
- **Why it is P0 even though the password is on the VPS**:
  - For the **R&D dashboard**: anyone with read access to this workspace, this OneDrive, this AI session log, or a backup of any of the above can: (a) log in directly with the credentials at `polybot-v2-rd.service:19-20`, AND (b) compute the HMAC SECRET locally and forge an arbitrary session cookie with any username and expiration. There is no rate-limit on **forged** cookies — the lockout in `sse-server.ts:172-176` only applies to the `/login` POST path, not to unauthenticated requests with a forged session cookie. Dial in, get root over the trading-decision metadata, the strategy code, the trade history, the entity inventory, and (because the dashboards run on the same VPS) lateral movement to the live engine.
  - For the **prod dashboard**: same forgery vector for anyone who has compromised either B-P0-1 (which lets them read the on-VPS `.env`) or B-P0-2 (which gives them root and therefore the `.env`). And the same forgery vector applies if `DASHBOARD_PASSWORD` is ever copied into a chat, screenshot, log, or another file — which is exactly the failure mode that already happened with the R&D unit file.
- **Impact**: Complete authentication bypass. Forged cookies pass `timingSafeEqual` (`sse-server.ts:229`) because the attacker computes the same HMAC. No session is held server-side for valid logged-in users (only CSRF tokens are stored in `this.sessions`), so revocation is impossible without rotating SECRET — which means rotating the password.
- **Adversarial review** (per audit instruction):
  - "But the password is rotated when leaked, right?" No — there's no rotation runbook, no secret manager, no session revocation. The current password is in the systemd file, has been there since at least the file mtime, and has been replicated by OneDrive sync the entire time.
  - "The lockout protects login." Correct — it protects the **password-typing** path, not the **cookie-forgery** path. A forged cookie is a single GET request that never touches `handleLogin`.
  - "Cookies have an 8-hour TTL (`sse-server.ts:25`)." Correct, but the attacker simply forges a cookie with `expires = Date.now() + 31536000000` (1 year). Nothing in the validator caps the expiry against a server-side maximum (`isAuthenticated:233` only checks `Date.now() > expires`).
  - "What about HttpOnly + SameSite=Lax?" Those defend against XSS-based theft of legitimate cookies; they do not defend against forgery from a known signing key.
- **Recommended fix**: (a) Generate a separate `SESSION_SECRET` env var with 32+ random bytes, never derived from the password. Persist it in `/etc/polybot-v2/session.secret` with mode `0600`, owned by the polybot service user (not root — see B-P2-2). On startup, read it and refuse to start if it doesn't exist or is shorter than 32 bytes. (b) Cap session expiry at 8 h on the **server side** in `isAuthenticated`: `if (expires > Date.now() + SESSION_TTL_MS) return false;`. (c) Move to a server-side session store (the existing `this.sessions` Map already has the right shape — extend it to track real sessions, not just CSRF tokens). This gives revocation. (d) Hash the password with bcrypt/argon2 instead of plaintext comparison at `sse-server.ts:179`. (e) Remove `DASHBOARD_PASSWORD` from `polybot-v2-rd.service` entirely; load from a `EnvironmentFile=/etc/polybot-v2/rd.env` that has `chmod 600`.
- **Effort**: 2-3 hours to refactor session management properly, including a migration that invalidates existing cookies.
- **REBUILD scope**: MUST be redesigned in REBUILD. The current scheme is the kind of mistake that makes a security professional roll their eyes — it's textbook key reuse.
- **Skills cited**: `sk-vibe-code-auditor` (this is exactly the kind of thing AI-assisted code produces — it looks plausible but has key reuse), `ar-skill-security-auditor`, `cissp-security-engineer`, `obra-root-cause-tracing`.

### B-P0-5: Plaintext production password committed in systemd unit file

- **File**: `polybot-v2/systemd/polybot-v2-rd.service:19-20`
- **Severity**: **P0 — combined with B-P0-4 above; also worth flagging on its own**
- **Evidence**:
  - Line 19: `Environment=DASHBOARD_USER=dboehm@thinkcaspian.com`
  - Line 20: `Environment=DASHBOARD_PASSWORD — type: dashboard_credential — value redacted`
- **Root cause**: Convenience — environment variables baked directly into the unit file so the service starts without an external `.env`. Standard anti-pattern.
- **Impact**: As B-P0-4 — but separately, this also means the password is in the OneDrive cloud, in any backup, and in any AI session that has read this file, regardless of the SECRET-derivation issue.
- **Recommended fix**: Replace lines 19-20 with `EnvironmentFile=/etc/polybot-v2/rd.env` (mode 0600, root-owned). Move the actual values into that file on the VPS only, not in the workspace tree. Long-term: secrets manager.
- **REBUILD scope**: MUST be removed. R&D systemd unit should mirror the prod one (`polybot-v2.service:18` already does it correctly).
- **Skills cited**: `ar-env-secrets-manager`, `ar-secrets-vault-manager`.

---

## P1 Findings

### B-P1-1: Wallet credentials cached in process memory for the lifetime of the engine

- **File**: `polybot-v2/src/execution/clob-router.ts:75-90` and `clob-router.ts:148-162`
- **Severity**: **P1 — secondary risk if process memory is compromised**
- **Evidence**: `ClobClientWrapper` stores `privateKey`, `apiSecret`, `apiPassphrase` as instance fields and keeps the wrapper in `this.clobClients` Map (`clob-router.ts:17`) for the entire lifetime of the engine. The `EntityState.credentials` in `entity-manager.ts:30-43` also holds them in plaintext for the engine lifetime.
- **Impact**: Any process-memory dump (a core dump, an `lsof`/`/proc/$PID/mem` read by root, an `ltrace`/`strace` capture, a Node.js `--inspect` debugger if enabled) reveals the wallet key. Heap snapshots if dev tools are ever attached. Crash logs if any third-party telemetry is added later.
- **Why P1, not P0**: The exposure requires already having local code execution on the VPS. So if the SSH key (B-P0-2) is rotated, the proximate threat shrinks. But it's still a blast-radius issue.
- **Recommended fix**: (a) Use viem's `createWalletClient` with the account scoped to the signing call only; do not retain the private key in memory between orders. The CLOB API key/secret/passphrase need to be retained to talk to the CLOB REST API, but the wallet privkey only needs to live during `client.createOrder()`. (b) Clear `creds.private_key` from `entity.credentials` after the wallet client is constructed; only the wallet client itself needs to live on. (c) Long-term: move signing to a hardware module (Fireblocks, AWS KMS asymmetric, or a dedicated signing service). (d) Run with `--max-old-space-size` set, disable `--inspect`/`--inspect-brk` in the systemd unit (`Environment=NODE_OPTIONS=` should explicitly clear inspect flags).
- **Effort**: 2-4 h to refactor; days for hardware signing.
- **REBUILD scope**: SHOULD be improved in REBUILD. Not a blocker but it's the right architecture.

### B-P1-2: Live-mode dual-flag check is honoured at startup, but is bypassable with a single env var change + restart

- **File**: `polybot-v2/src/config/loader.ts:55-68`
- **Severity**: **P1 — operational risk, not a vulnerability per se**
- **Evidence**:
  - `loader.ts:56-58`: `const liveModeEnv = process.env.POLYBOT_LIVE_MODE === 'true'; const liveConfirmEnv = process.env.POLYBOT_LIVE_CONFIRM === 'true'; const liveEnabled = liveModeEnv && liveConfirmEnv;`
  - `loader.ts:60-67`: if NOT both flags, force every entity to `paper` mode
  - This check runs **once at startup**. There is no runtime enforcement: once the engine is up with `liveEnabled=true`, every order goes through `routeOrder` and then `submitToClob` based on `order.is_paper` (`clob-router.ts:32-36`) which is set per-order from the entity's mode. There's no second guard.
- **Root cause**: The dual-flag pattern is meant to make accidental live trading hard, but it's not a tamper-resistant control. Flipping `POLYBOT_LIVE_CONFIRM=true` in `/opt/polybot-v2/.env` and `systemctl restart polybot-v2` is the only thing standing between paper and live. Anyone with VPS SSH access can do this.
- **Impact**: An attacker who has gained SSH (per B-P0-2) can flip an entity to live mode and place real orders, even if they don't have the wallet key in their possession — because the engine already loaded it into memory.
- **Recommended fix**: (a) Add a hardware confirmation step — require typing a one-time code from a YubiKey, an SMS, or a separate `polybot-confirm-live` daemon that requires explicit human ACK before each trading session. (b) Add a runtime canary: a separate process that monitors `routeOrder` calls and alerts/halts if `is_paper=false` orders appear when not expected. (c) Add a daily live-mode-acknowledgement that has to be re-done each morning; if not done, force paper mode. (d) Move live-trading authorization to a hardware signing module (per B-P1-1) so flipping the env var alone doesn't grant signing capability.
- **REBUILD scope**: SHOULD redesign in REBUILD. The status.md mentions REBUILD MODE so this is the right time to harden the live-trading gate.
- **Skills cited**: `obra-defense-in-depth`, `mcs-implementing-zero-trust-in-cloud`, `polymarket-trading-expert`.

### B-P1-3: Workspace contains 30+ duplicate copies of credentials in archive, simulator, and root paths

- **Files** (sample): `Polymarket/scripts/simulator/state/api_keys.json`, `Polymarket/deploy/setup_vps.sh`, plus references in `scripts/check_live.py`, `scripts/wire_live_execution.py`, `scripts/auto_fund.py`, `dashboard/dashboard.py`, `scripts/grinder.py`, `auto_redeem.py`, `sprint_trader.py`, `redeem/auto_redeem.py`, `scripts/RUN_TRADES.py`, `scripts/local_sprint_trader.py`, `scripts/simulator/live_trader.py`, `scripts/simulator/auto_trader.py`, and 15+ more (29 files total contain `POLY_PRIVATE_KEY` or `GITHUB_TOKEN` substrings)
- **Severity**: **P1 — exposure surface widening**
- **Evidence**: `Grep POLY_PRIVATE_KEY|GITHUB_TOKEN|github_pat_` returned 29 files. Many are Python scripts that **reference** `keys["POLY_PRIVATE_KEY"]` (i.e. they read the JSON, they don't contain the secret themselves) — those are fine. But the pattern is that secrets-by-reference and secrets-in-source coexist and a future contributor cannot trivially distinguish.
- **Recommended fix**: After wallet rotation per B-P0-1, audit each of the 29 files. Anything that references the old creds path needs to be updated to read from the new secret store. Anything that contains a literal credential needs to be deleted. Establish a single canonical secrets path documented in `docs/SECURITY.md`.
- **REBUILD scope**: MUST be cleaned in REBUILD. The simulator scripts should not exist in the rebuilt tree at all; they belong in `Polymarket/Archive/`.

### B-P1-4: VPS service runs as root with no user isolation

- **File**: `polybot-v2/systemd/polybot-v2.service:8` (`User=root`) and `polybot-v2-rd.service:8` (`User=root`)
- **Severity**: **P1 — blast-radius amplifier**
- **Evidence**:
  - Both services: `User=root`
  - `polybot-v2.service:21-22`: `NoNewPrivileges=true`, `PrivateTmp=true` — present, good
  - **Missing**: `ProtectSystem=strict`, `ProtectHome=true`, `ReadWritePaths=/opt/polybot-v2/data`, `CapabilityBoundingSet=`, `SystemCallFilter=@system-service`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, `LockPersonality=true`, `MemoryDenyWriteExecute=true`, `RestrictNamespaces=true`, `ProtectKernelTunables=true`, `ProtectKernelModules=true`, `ProtectControlGroups=true`
- **Root cause**: Convenience — running as root means no permissions setup needed.
- **Impact**: Any RCE in node, in a dependency, or in the dashboard (e.g. via XSS pivoting to a fetch-with-credentials) lands as root. Combined with B-P0-4 (forge a session cookie → hit a future endpoint that has a vulnerability → get RCE → instant root → wallet drain), the chain is much shorter than it should be.
- **Recommended fix**: Create a `polybot` system user (`useradd -r -s /usr/sbin/nologin polybot`), set `User=polybot` in both unit files, chown `/opt/polybot-v2` and `/opt/polybot-v2-rd` to it, add the systemd hardening directives above, restart. Verify the engine still runs.
- **REBUILD scope**: MUST be implemented in REBUILD per CLAUDE.md operational discipline.
- **Skills cited**: `mcs-implementing-zero-trust-in-cloud`, `ar-incident-response`.

---

## P2 Findings

### B-P2-1: Dashboard CORS is wildcard `Access-Control-Allow-Origin: *`

- **File**: `polybot-v2/src/dashboard/sse-server.ts:80`
- **Severity**: **P2 — increases attack surface for CSRF/cross-origin abuse**
- **Evidence**: `res.setHeader('Access-Control-Allow-Origin', '*');` — applied to **every** response including authenticated API endpoints.
- **Why it's not P1**: Cookies are `SameSite=Lax`, so a cross-origin browser cannot send the session cookie automatically on most requests. The wildcard CORS does NOT mean cookies cross origins. But it does mean that any third-party page can read public responses (e.g. SSE events served before auth is enforced — verify), and once an attacker has any session leak (which they can compute via B-P0-4) they can hit the endpoints from any origin.
- **Recommended fix**: Restrict CORS to known origins (the dashboard's own host). Remove the wildcard.
- **REBUILD scope**: SHOULD be tightened in REBUILD.

### B-P2-2: SSH login as root permitted; no fail2ban; no kernel hardening; no auto-updates configured by deploy script

- **File**: `Polymarket/deploy/setup_vps.sh:1-200` (paper review only; no VPS commands)
- **Severity**: **P2 — VPS hygiene**
- **Evidence** (what `setup_vps.sh` DOES):
  - apt update + install python3, ufw, curl, jq, git
  - `ufw default deny incoming`, `ufw default allow outgoing`, `ufw allow 22/tcp`, `ufw enable` — firewall present and reasonable
  - geoblock check via Polymarket API
  - writes `api_keys.json` (B-P0-3)
  - writes `sprint_trader.py` directly into `/opt/armorstack/polymarket/`
- **Evidence** (what `setup_vps.sh` does NOT do):
  - No `apt install fail2ban` or `unattended-upgrades`
  - No `sshd_config` hardening (root login, password auth, port change)
  - No kernel hardening (`sysctl` for TCP SYN cookies, ASLR, kernel.unprivileged_userns_clone)
  - No `auditd` or audit logging setup
  - No monitoring or alerting
  - No log shipping
  - No swap or fail-stop on disk full
  - No NTP/chrony explicit install (matters for HMAC TTLs)
- **The deploy script in `polybot-v2/scripts/deploy-vps.sh` ALSO does not do any of these.** It only runs `npm install` and `systemctl enable`.
- **Root cause**: VPS provisioning was done in two passes (`Polymarket/deploy/setup_vps.sh` for the base box, `polybot-v2/scripts/deploy-vps.sh` for the V2 engine), and neither pass is a hardening pass.
- **Recommended fix**: Add a `harden_vps.sh` step: `apt install fail2ban unattended-upgrades chrony auditd`, configure `/etc/ssh/sshd_config` (`PermitRootLogin no`, `PasswordAuthentication no`, `Port` to a non-default), enable `sysctl` hardening, set up `unattended-upgrades` for security patches, consider `lynis` for ongoing audit. Wire up `journald` log shipping (Vector, Promtail, Datadog Agent).
- **REBUILD scope**: MUST be added in REBUILD. Cite `mcs-implementing-zero-trust-in-cloud`.
- **Skills cited**: `mcs-implementing-zero-trust-in-cloud`, `mcs-auditing-cloud-with-cis-benchmarks`, `infrastructure-ops`.

### B-P2-3: `serveLogin` accumulates CSRF tokens in `this.sessions` Map without cleanup

- **File**: `polybot-v2/src/dashboard/sse-server.ts:144-154`
- **Severity**: **P2 — slow memory leak / DoS amplifier**
- **Evidence**: Each GET `/login` creates a new `csrf_${csrf}` entry in `this.sessions` and sets a cookie. Successful POST `/login` deletes the CSRF entry (line 170). But **abandoned** logins (user navigates away, scrapers, scanners, brute-forcers bypassing the form) leave entries forever. There's no TTL sweeper.
- **Impact**: A trivially scriptable DoS — `for i in $(seq 1 100000); do curl http://vps:9100/login; done` allocates 100k Map entries with no GC. Memory grows unbounded until the process is killed by `MemoryMax=1G` (per `polybot-v2.service:26`).
- **Recommended fix**: Add `created` timestamp (already there at line 148) and a periodic sweeper that drops entries older than 10 min (matches the cookie `Max-Age=600`). Or use a real session store with TTL semantics.

### B-P2-4: Login HTML interpolates the `error` string without escaping

- **File**: `polybot-v2/src/dashboard/sse-server.ts:516-540`
- **Severity**: **P2 — reflected XSS via the error message**
- **Evidence**: `const errorHtml = error ? \`<div class="error">${error}</div>\` : '';` — the `error` parameter is hardcoded in the call sites (`'Session expired. Please try again.'`, `'Too many attempts. Try again later.'`, `'Invalid credentials'`) so today there is no user-controllable input here. **But** the function signature accepts a `string`, and a future contributor might pass `req`-derived data (e.g. echoing the username back). At that point the XSS is real. Risk is "future-proofing" not "active".
- **Recommended fix**: Use a tiny HTML-escape helper for any interpolated string. Or just hardcode the error messages and accept a `code` param instead.

### B-P2-5: Entity HTML page interpolates `slug` directly into the document

- **File**: `polybot-v2/src/dashboard/sse-server.ts:336, 394` (`${slug}` in `<title>` and `const SLUG = '${slug}'`)
- **Severity**: **P2 — XSS risk mitigated by the URL router but not defence-in-depth**
- **Evidence**: The slug parameter comes from `entityPageMatch[1]` where the route regex is `^/entity/([\w][\w-]*)$` (`sse-server.ts:126`). `\w` is `[A-Za-z0-9_]`, so `<`, `>`, `'`, `"`, `;`, `/` are all blocked. **As written, this is safe.** But: (a) anyone editing the regex later will break the assumption, (b) the JS context interpolation `const SLUG = '${slug}'` would still be vulnerable to escape-string injection if the regex were widened to allow `'` or `\`, and (c) the title context would eat any allowed Unicode trickery. Defence-in-depth would explicitly escape.
- **Recommended fix**: Add an `escapeHtml(s)` helper and use it everywhere a slug, error, or path is interpolated into HTML. Or move the entity page to a static template (`entity.html` in `/static`) loaded once and updated via fetch — there's already an `entity.html` in `/dashboard/static/`, so the inline `getEntityPageHtml` is a duplicate.

---

## P3 Findings

### B-P3-1: Dependencies are slightly behind latest stable

- **File**: `polybot-v2/package.json`
- **Severity**: **P3 — supply chain hygiene**
- **Evidence**: Each dep is pinned with `^` (caret) — accepts minor and patch updates. As of audit date the listed versions are reasonable but not bleeding-edge. Cannot run `npm audit` per audit rules; would do so as part of remediation.
- **Recommended fix**: Run `npm outdated`, `npm audit`, and `npm audit --production` in a remediation sprint. Pin to exact versions (drop the `^`) in `package.json` and use `package-lock.json` for reproducible installs. Subscribe the repo to GitHub Dependabot if/when it lands in version control.

### B-P3-2: No honeytokens / canary controls anywhere on the wallet path

- **Severity**: **P3 — missing defence layer**
- **Evidence**: Grep across the workspace for "canary", "honeytoken", "tripwire" returns nothing related to wallet or API key alerting. No alerting on unexpected wallet sweeps. No address watch.
- **Recommended fix** (per `mcs-implementing-honeytokens-for-breach-detection` and `mcs-deploying-active-directory-honeytokens` adapted for this stack):
  1. Create a **decoy api_keys.json** in `Polymarket/deploy/` named `api_keys.json.bak` containing **canary tokens from canarytokens.org** (a fake AWS access key, a fake GitHub PAT, a fake Polygon address). When anyone reads the file, you get an email/SMS within 60 s.
  2. Create a **decoy SSH key** named `armorstack_vps_key.bak` that is a real OpenSSH key but not authorized on any host. The key file itself doesn't trigger an alert, but you can configure a Canarytoken DNS-based key that pings a webhook when it's used in an SSH client banner.
  3. Add a **wallet address watch** for `0x2B46…3DB9` and `0x606A…F09E` on Polygonscan and Tenderly that emails the moment any tx leaves the wallet. (After rotation, watch the new wallet too.)
  4. Add a **dashboard canary endpoint** at `/api/admin/keys` that returns an HTTP 200 with a fake credential and logs every hit to a SIEM. Anyone who reaches it has compromised the dashboard.
  5. **Process-memory canary**: insert a known fake string in the engine process memory at startup that contains a unique tracker URL; if it ever appears in any external log/leak, you know the process was dumped.
- **Effort**: 1-2 h for canarytokens; 30 min for the wallet watch.
- **REBUILD scope**: SHOULD be added during REBUILD as a baseline.
- **Skills cited**: `mcs-implementing-honeytokens-for-breach-detection`, `mcs-implementing-deception-based-detection-with-canarytoken`, `mcs-deploying-active-directory-honeytokens`.

### B-P3-3: Log hygiene is generally good — no secret leakage observed

- **Files audited**: `polybot-v2/src/core/logger.ts`, `polybot-v2/src/entity/wallet-loader.ts`, `polybot-v2/src/execution/clob-router.ts`, `polybot-v2/src/entity/entity-manager.ts`, all `log.*` calls in `polybot-v2/src/`
- **Severity**: **P3 — recommended improvements only**
- **Findings**:
  - `wallet-loader.ts:62` logs only `{ path, hasApiKey, hasProxy }` — booleans, no secret values. **Good.**
  - `wallet-loader.ts:65` logs `{ path, err }` on parse failure — risk: if `JSON.parse` throws on a malformed file, the error message COULD include a substring of the file content. Pino's default `err` serializer (`logger.ts:16`) only extracts `name`, `message`, `stack` — and `JSON.parse`'s error message is `"Unexpected token X in JSON at position Y"`, which doesn't include the secret. **Probably safe**, but worth flagging.
  - `clob-router.ts:48-58` logs order details including `entity_slug`, `price`, `size`, `usdc` — no credentials. **Good.**
  - `clob-router.ts:207-213` logs the order being submitted with `token: tokenId.substring(0, 20) + '...'` — token IDs are public market identifiers, fine. **Good.**
  - `clob-router.ts:222-224` logs the **CLOB API response** with `JSON.stringify(response).substring(0, 200)` — risk: if Polymarket's API ever returns the API key/passphrase in an error response (some APIs do echo back the key in error envelopes), this would log it. **Mitigated by 200-char truncation but not eliminated.** Recommend explicit allowlist of fields to log instead.
  - `entity-manager.ts:62-69` logs entity registration with `hasWallet: !!credentials, hasApiKey: !!credentials?.api_key` — booleans only. **Good.**
  - `entity-manager.ts:25-28` calls `upsertEntity` with `credentials?.account_address` and `credentials?.proxy_address` — these are public chain addresses (the `0x2B46…3DB9` and `0x606A…F09E` from setup_vps.sh). They get persisted to the SQLite database. **Public data, fine.**
  - `core/logger.ts` has **no redaction logic**. Pino supports a `redact` option (`{ paths: ['*.private_key', '*.api_secret', '*.api_passphrase', '*.password'], remove: true }`); it is not configured.
- **Recommended fix**: Add `redact: { paths: ['*.private_key', '*.api_key', '*.api_secret', '*.api_passphrase', '*.password', 'credentials'], remove: true }` to the pino config in `core/logger.ts`. This is a one-line defence-in-depth improvement that costs nothing.
- **REBUILD scope**: SHOULD be added in REBUILD.

### B-P3-4: Code-level injection vectors are clean

- **Files audited**: All `polybot-v2/src/**/*.ts`
- **Findings**:
  - **No `eval()`**, no `new Function()` — clean.
  - **No `child_process`, no `execSync`, no `spawn`** in the Node.js code — clean.
  - **The only `db.exec(...)` calls** are at `storage/schema.ts:419, 429, 439, 443` and they execute static DDL strings — not SQL injection. The `${table}` interpolation at line 429 uses a hardcoded list, not user input. **Clean.**
  - **`JSON.parse` on untrusted input**: at `wallet-loader.ts:39` (parses an entity-owned api_keys.json — local trusted file), at `dashboard/sse-server.ts:477-496` (parses SSE events that the SAME server emits — trusted), at `risk/resolution-checker.ts:208-210` (parses Polymarket Gamma API JSON fields — semi-trusted external input but only used for market resolution numbers, not for code execution), at `market/orderbook-ws.ts:103` (parses Polymarket WS messages — same), at `strategy/strategy-context.ts:69` (parses local DB-stored metadata — trusted). **All bounded.**
  - **`fetch()` calls**: all to hardcoded Polymarket and weather/crypto data sources (`data-feeds.ts`, `data-api-client.ts`, `crypto-price.ts`, `weather-forecast.ts`, `sampling-poller.ts`, `resolution-checker.ts`). **No SSRF risk** — no user-controllable URL paths. The `clob_base_url` and `data_api_base_url` come from config (`schema.ts:46-48`) which is YAML-loaded from a trusted local file.
  - **Path traversal**: `wallet-loader.ts:30-31` joins `entityPath` with literal strings — `entityPath` comes from the YAML entity config (`entities.yaml`), trusted. No user input.
  - **Body size limit on dashboard POST**: `sse-server.ts:253` enforces 10 KB max body — good defence against oversized POST DoS.
- **Severity**: **P3 — confirmation only, no action needed.**

---

## Secret inventory (NEVER print values)

| Type                     | File                                                   | Line     | Status                                                       |
|--------------------------|--------------------------------------------------------|----------|--------------------------------------------------------------|
| SSH private key          | `Polymarket/deploy/armorstack_vps_key`                 | n/a      | EXPOSED in OneDrive — value redacted (file not opened)       |
| SSH public key           | `Polymarket/deploy/armorstack_vps_key.pub`             | n/a      | Public key — safe by definition                              |
| Ethereum private key     | `Polymarket/deploy/setup_vps.sh`                       | 76       | EXPOSED — type: ethereum_private_key — value redacted        |
| Polymarket CLOB API key  | `Polymarket/deploy/setup_vps.sh`                       | 77       | EXPOSED — type: polymarket_clob_api_key — value redacted     |
| Polymarket CLOB secret   | `Polymarket/deploy/setup_vps.sh`                       | 78       | EXPOSED — type: polymarket_clob_secret — value redacted      |
| Polymarket passphrase    | `Polymarket/deploy/setup_vps.sh`                       | 79       | EXPOSED — type: polymarket_clob_passphrase — value redacted  |
| GitHub PAT               | `Polymarket/deploy/setup_vps.sh`                       | 74       | EXPOSED — type: github_pat — value redacted                  |
| Wallet address (account) | `Polymarket/deploy/setup_vps.sh`                       | 80       | Public on-chain identifier — `0x2B46…3DB9` (last 4 redacted) |
| Wallet address (proxy)   | `Polymarket/deploy/setup_vps.sh`                       | 81       | Public on-chain identifier — `0x606A…F09E` (last 4 redacted) |
| Dashboard password (R&D) | `polybot-v2/systemd/polybot-v2-rd.service`             | 20       | EXPOSED — type: dashboard_credential — value redacted        |
| Dashboard username (R&D) | `polybot-v2/systemd/polybot-v2-rd.service`             | 19       | PII — value: `dboehm@thinkcaspian.com` (already in CLAUDE.md)|
| api_keys.json (live)     | `Polymarket/scripts/simulator/state/api_keys.json`     | n/a      | EXPOSED — file contents not read; size 690 bytes; type: composite_credential_json — value redacted |
| api_keys.json (template) | `Polymarket/scripts/simulator/state/api_keys.json.template` | n/a | Safe — template file, no real values (130 bytes, schema only) |
| Other Python script refs | 27 files referencing `POLY_PRIVATE_KEY` / `GITHUB_TOKEN` substrings | various | NOT secrets themselves — they read from `state/api_keys.json`. Safe. |
| `.env` files (real)      | (none)                                                 | n/a      | None present in workspace tree — only `.env.example`         |
| `.env.example`           | `polybot-v2/.env.example`                              | 5-21     | Safe — placeholder values only                               |

---

## Supply chain assessment

`polybot-v2/package.json` runtime dependencies:

| Package                    | Version constraint | Notes                                                                                                                  |
|----------------------------|--------------------|------------------------------------------------------------------------------------------------------------------------|
| `@polymarket/clob-client`  | `^5.8.1`           | Official Polymarket CLOB SDK. Trusted upstream. Verify provenance via `npm view @polymarket/clob-client`.              |
| `better-sqlite3`           | `^11.7.0`          | Well-known native SQLite binding. Maintained by `WiseLibs`. Pinned-to-major is fine.                                    |
| `chokidar`                 | `^4.0.0`           | File-watcher used by config hot-reload. Mainstream, trusted.                                                            |
| `commander`                | `^13.1.0`          | TJ Holowaychuk CLI parser. Mainstream.                                                                                  |
| `dotenv`                   | `^17.0.0`          | Mainstream env loader. v17 is recent — verify it's not a typosquat (`dotenv-safe`, `dotenv-cli`, etc are real adjacent pkgs). Genuine `dotenv` is by Motdotla. |
| `js-yaml`                  | `^4.1.0`           | Mainstream YAML parser. Note: `js-yaml` v4+ uses `safe load` by default (no `!!js/function` tags). Good.                |
| `nanoid`                   | `^5.1.0`           | Mainstream ID generator. v5 is ESM-only. Watch for `nano-id`, `nanoid-good` typosquats.                                 |
| `pino`                     | `^9.6.0`           | Mainstream structured logger. Trusted.                                                                                  |
| `pino-pretty`              | `^13.0.0`          | Companion to pino. Should NOT be in production dependencies — it's a dev-only formatter. Move to `devDependencies`. **MINOR**. |
| `viem`                     | `^2.46.0`          | Mainstream Ethereum client by paradigm. Trusted. Regularly audited.                                                    |
| `ws`                       | `^8.18.0`          | Mainstream WebSocket library. Periodic CVE history but actively maintained.                                            |
| `zod`                      | `^3.24.0`          | Mainstream schema validator by colinhacks. Trusted.                                                                    |

Dev dependencies:

| Package                    | Version constraint | Notes                                                                              |
|----------------------------|--------------------|------------------------------------------------------------------------------------|
| `@biomejs/biome`           | `^2.4.0`           | Mainstream linter/formatter. Trusted.                                              |
| `@types/*`                 | various            | Type declarations only. Safe.                                                      |
| `tsx`                      | `^4.19.0`          | Type-aware ts execution. Mainstream.                                               |
| `typescript`               | `^5.7.0`           | Mainstream.                                                                        |
| `vitest`                   | `^3.0.0`           | Mainstream test runner.                                                            |

**Findings**:
- **No obvious typosquats.** All package names match legitimate, well-known projects.
- **No deprecated packages** in the dependency list.
- **No packages that import crypto/filesystem unexpectedly.** None of the listed deps are from unknown maintainers.
- **`pino-pretty` is in `dependencies`** but should be in `devDependencies` (it's only loaded when `NODE_ENV !== 'production'` per `core/logger.ts:11`). Minor; move it.
- **No `package-lock.json` reviewed** (would need to verify it exists; if missing, pinning is not enforced and `npm install` could pull different transitive versions on each run).
- **Cannot run `npm audit` per audit rules.** What I would run if I could:
  - `npm audit --production` — list known CVEs in runtime deps
  - `npm audit --json | jq '.metadata'` — get severity counts
  - `npm ls @polymarket/clob-client` — verify resolved version chain
  - `npm view @polymarket/clob-client maintainers` — verify upstream is the official Polymarket org
  - `npx better-npm-audit audit` — third-party audit tool with allow-listing
  - `npx socket-security` or `npx snyk test` — supply-chain risk scoring for each dep
- **Skills to invoke for proper supply chain audit**: `mcs-analyzing-sbom-for-supply-chain-vulnerabilities`, `mcs-detecting-supply-chain-attacks-in-ci-cd`, `mcs-hunting-for-supply-chain-compromise`, `ar-dependency-auditor`.
- **Recommendation**: Generate an SBOM via `cyclonedx-npm` after wallet rotation, run `npm audit` and `socket-security`, and pin transitive dependencies via `package-lock.json` (commit it).

---

## VPS hardening posture (paper review)

### What `Polymarket/deploy/setup_vps.sh` sets up

| Control                       | Status                                                                          |
|-------------------------------|---------------------------------------------------------------------------------|
| Base packages                 | ✅ python3, ufw, curl, jq, git installed                                        |
| Firewall (ufw)                | ✅ default deny incoming, default allow outgoing, allow 22/tcp, enabled         |
| Application directory         | ✅ `/opt/armorstack/polymarket/{state,logs,dashboard}` created                  |
| Python venv                   | ✅ created at `/opt/armorstack/venv` for v1 simulator                           |
| Geoblock check                | ✅ verifies the VPS region can reach Polymarket CLOB                            |
| Credentials                   | ⚠ writes hardcoded api_keys.json (B-P0-1)                                       |

### What `polybot-v2/scripts/deploy-vps.sh` sets up

| Control                       | Status                                                                          |
|-------------------------------|---------------------------------------------------------------------------------|
| Build artifacts upload        | ✅ via scp                                                                      |
| Node 22 install               | ✅ via NodeSource                                                               |
| `npm install --omit=dev`      | ✅ production-only deps                                                         |
| `.env` template copy          | ✅ if absent                                                                    |
| systemd unit install          | ✅ copies and enables `polybot-v2.service`                                      |

### What is MISSING from the deploy posture

| Control                       | Status                                                                          |
|-------------------------------|---------------------------------------------------------------------------------|
| SSH hardening                 | ❌ no `sshd_config` changes; root SSH login still permitted; password auth not disabled in script (likely default-disabled but not enforced) |
| Non-root service user         | ❌ both systemd units run as `User=root`                                        |
| `fail2ban`                    | ❌ not installed                                                                |
| `unattended-upgrades`         | ❌ no automatic security patching                                               |
| `auditd`                      | ❌ no audit logging                                                             |
| Kernel hardening              | ❌ no `sysctl` tuning, no `lockdown`, no AppArmor/SELinux profiles              |
| systemd hardening             | ⚠ `NoNewPrivileges` and `PrivateTmp` set; missing `ProtectSystem`, `ProtectHome`, `CapabilityBoundingSet`, `SystemCallFilter`, `LockPersonality`, `MemoryDenyWriteExecute`, `RestrictNamespaces` |
| Log shipping                  | ❌ logs only in journald, no remote shipping                                    |
| Monitoring / alerting         | ❌ no Prometheus, no health checks, no alerts                                   |
| NTP / time sync               | ❌ not explicitly installed (matters for HMAC TTL accuracy and tx ordering)     |
| Backup / restore              | ❌ no SQLite backup script in deploy                                            |
| Secrets manager               | ❌ env vars in plaintext systemd unit and .env file                             |
| Network segmentation          | ❌ ufw only, no internal segmentation between prod and R&D engines              |
| Wallet HSM / signing module   | ❌ private key in process memory                                                |

### What to add (skill: `mcs-implementing-zero-trust-in-cloud`, `mcs-auditing-cloud-with-cis-benchmarks`)

A `harden_vps.sh` should be added to REBUILD that:
1. Creates a `polybot` system user
2. Configures `/etc/ssh/sshd_config`: `PermitRootLogin no`, `PasswordAuthentication no`, `Port 22122` (non-default)
3. Installs and configures `fail2ban` with sshd jail
4. Installs `unattended-upgrades` for security-only updates
5. Installs `chrony` for NTP
6. Installs `auditd` with rules for `/opt/polybot-v2/.env`, `/etc/ssh/sshd_config`, and the systemd units
7. Applies CIS Ubuntu 24.04 Level 1 sysctl hardening
8. Adds the systemd hardening directives to both unit files
9. Sets up daily SQLite backups via `sqlite3 .backup` to a separate disk or remote
10. Sets up log shipping to a SIEM (Vector → Datadog or Loki)
11. Installs `lynis` and runs an initial audit; fixes findings
12. Configures `unattended-upgrades` reboot window
13. Sets up monitoring for the wallet address on Polygonscan

---

## Honeytoken recommendation

Per `mcs-implementing-honeytokens-for-breach-detection`, deploy these canaries during REBUILD:

1. **File-system canaries on the workstation** (not the VPS):
   - `Polymarket/deploy/api_keys.json.bak` — Canarytoken AWS keys file. Triggers email + webhook on read.
   - `Polymarket/deploy/wallet_seed.txt` — Canarytoken text file containing a fake mnemonic. Anyone reading it triggers an alert.
   - `Polymarket/deploy/armorstack_vps_key_old` — A second SSH key pair where the public key is on the VPS but tied to an `authorized_keys` `command="/usr/local/bin/honeytrap-alert.sh"` forced command. Anyone using it gets logged + alerted but no shell.

2. **VPS-side canaries**:
   - `/root/.ssh/authorized_keys.bak` — fake key with same command-forced trap
   - `/opt/polybot-v2/data/.api_keys.json` (with leading dot) — Canarytoken JSON file
   - A canary subdomain that returns a 200 with a fake API key in headers when hit; never advertised, only useful as a tripwire if anyone enumerates HTTP endpoints.

3. **Wallet canaries**:
   - **Tenderly Alerts** on `0x2B46…3DB9` and `0x606A…F09E` (the current live wallet — change after rotation): any outgoing tx triggers a webhook to a phone number.
   - **Polygonscan Watch List** with email alerts on the same addresses.
   - **A small dust position on Polymarket** that the engine would never trade — if it ever moves, you know the credentials are being used externally.

4. **Process-memory canary**:
   - At engine startup, allocate a string buffer containing `CANARY-DO-NOT-COPY-${randomUUID}-${webhookUrl}`. If that string ever appears in any external log, telemetry, or leak channel, you know the process memory was dumped. Combine with a daily check that Webhook URL hasn't been hit.

5. **Dashboard canary endpoint**:
   - Add `GET /api/admin/credentials` that returns HTTP 200 with a fake api_keys.json blob and logs every hit at warn level. Anyone who reaches it has already bypassed login (B-P0-4).

**Effort**: 2-3 hours total to set up canarytokens.org accounts, configure Tenderly, add the memory canary, and write the dashboard endpoint. No changes to live trading logic required.

---

## Out of scope

The following were noticed during the audit but not investigated in detail because they are out of scope for Track B:

- **`Polymarket/Polymarket Project Summary Info/`** and **`Polymarket/backups/`** — likely contain additional historical secrets and prior versions of `setup_vps.sh`. A full forensic sweep of these directories would extend B-P0-1 to additional files. Recommend Track B Round 2 sweep these specifically.
- **`R&D/`, `Strategy/`, `references/`** — possibly contain trading-strategy IP and historical PnL but unlikely to contain credentials. Out of P0 scope.
- **Workspace OneDrive sync settings** — verifying which files are excluded from sync vs. uploaded to cloud requires Windows-side configuration inspection, not file content review. Recommend Track A or a separate workstation hardening pass.
- **The actual VPS state** — paper review only per audit rules. A live VPS audit (running `lynis`, `auditctl -l`, `journalctl --since`, `iptables -L`, `ss -tlnp`, `cat /etc/passwd`) would surface real-world drift from the deploy script.
- **The Python v1 codebase** (`Polymarket/scripts/simulator/`, `Polymarket/auto_redeem.py`, etc.) — the audit task scoped V2 (`polybot-v2/`). The v1 code references the same credentials and will need to be cleaned up alongside the wallet rotation, but the architectural review is out of scope for this track.
- **`vps-dashboard/`, `dashboard/` (Python)** — separate dashboards in Python that exist alongside the V2 SSE server. Same auth questions apply but distinct codebase.
- **The Discord/Telegram alert wiring** referenced in `DISCORD_DEPLOYMENT_SUMMARY.md` — webhook URLs are credential-equivalent and may be similarly exposed; not audited here.
- **`scripts/check_live.py`, `scripts/wire_live_execution.py`, `scripts/auto_fund.py`, `scripts/RUN_TRADES.py`** — Python scripts that reference the same credentials. Reviewing each to ensure they read from a (post-rotation) secret manager rather than the old `state/api_keys.json` is part of the P1-3 cleanup, not this audit.
- **`SECRET = createHmac(..., DASHBOARD_PASSWORD ?? 'polybot-v2-session-key')`** — the fallback string `'polybot-v2-session-key'` would be used if `DASHBOARD_PASSWORD` is unset. That's a constant, equally forge-able. Mentioned for completeness; covered by B-P0-4.
- **TLS / HTTPS for the dashboard** — the dashboard listens HTTP-only on port 9100. There is no nginx/Caddy reverse proxy in the deploy script. All dashboard auth (including the cookie) crosses the network in plaintext. The Set-Cookie has `Secure` only when `NODE_ENV === 'production'` (`sse-server.ts:187`) — so cookies leak over HTTP regardless. This is arguably a P1 finding ("dashboard credentials transit in cleartext over the public internet") but I'm flagging it here rather than escalating because it's a deploy/posture issue more than a code issue, and B-P0-4 already lets an attacker forge cookies without sniffing.

---

*Audit complete. Findings only. No fixes applied. No secret values written to this report. SSH key file was not opened.*

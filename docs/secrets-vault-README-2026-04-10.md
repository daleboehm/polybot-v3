# Polymarket Secrets — Containment & Retrieval Pattern

**Written**: 2026-04-10
**Owner**: Dale Boehm
**Status**: Active — this is the going-forward pattern after the 2026-04-10 workstation-tree redaction pass.

---

## Context (read this first)

Prior to 2026-04-10 the Polymarket working tree held several cleartext credentials inline inside deploy scripts, a hand-rolled `api_keys.json`, a dashboard password literal in `dashboard.py`, a handful of README / docs curl examples, and three legacy sprint-trader scripts with the wallet private key embedded at the top.

Those values were never exposed publicly. They sat in a OneDrive-synced workstation folder (`C:\Users\dboehm\OneDrive - thinkcaspian.com\1-Working Files\CLAUDE\Polymarket`) that only Dale has access to. The cloud-sync footprint is a risk surface (version history, device sync, search indexing) but not a public disclosure event — these are **not** rotation-requiring incidents. Dale has explicitly declined to rotate.

What the 2026-04-10 pass did instead:

1. **Removed every cleartext secret** from files inside the Polymarket workspace tree, replacing them with environment-variable loads, `__REDACTED__` placeholders, or `<PLACEHOLDER>` markers in example docs.
2. **Pointed every redacted file at this README** so any future maintainer who opens those files knows where the real values live and how to load them.
3. **Left the canonical copies untouched on the VPS** at `/opt/armorstack/polymarket/state/api_keys.json` (chmod 600, owned by root, protected by SSH-key-only access to 178.62.225.235:2222).
4. **Defined the vault location below** so any new secrets handled on the workstation land in an encrypted, non-OneDrive-synced directory.

---

## The two tiers of secret storage

### Tier 1 — Canonical, live, authoritative: the VPS

| What | Where | Who owns |
|---|---|---|
| Polymarket wallet private key | `/opt/armorstack/polymarket/state/api_keys.json` → `POLY_PRIVATE_KEY` | root, chmod 600 |
| CLOB API key / secret / passphrase | same file, `POLY_API_KEY` / `POLY_SECRET` / `POLY_PASSPHRASE` | root, chmod 600 |
| Proxy / account addresses | same file | root, chmod 600 |
| Dashboard user + password | VPS systemd environment (`polybot-v3.service`, `polybot-v3-rd.service`) | root, chmod 600 |
| GitHub PAT (for deploy pulls) | VPS env, not in the Polymarket state file | root |
| VPS SSH key (Dale's workstation side) | `Polymarket/deploy/armorstack_vps_key` **(audit flagged — move out of OneDrive tree)** | Dale |
| Let's Encrypt certs / Nginx keys | `/etc/letsencrypt/live/` (root-owned, not in scope here) | root |

The VPS is the single source of truth. Every redacted workstation file eventually cites this location as where to go look up the real value.

### Tier 2 — Workstation working copy (encrypted, non-synced)

For moments when Dale needs the credentials on the laptop (running a one-off script, hand-placing a trade, rebuilding the state file on a new VPS), values must go into a **local-only, encrypted directory outside the OneDrive tree**:

```
C:\Users\dboehm\.armorstack-vault\
├── polymarket\
│   ├── api_keys.json          # mirrors the VPS file, 600 equivalent ACLs
│   ├── dashboard.env          # DASHBOARD_USER / DASHBOARD_PASS
│   └── vps-ssh\
│       └── armorstack_vps_key # moved out of the OneDrive tree
└── README.md                  # a local companion to this doc
```

**Why this path**: `C:\Users\dboehm\.armorstack-vault\` lives inside the Windows user profile but is **not** inside `OneDrive - thinkcaspian.com\`, so it is excluded from cloud sync, device replication, and OneDrive version history. On a laptop this is effectively TPM-backed via Windows user-profile encryption.

**Additional hardening (recommended, not yet applied)**:

1. Right-click the `.armorstack-vault` folder → Properties → Advanced → "Encrypt contents to secure data" (EFS — ties decryption to the Windows user account / TPM).
2. If Dale wants portability, replace Tier 2 with a `gpg`-encrypted `secrets.json.gpg` that requires a passphrase to open, stored anywhere — even inside OneDrive if desired, because the ciphertext is safe.
3. If Dale wants to roll further, migrate to **Bitwarden / 1Password CLI** (`bw get item polymarket-vps` / `op read op://armorstack/polymarket/api_keys`) and have scripts shell out to the vault CLI instead of reading a file. This gives MFA, audit trail, and sharing controls with zero additional infrastructure.

---

## How redacted files load secrets going forward

### Python scripts (`RUN_TRADES.py`, `local_sprint_trader.py`, `dashboard/dashboard.py`)

```python
import os, sys

POLY_PRIVATE_KEY = os.environ.get("POLY_PRIVATE_KEY")
POLY_API_KEY     = os.environ.get("POLY_API_KEY")
POLY_SECRET      = os.environ.get("POLY_SECRET")
POLY_PASSPHRASE  = os.environ.get("POLY_PASSPHRASE")
if not all([POLY_PRIVATE_KEY, POLY_API_KEY, POLY_SECRET, POLY_PASSPHRASE]):
    sys.exit("ERROR: POLY_* env vars not set. Load from vault.")
```

**To run locally**, Dale opens a terminal and sources the vault file first:

```powershell
# PowerShell
Get-Content C:\Users\dboehm\.armorstack-vault\polymarket\api_keys.json |
  ConvertFrom-Json |
  ForEach-Object {
    $_.PSObject.Properties | ForEach-Object {
      Set-Item -Path "env:$($_.Name)" -Value $_.Value
    }
  }
python3 RUN_TRADES.py
```

Or via a bash shim (Git Bash / WSL):

```bash
# Bash
export $(jq -r 'to_entries[] | "\(.key)=\(.value)"' \
  /c/Users/dboehm/.armorstack-vault/polymarket/api_keys.json | xargs)
python3 RUN_TRADES.py
```

### Shell deploy scripts (`setup_vps.sh`, `deploy_all_dashboards.sh`)

These never hold secrets anymore. They check that the canonical VPS file exists at `/opt/armorstack/polymarket/state/api_keys.json` and **exit with an error + instructions if it's missing**. The operator (Dale) is responsible for placing the real file onto the VPS before running the deploy.

### Systemd unit files (`polybot-v3.service`, `polybot-v3-rd.service`)

Unit files use `EnvironmentFile=` pointing at a VPS-only path that is **not** in the git repo:

```ini
[Service]
EnvironmentFile=/etc/polybot-v3/dashboard.env
```

`/etc/polybot-v3/dashboard.env` lives on the VPS, chmod 600, owned by root:

```
DASHBOARD_USER=dboehm@thinkcaspian.com
DASHBOARD_PASS=<actual-value>
```

The unit files in the Polymarket workspace tree contain only the `EnvironmentFile=` line — never the cleartext value.

### `scripts/simulator/state/api_keys.json`

Redacted to `__REDACTED__` placeholders with a comment pointing to the VPS canonical location. The simulator does not need live keys — it is paper-only. If a future maintainer needs real keys for a simulator test, they copy from the vault manually and **never commit the real values back**.

---

## Retrieval runbook (when Dale needs a value)

1. **Need it on the VPS?** SSH in and `cat /opt/armorstack/polymarket/state/api_keys.json`. Don't touch the workstation.
2. **Need it on the laptop?** Open `C:\Users\dboehm\.armorstack-vault\polymarket\api_keys.json`. If that file doesn't exist yet (first time on a fresh workstation), SCP it down from the VPS:
   ```bash
   scp -i C:\Users\dboehm\.armorstack-vault\polymarket\vps-ssh\armorstack_vps_key \
       -P 2222 \
       root@178.62.225.235:/opt/armorstack/polymarket/state/api_keys.json \
       C:\Users\dboehm\.armorstack-vault\polymarket\api_keys.json
   ```
   Then Windows EFS-encrypt the folder if not already encrypted.
3. **Need it in a workstation shell?** Source it into the environment (PowerShell or Bash snippet above). **Do not echo it to the terminal.** Do not paste it into a chat window, a file inside OneDrive, a Git repo, or any document that is indexed or synced.
4. **Need it in a new script?** The script reads from `os.environ.get(...)` or equivalent. It never contains the literal value.

---

## Enforcement rules (for Claude and any future maintainer)

These are binding:

1. **Never write a cleartext secret into any file inside `C:\Users\dboehm\OneDrive - thinkcaspian.com\`**. That includes the Polymarket tree, any sibling working folder, any scratchpad, any todo list, and any session markdown file.
2. **Never include a cleartext secret in a chat response, a session summary, a tool result, or an Edit/Write call**. If a secret appears in a file being audited, redact it in the quotation (`POLY_PRIVATE_KEY=<REDACTED>`) and cite the `file:line` only.
3. **Never commit `.armorstack-vault\` to any git repo**, any OneDrive folder, any cloud storage, any issue tracker.
4. **Never log a secret**. Scripts should mask on error paths (`f"key=sk-...{key[-4:]}"` at most).
5. **Never print a secret to `stdout`** during deployment or operations. If it needs to be placed on a remote, use SCP with the file already encrypted at rest on both ends.
6. **If a secret is discovered in a place it shouldn't be**, the response is: redact the file, update this README to reflect the new location / new pattern, and note it in `Polymarket/docs/lessons.md`. Do **not** unilaterally rotate without Dale's explicit authorization — he has standing instruction that rotation decisions are his alone.

---

## What was redacted on 2026-04-10

For audit trail and future reference, these 10 files were cleaned in the 2026-04-10 pass. All now load from environment variables or reference this README:

| File | What was in it | Redaction pattern |
|---|---|---|
| `Polymarket/deploy/setup_vps.sh` | Heredoc writing api_keys.json with live wallet + CLOB creds | Error-and-exit if file doesn't exist |
| `Polymarket/scripts/simulator/state/api_keys.json` | Full cleartext api_keys.json (wallet + CLOB + GitHub PAT) | `__REDACTED__` placeholders |
| `Polymarket/polybot-v3/systemd/polybot-v3-rd.service` | `DASHBOARD_PASSWORD=<REDACTED_SEE_VAULT>` | `__SET_ON_VPS__` placeholder + EnvironmentFile pattern |
| `Polymarket/deploy/deploy_all_dashboards.sh` | Dashboard password embedded in api_keys.json stub | `__SET_ON_VPS_AFTER_DEPLOY__` placeholder |
| `Polymarket/scripts/RUN_TRADES.py` | Wallet private key + CLOB creds hardcoded at top | `os.environ.get()` pattern |
| `Polymarket/scripts/local_sprint_trader.py` | Same as RUN_TRADES.py | `os.environ.get()` pattern |
| `Polymarket/dashboard/dashboard.py` | `DASH_USER` / `DASH_PASS` hardcoded literals | `os.environ.get()` pattern with fail-if-missing |
| `Polymarket/README_THREE_SYSTEMS.md` | Dashboard password in curl example | `<DASHBOARD_PASS>` placeholder |
| `Polymarket/SYSTEMS_DEPLOYED.md` | Dashboard password in curl example | `<DASHBOARD_PASS>` placeholder |
| `Polymarket/docs/RECONCILIATION_FIX_SUMMARY.md` | Dashboard password in prose | `[REDACTED — see vault README]` |

**Not touched** (these are audit-flagged but outside the redaction pass scope):

- `Polymarket/deploy/armorstack_vps_key` — the SSH private key to the VPS. Still sits in the OneDrive-synced workspace. Audit Track B flagged this as P0. Recommended action: `move` (not copy) to `C:\Users\dboehm\.armorstack-vault\polymarket\vps-ssh\` and update any script that references the old path. This move is the single highest-value hardening action remaining on the workstation side. **Awaiting Dale's go-ahead to perform the move.**

---

## Open items for Dale to decide

1. **Move `armorstack_vps_key` out of the OneDrive tree** — yes or no? If yes, Claude can execute the file move in a follow-up session (it's a local `mv`, not a VPS operation).
2. **Encrypt `C:\Users\dboehm\.armorstack-vault\` with Windows EFS** — yes or no? One checkbox in Explorer, ties decryption to the Windows user profile.
3. **Long-term: migrate to Bitwarden / 1Password CLI** — better than a flat file, gives audit trail and MFA. Deferred until Dale has bandwidth.
4. **Stop using GitHub PAT inside the api_keys.json** — the `GITHUB_TOKEN` entry in `simulator/state/api_keys.json` is a bad pattern. GitHub pulls on the VPS should use a deploy key (SSH), not a PAT. Deferred, low urgency.

---

## How to use this doc

- **If you're Claude in a future session and you see `see Polymarket/docs/secrets-vault-README-2026-04-10.md` in a file comment**, that means the value was redacted on 2026-04-10 and lives either on the VPS or in the workstation vault. Do not ask Dale for the value — look it up via the retrieval runbook above.
- **If you're Claude and you're about to write a cleartext secret into a file**, stop. Read this doc. Write the env-var load pattern instead.
- **If you're Dale**, this is your record of what changed on 2026-04-10 and where everything lives going forward. Nothing has to change on the VPS — this is purely a workstation-hygiene doc.

#!/usr/bin/env python3
"""
POLYMARKET ENTITY PROVISIONER v1.0
Fixes shared wallets and generates CLOB API keys for all 15 entities.

Deploy to VPS: scp this to /opt/polybot/ and run with:
  /opt/polybot/venv/bin/python3 /opt/polybot/provision_entities.py

What it does:
  1. Scans all entity directories under /opt/ for api_keys.json (in root or state/)
  2. Identifies entities sharing wallets (armorstack-tax, armorstack-marketing, armorstack-te)
  3. Generates new wallets for entities that need them
  4. Generates Polymarket CLOB API credentials for entities missing them
  5. Backs up everything before making changes

Requirements (already on VPS):
  - py_clob_client
  - eth_account
  - web3
"""

import json
import os
import sys
import time
import shutil
import logging
from pathlib import Path
from datetime import datetime

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler("/opt/polybot/logs/provision_entities.log"),
    ]
)
logger = logging.getLogger(__name__)

# ─── ENTITY REGISTRY ───────────────────────────────────────────────────────────
# Maps entity name → directory path, dashboard port, expected wallet
# Source: /opt/master-dashboard/entities.json
ENTITIES = {
    "polybot":              {"dir": "/opt/polybot",              "port": 8080, "label": "GC Caspian"},
    "armorstack":           {"dir": "/opt/armorstack",           "port": 8081, "label": "GC Armorstack"},
    "lilac":                {"dir": "/opt/lilac",                "port": 8082, "label": "GC Lilac"},
    "caspian-intl":         {"dir": "/opt/caspian-intl",         "port": 8083, "label": "GC Caspian Intl"},
    "armorstack-tax":       {"dir": "/opt/armorstack-tax",       "port": 8084, "label": "Armorstack Tax Reserve"},
    "armorstack-marketing": {"dir": "/opt/armorstack-marketing", "port": 8085, "label": "Armorstack Marketing"},
    "armorstack-te":        {"dir": "/opt/armorstack-te",        "port": 8086, "label": "Armorstack T&E"},
    "boehm-family":         {"dir": "/opt/boehm-family",         "port": 8087, "label": "Boehm Family Trust"},
    "nolan-fund":           {"dir": "/opt/nolan-fund",           "port": 8088, "label": "Nolan Education Fund"},
    "landon-fund":          {"dir": "/opt/landon-fund",          "port": 8089, "label": "Landon Education Fund"},
    "artisan179":           {"dir": "/opt/artisan179",           "port": 8090, "label": "Artisan 179 LLC"},
    "sage-holdings":        {"dir": "/opt/sage-holdings",        "port": 8091, "label": "Sage Holdings"},
    "midwest-ai":           {"dir": "/opt/midwest-ai",           "port": 8092, "label": "Midwest AI Fund"},
    "weather-alpha":        {"dir": "/opt/weather-alpha",        "port": 8093, "label": "Weather Alpha"},
    "delta-neutral":        {"dir": "/opt/delta-neutral",        "port": 8094, "label": "Delta Neutral"},
}

# The known active entity — GC Caspian's wallet (do NOT regenerate its keys)
CASPIAN_WALLET = "0xF8d12267165da29C80"  # prefix — will match startswith

# Polygon RPC endpoint
DEFAULT_RPC = "https://polygon-bor-rpc.publicnode.com"

# CLOB API host
CLOB_HOST = "https://clob.polymarket.com"
CHAIN_ID = 137  # Polygon mainnet


def find_api_keys_file(entity_dir: str) -> Path | None:
    """Find api_keys.json in entity dir (check state/ first, then root)."""
    state_path = Path(entity_dir) / "state" / "api_keys.json"
    root_path = Path(entity_dir) / "api_keys.json"
    if state_path.exists():
        return state_path
    if root_path.exists():
        return root_path
    return None


def load_api_keys(filepath: Path) -> dict:
    """Load and return api_keys.json contents."""
    try:
        with open(filepath) as f:
            return json.load(f)
    except (json.JSONDecodeError, Exception) as e:
        logger.error(f"Failed to load {filepath}: {e}")
        return {}


def backup_file(filepath: Path):
    """Create timestamped backup of a file."""
    if not filepath.exists():
        return
    backup = filepath.parent / f"{filepath.stem}_backup_{int(time.time())}.json"
    shutil.copy2(str(filepath), str(backup))
    logger.info(f"Backed up {filepath} → {backup.name}")


def generate_wallet() -> dict:
    """Generate a new Polygon wallet. Returns {private_key, address}."""
    from eth_account import Account
    account = Account.create()
    return {
        "private_key": account.key.hex(),
        "address": account.address,
    }


def generate_clob_api_key(private_key: str) -> dict:
    """
    Generate Polymarket CLOB API credentials using the entity's private key.
    Returns {api_key, api_secret, api_passphrase} or empty dict on failure.
    """
    try:
        from py_clob_client.client import ClobClient

        client = ClobClient(
            host=CLOB_HOST,
            chain_id=CHAIN_ID,
            key=private_key,
        )

        # Derive API credentials
        creds = client.create_api_key()

        if creds and hasattr(creds, 'api_key'):
            return {
                "api_key": creds.api_key,
                "api_secret": creds.api_secret,
                "api_passphrase": creds.api_passphrase,
            }
        elif isinstance(creds, dict):
            return {
                "api_key": creds.get("apiKey", creds.get("api_key", "")),
                "api_secret": creds.get("secret", creds.get("api_secret", "")),
                "api_passphrase": creds.get("passphrase", creds.get("api_passphrase", "")),
            }
        else:
            logger.error(f"Unexpected creds type: {type(creds)} — {creds}")
            return {}

    except Exception as e:
        logger.error(f"CLOB API key generation failed: {e}")
        return {}


def ensure_api_keys_file(entity_name: str, entity_dir: str) -> Path:
    """Ensure api_keys.json exists at the correct location. Returns path."""
    state_dir = Path(entity_dir) / "state"
    state_dir.mkdir(parents=True, exist_ok=True)
    filepath = state_dir / "api_keys.json"
    if not filepath.exists():
        # Also check root
        root_path = Path(entity_dir) / "api_keys.json"
        if root_path.exists():
            return root_path
        # Create empty
        with open(filepath, "w") as f:
            json.dump({}, f, indent=2)
        os.chmod(str(filepath), 0o600)
    return filepath


def provision_entity(entity_name: str, config: dict, dry_run: bool = False) -> dict:
    """
    Provision a single entity. Returns status dict.

    Steps:
    1. Check if entity dir exists
    2. Find/create api_keys.json
    3. Check if wallet is unique (not sharing Caspian's)
    4. Generate new wallet if needed
    5. Generate CLOB API key if missing
    """
    entity_dir = config["dir"]
    label = config["label"]
    result = {
        "entity": entity_name,
        "label": label,
        "dir_exists": False,
        "had_keys_file": False,
        "wallet_status": "unknown",
        "clob_status": "unknown",
        "actions": [],
        "errors": [],
    }

    # Check directory
    if not Path(entity_dir).exists():
        result["wallet_status"] = "no_directory"
        result["clob_status"] = "no_directory"
        result["errors"].append(f"Directory {entity_dir} does not exist — run deploy_entity.sh first")
        return result

    result["dir_exists"] = True

    # Find api_keys.json
    keys_path = find_api_keys_file(entity_dir)
    if keys_path:
        result["had_keys_file"] = True
        keys = load_api_keys(keys_path)
    else:
        keys = {}
        keys_path = ensure_api_keys_file(entity_name, entity_dir)
        result["actions"].append("Created api_keys.json")

    # ── WALLET CHECK ──
    current_private_key = keys.get("POLY_PRIVATE_KEY", "")
    current_wallet = keys.get("WALLET_ADDRESS", "")

    # Skip GC Caspian — it's the active entity, don't touch it
    if entity_name == "polybot":
        result["wallet_status"] = "active_primary"
        result["clob_status"] = "active_primary"
        result["actions"].append("Skipped — primary active entity")
        return result

    # Check if this entity is sharing Caspian's wallet
    shares_caspian = current_wallet.startswith(CASPIAN_WALLET) if current_wallet else False

    if shares_caspian or not current_private_key:
        # Needs a new wallet
        if shares_caspian:
            reason = f"shares Caspian's wallet ({current_wallet[:12]}...)"
        else:
            reason = "no private key found"

        logger.info(f"[{entity_name}] Generating new wallet — {reason}")

        if not dry_run:
            backup_file(keys_path)
            new_wallet = generate_wallet()
            keys["POLY_PRIVATE_KEY"] = new_wallet["private_key"]
            keys["WALLET_ADDRESS"] = new_wallet["address"]
            keys["POLY_RPC_URL"] = keys.get("POLY_RPC_URL", DEFAULT_RPC)
            result["actions"].append(f"Generated new wallet: {new_wallet['address']}")
            result["wallet_status"] = "new_wallet_generated"
        else:
            result["actions"].append(f"[DRY RUN] Would generate new wallet ({reason})")
            result["wallet_status"] = "needs_new_wallet"
    else:
        result["wallet_status"] = "unique_wallet_ok"
        logger.info(f"[{entity_name}] Wallet OK: {current_wallet[:12]}...")

    # ── CLOB API KEY CHECK ──
    has_clob = bool(keys.get("POLY_API_KEY"))

    if not has_clob:
        private_key = keys.get("POLY_PRIVATE_KEY", "")
        if not private_key:
            result["clob_status"] = "no_private_key"
            result["errors"].append("Cannot generate CLOB key — no private key")
        else:
            logger.info(f"[{entity_name}] Generating CLOB API key...")
            if not dry_run:
                creds = generate_clob_api_key(private_key)
                if creds and creds.get("api_key"):
                    keys["POLY_API_KEY"] = creds["api_key"]
                    keys["POLY_SECRET"] = creds["api_secret"]
                    keys["POLY_PASSPHRASE"] = creds["api_passphrase"]
                    result["clob_status"] = "generated"
                    result["actions"].append("Generated CLOB API credentials")
                else:
                    result["clob_status"] = "generation_failed"
                    result["errors"].append("CLOB API key generation failed — check logs")
            else:
                result["actions"].append("[DRY RUN] Would generate CLOB API key")
                result["clob_status"] = "needs_generation"
    else:
        result["clob_status"] = "has_clob_key"
        logger.info(f"[{entity_name}] CLOB key exists")

    # ── SAVE ──
    if not dry_run and result["actions"]:
        # Ensure RPC is set
        if "POLY_RPC_URL" not in keys:
            keys["POLY_RPC_URL"] = DEFAULT_RPC

        with open(keys_path, "w") as f:
            json.dump(keys, f, indent=2)
        os.chmod(str(keys_path), 0o600)
        logger.info(f"[{entity_name}] Saved api_keys.json")

    return result


def update_master_dashboard(results: list):
    """Update master-dashboard entities.json with new wallet addresses."""
    entities_file = Path("/opt/master-dashboard/entities.json")
    if not entities_file.exists():
        logger.warning("master-dashboard entities.json not found — skipping update")
        return

    try:
        with open(entities_file) as f:
            entities = json.load(f)

        # Build lookup from results
        wallet_map = {}
        for r in results:
            if r.get("dir_exists") and r.get("wallet_status") in ("new_wallet_generated", "unique_wallet_ok"):
                entity_dir = ENTITIES[r["entity"]]["dir"]
                keys_path = find_api_keys_file(entity_dir)
                if keys_path:
                    keys = load_api_keys(keys_path)
                    wallet_map[r["entity"]] = keys.get("WALLET_ADDRESS", "")

        # Update entities.json entries
        updated = 0
        for entity in entities:
            name = entity.get("name", "").lower().replace(" ", "-")
            # Try matching by directory
            entity_dir = entity.get("directory", "")
            entity_name = Path(entity_dir).name if entity_dir else name

            if entity_name in wallet_map and wallet_map[entity_name]:
                old_wallet = entity.get("wallet_address", "")
                new_wallet = wallet_map[entity_name]
                if old_wallet != new_wallet:
                    entity["wallet_address"] = new_wallet
                    updated += 1
                    logger.info(f"Updated {entity_name} wallet in entities.json: {new_wallet[:12]}...")

        if updated > 0:
            backup_file(entities_file)
            with open(entities_file, "w") as f:
                json.dump(entities, f, indent=2)
            logger.info(f"Updated {updated} wallet addresses in entities.json")

    except Exception as e:
        logger.error(f"Failed to update entities.json: {e}")


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Provision Polymarket trading entities")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be done without making changes")
    parser.add_argument("--entity", type=str, help="Provision a single entity by name")
    parser.add_argument("--skip-clob", action="store_true", help="Skip CLOB API key generation (wallet fixes only)")
    args = parser.parse_args()

    logger.info("=" * 70)
    logger.info("POLYMARKET ENTITY PROVISIONER v1.0")
    logger.info(f"Mode: {'DRY RUN' if args.dry_run else 'LIVE'}")
    logger.info(f"Timestamp: {datetime.now().isoformat()}")
    logger.info("=" * 70)

    # Filter entities
    if args.entity:
        if args.entity not in ENTITIES:
            logger.error(f"Unknown entity: {args.entity}")
            logger.info(f"Available: {', '.join(ENTITIES.keys())}")
            sys.exit(1)
        targets = {args.entity: ENTITIES[args.entity]}
    else:
        targets = ENTITIES

    results = []
    for name, config in targets.items():
        logger.info(f"\n{'─' * 50}")
        logger.info(f"Processing: {name} ({config['label']})")
        logger.info(f"{'─' * 50}")

        result = provision_entity(name, config, dry_run=args.dry_run)

        if args.skip_clob and result.get("clob_status") == "needs_generation":
            result["clob_status"] = "skipped"

        results.append(result)

    # Update master dashboard
    if not args.dry_run:
        update_master_dashboard(results)

    # ── SUMMARY ──
    logger.info("\n" + "=" * 70)
    logger.info("PROVISIONING SUMMARY")
    logger.info("=" * 70)

    for r in results:
        status_icon = "✓" if not r["errors"] else "✗"
        actions_str = "; ".join(r["actions"]) if r["actions"] else "no changes"
        errors_str = "; ".join(r["errors"]) if r["errors"] else ""

        logger.info(f"  {status_icon} {r['entity']:25s} wallet={r['wallet_status']:25s} clob={r['clob_status']:20s}")
        if r["actions"]:
            for a in r["actions"]:
                logger.info(f"      → {a}")
        if r["errors"]:
            for e in r["errors"]:
                logger.info(f"      ✗ {e}")

    # Save report
    report_path = Path("/opt/polybot/state/provision_report.json")
    with open(report_path, "w") as f:
        json.dump({
            "timestamp": datetime.now().isoformat(),
            "dry_run": args.dry_run,
            "results": results,
        }, f, indent=2)
    logger.info(f"\nReport saved to {report_path}")

    # Count outcomes
    new_wallets = sum(1 for r in results if r["wallet_status"] == "new_wallet_generated")
    new_clob = sum(1 for r in results if r["clob_status"] == "generated")
    errors = sum(1 for r in results if r["errors"])

    logger.info(f"\nNew wallets: {new_wallets} | New CLOB keys: {new_clob} | Errors: {errors}")

    if errors:
        sys.exit(1)


if __name__ == "__main__":
    main()

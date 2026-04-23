#!/bin/bash
# Bootstrap all 15 secondary fleet wallets: generate keys, age-encrypt, store in secrets/.
#
# PREREQUISITES:
#   - age CLI installed (age --version)
#   - /root/.config/age/polybot.key exists (the private age identity)
#   - node + viem available (already in polybot-v3 node_modules)
#
# SAFETY:
#   - plaintext wallet files are written to tmpfs (/dev/shm) and shredded after encryption
#   - .age files are written to /opt/polybot-v3/secrets/ — committed to git (encrypted)
#
# Usage:
#   bash scripts/fleet-bootstrap.sh
#
# Idempotent: if secrets/wallet-<slug>.json.age already exists, SKIPS that slug.
# Safe to re-run if a previous run failed mid-way.

set -euo pipefail

SLUGS=(
  armorstack lilac caspian-intl
  armorstack-tax armorstack-marketing armorstack-te
  boehm-family nolan-fund landon-fund
  artisan179 sage-holdings midwest-ai
  weather-alpha delta-neutral a-brown
)

AGE_PUB=$(age-keygen -y /root/.config/age/polybot.key)
SECRETS_DIR=/opt/polybot-v3/secrets
GEN_SCRIPT=/opt/polybot-v3/scripts/gen-wallet.mjs
TMP=/dev/shm/fleet-bootstrap-tmp

mkdir -p "$SECRETS_DIR" "$TMP"
chmod 700 "$TMP"

echo "Bootstrapping ${#SLUGS[@]} wallets. Age pubkey: $AGE_PUB"
echo "Secrets dir: $SECRETS_DIR"

for slug in "${SLUGS[@]}"; do
  enc="$SECRETS_DIR/wallet-${slug}.json.age"
  if [ -f "$enc" ]; then
    echo "  [skip] $slug — $enc already exists"
    continue
  fi
  plain="$TMP/wallet-${slug}.json"
  node "$GEN_SCRIPT" --slug="$slug" > "$plain"
  addr=$(node -e "console.log(require('$plain').address)")
  age -r "$AGE_PUB" -o "$enc" "$plain"
  shred -u "$plain"
  echo "  [done] $slug -> $addr (encrypted to $enc)"
done

rm -rf "$TMP"

echo ''
echo 'Next steps:'
echo '  1. git add secrets/wallet-*.json.age && git commit -m "secrets(fleet): 15 wallet age-encrypted keypairs" && git push'
echo '  2. Fund each wallet address with USDC (start with one at a time — see docs/fleet-activation.md)'
echo '  3. When Wallet #1 >= $1K, flip FLEET_ACTIVE=true + activate entities one at a time'

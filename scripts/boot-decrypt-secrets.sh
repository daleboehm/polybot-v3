#!/bin/bash
# Decrypt polybot secrets from age-encrypted files into tmpfs at boot.
# Runs via polybot-secrets.service before any polybot-v3 services start.
#
# Migrated 2026-04-10 from /opt/polybot/boot_decrypt_secrets.sh as part of the
# v1 deletion cleanup. The age identity key lives at /root/.config/age/polybot.key
# (not in the polybot-v3 tree — chmod 600 root-only).

set -e

AGE_KEY=/root/.config/age/polybot.key
SECRETS_DIR=/dev/shm/polybot-secrets
V3_SECRETS_DIR=/opt/polybot-v3/secrets

# Create tmpfs secrets directory
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"
chown polybot:polybot "$SECRETS_DIR" 2>/dev/null || chown root:root "$SECRETS_DIR"

# Decrypt api_keys.json
age -d -i "$AGE_KEY" -o "$SECRETS_DIR/api_keys.json" "$V3_SECRETS_DIR/api_keys.json.age"
chmod 600 "$SECRETS_DIR/api_keys.json"
chown polybot:polybot "$SECRETS_DIR/api_keys.json" 2>/dev/null || chown root:root "$SECRETS_DIR/api_keys.json"

# Decrypt wallet.json
age -d -i "$AGE_KEY" -o "$SECRETS_DIR/wallet.json" "$V3_SECRETS_DIR/wallet.json.age"
chmod 600 "$SECRETS_DIR/wallet.json"
chown polybot:polybot "$SECRETS_DIR/wallet.json" 2>/dev/null || chown root:root "$SECRETS_DIR/wallet.json"

# Ensure the /opt/polybot-v3/state symlinks still resolve (they point here)
# This is a belt-and-suspenders check — the symlinks already exist but
# if someone deletes them accidentally, recreate them.
mkdir -p /opt/polybot-v3/state
[ -L /opt/polybot-v3/state/api_keys.json ] || ln -sf "$SECRETS_DIR/api_keys.json" /opt/polybot-v3/state/api_keys.json
[ -L /opt/polybot-v3/state/wallet.json ] || ln -sf "$SECRETS_DIR/wallet.json" /opt/polybot-v3/state/wallet.json

echo "Secrets decrypted to $SECRETS_DIR at $(date)"

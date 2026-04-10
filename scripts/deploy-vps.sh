#!/bin/bash
# Deploy Polybot V3 to VPS (side-by-side with v1)
# Usage: ./scripts/deploy-vps.sh

set -euo pipefail

VPS_HOST="178.62.225.235"
VPS_PORT="2222"
VPS_USER="root"
VPS_KEY="../deploy/armorstack_vps_key"
REMOTE_DIR="/opt/polybot-v3"

echo "=== Polybot V3 Deployment ==="
echo "Target: ${VPS_USER}@${VPS_HOST}:${VPS_PORT}"
echo ""

# Build locally
echo "[1/6] Building TypeScript..."
npm run build

# Create remote directory structure
echo "[2/6] Creating remote directories..."
ssh -p ${VPS_PORT} -i ${VPS_KEY} ${VPS_USER}@${VPS_HOST} "
  mkdir -p ${REMOTE_DIR}/{dist,config,data,systemd}
"

# Upload built files
echo "[3/6] Uploading files..."
scp -P ${VPS_PORT} -i ${VPS_KEY} -r \
  dist/ \
  package.json \
  config/ \
  systemd/ \
  .env.example \
  ${VPS_USER}@${VPS_HOST}:${REMOTE_DIR}/

# Install dependencies on VPS
echo "[4/6] Installing dependencies..."
ssh -p ${VPS_PORT} -i ${VPS_KEY} ${VPS_USER}@${VPS_HOST} "
  cd ${REMOTE_DIR}
  # Ensure Node 22+ is available
  node --version || (curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs)
  npm install --omit=dev
"

# Setup env if not exists
echo "[5/6] Checking .env..."
ssh -p ${VPS_PORT} -i ${VPS_KEY} ${VPS_USER}@${VPS_HOST} "
  if [ ! -f ${REMOTE_DIR}/.env ]; then
    cp ${REMOTE_DIR}/.env.example ${REMOTE_DIR}/.env
    echo 'Created .env from template — EDIT IT before starting!'
  fi
"

# Install and start systemd service
echo "[6/6] Setting up systemd service..."
ssh -p ${VPS_PORT} -i ${VPS_KEY} ${VPS_USER}@${VPS_HOST} "
  cp ${REMOTE_DIR}/systemd/polybot-v3.service /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable polybot-v3
  echo 'Service installed. Start with: systemctl start polybot-v3'
  echo 'Logs: journalctl -u polybot-v3 -f'
"

echo ""
echo "=== Deployment Complete ==="
echo ""
echo "Next steps:"
echo "  1. SSH in: ssh -p ${VPS_PORT} -i ${VPS_KEY} ${VPS_USER}@${VPS_HOST}"
echo "  2. Edit .env: nano ${REMOTE_DIR}/.env"
echo "  3. Initialize DB: cd ${REMOTE_DIR} && node dist/cli/index.js migrate --init"
echo "  4. Import v1: node dist/cli/index.js migrate --v1"
echo "  5. Check status: node dist/cli/index.js status"
echo "  6. Start engine: systemctl start polybot-v3"
echo "  7. Dashboard: http://${VPS_HOST}:9100"

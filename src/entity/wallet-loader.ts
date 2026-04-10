// Reads wallet credentials from entity directories (read-only access to v1 paths)

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WalletCredentials } from '../types/index.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('wallet-loader');

interface V1ApiKeys {
  POLY_PRIVATE_KEY?: string;
  POLY_API_KEY?: string;
  POLY_SECRET?: string;
  POLY_PASSPHRASE?: string;
  POLY_ACCOUNT_ADDRESS?: string;
  POLY_PROXY_ADDRESS?: string;
  POLY_WALLET_ADDRESS?: string;
  WALLET_ADDRESS?: string;
  // Alternative key names from some entities
  private_key?: string;
  public_key?: string;
  api_key?: string;
  api_secret?: string;
  api_passphrase?: string;
}

export function loadWalletCredentials(entityPath: string): WalletCredentials | null {
  // Try multiple known locations
  const candidates = [
    join(entityPath, 'state', 'api_keys.json'),
    join(entityPath, 'api_keys.json'),
  ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;

    try {
      const raw = readFileSync(path, 'utf-8');
      const keys: V1ApiKeys = JSON.parse(raw);

      const privateKey = keys.POLY_PRIVATE_KEY ?? keys.private_key;
      const apiKey = keys.POLY_API_KEY ?? keys.api_key;
      const apiSecret = keys.POLY_SECRET ?? keys.api_secret;
      const apiPassphrase = keys.POLY_PASSPHRASE ?? keys.api_passphrase;
      const accountAddress = keys.POLY_ACCOUNT_ADDRESS ?? keys.POLY_WALLET_ADDRESS ?? keys.WALLET_ADDRESS;
      const proxyAddress = keys.POLY_PROXY_ADDRESS;

      if (!privateKey) {
        log.warn({ path }, 'api_keys.json found but missing private key');
        return null;
      }

      const creds: WalletCredentials = {
        private_key: privateKey,
        api_key: apiKey ?? '',
        api_secret: apiSecret ?? '',
        api_passphrase: apiPassphrase ?? '',
        account_address: accountAddress ?? '',
        proxy_address: proxyAddress ?? '',
      };

      log.info({ path, hasApiKey: !!apiKey, hasProxy: !!proxyAddress }, 'Wallet credentials loaded');
      return creds;
    } catch (err) {
      log.error({ path, err }, 'Failed to parse api_keys.json');
    }
  }

  log.warn({ entityPath }, 'No wallet credentials found');
  return null;
}

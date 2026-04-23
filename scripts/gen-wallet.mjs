#!/usr/bin/env node
// Generate a fresh Polygon-compatible wallet (secp256k1 keypair + Ethereum-format address).
// Writes JSON to stdout in the shape expected by the engine:
//   { address: '0x...', private_key: '0x...' }
//
// Usage:
//   node scripts/gen-wallet.mjs [--slug=armorstack]
//
// The --slug flag is optional metadata; the engine reads address + private_key only.
// Stdout can be piped directly into an age encryption command.

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

const wallet = {
  address: account.address,
  private_key: privateKey,
  ...(args.slug ? { slug: args.slug, generated_at: new Date().toISOString() } : {}),
};

console.log(JSON.stringify(wallet, null, 2));

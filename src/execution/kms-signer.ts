// AWS KMS signer — R4 scaffold.
//
// R4 (2026-04-10). Per design-decisions §O: production wallet signing moves
// from in-process private key to AWS KMS with `ECC_SECG_P256K1` key spec so
// the private key never enters Node.js heap. CloudTrail logs every Sign
// call for audit trail.
//
// This scaffold provides the KMS signer interface that matches viem's
// CustomAccount shape. It's dependency-injected into NegRiskRedeemer and
// the future CLOB signer path so either can use local private keys OR
// KMS with no code change elsewhere.
//
// **INACTIVE** until `KMS_KEY_ARN` is set in the environment. Without it,
// the signer constructor throws and callers should fall back to in-process
// private key (existing path).
//
// Dependencies NOT yet added to package.json:
//   - @aws-sdk/client-kms — ~500kb, pulled only when KMS_KEY_ARN is set
// Install when R4 is actually deployed: `npm i @aws-sdk/client-kms`
//
// This file is a SCAFFOLD — it documents the interface and skeleton but
// the real implementation lives behind a dynamic import that's only executed
// at R4 cutover time.

import { keccak256, serializeTransaction, type Hex, type TransactionSerializable } from 'viem';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('kms-signer');

export interface KmsSignerConfig {
  keyArn: string;            // e.g. "arn:aws:kms:eu-west-1:123456:key/abc-def"
  region: string;            // e.g. "eu-west-1" (Frankfurt or Ireland for Amsterdam VPS latency)
  publicKey: Hex;            // cached secp256k1 uncompressed pubkey (fetched once at init)
  address: Hex;              // derived Polygon address
}

export interface SignerInterface {
  address: Hex;
  signTransaction(tx: TransactionSerializable): Promise<Hex>;
  signMessage(message: string | Hex): Promise<Hex>;
}

/**
 * Initialize a KMS signer. Returns null if `KMS_KEY_ARN` is not set in the
 * environment, so callers can fall back to the in-process signer path.
 *
 * At R4 deployment time, the operator:
 *   1. Creates an asymmetric key in AWS KMS: `aws kms create-key --key-usage SIGN_VERIFY --key-spec ECC_SECG_P256K1`
 *   2. Assigns an IAM role to the Amsterdam VPS with `kms:Sign` ONLY on that key ARN
 *   3. Transfers USDC from the old in-process-key wallet to the new KMS-derived wallet
 *   4. Sets `KMS_KEY_ARN` and `KMS_REGION` in the VPS environment
 *   5. Restarts the engine — the signer picks up the env vars and uses KMS
 *   6. Deletes the old private key from `api_keys.json`
 */
export async function initKmsSigner(): Promise<SignerInterface | null> {
  const keyArn = process.env.KMS_KEY_ARN;
  const region = process.env.KMS_REGION ?? 'eu-west-1';
  if (!keyArn) return null;

  log.info({ keyArn, region }, 'Initializing AWS KMS signer');

  try {
    // Dynamic import — only pulled in at runtime if KMS is actually configured.
    // npm install @aws-sdk/client-kms before first run.
    const { KMSClient, SignCommand, GetPublicKeyCommand } = await import('@aws-sdk/client-kms' as string);

    const client = new KMSClient({ region });

    // Fetch public key once at init; cache for the process lifetime.
    const pubCmd = new GetPublicKeyCommand({ KeyId: keyArn });
    const pubRes = await client.send(pubCmd);
    const derPubKey = pubRes.PublicKey;
    if (!derPubKey) throw new Error('KMS returned no public key');

    // Parse DER, extract uncompressed secp256k1 point, compute keccak256 → address.
    // Details in R4 deployment runbook — this scaffold does NOT implement the
    // parser because it depends on the @aws-sdk response shape which is version-
    // specific. Real implementation should:
    //   1. Strip DER wrapper (~23 byte prefix for secp256k1)
    //   2. Verify leading 0x04 (uncompressed)
    //   3. Take bytes 1..65 → publicKeyBytes
    //   4. address = keccak256(publicKeyBytes).slice(-20)
    log.warn('KMS signer scaffold — DER parser not yet implemented. R4 deployment TODO.');

    const publicKey: Hex = '0x00'; // placeholder
    const address: Hex = '0x0000000000000000000000000000000000000000'; // placeholder

    return {
      address,
      async signTransaction(tx: TransactionSerializable): Promise<Hex> {
        const serialized = serializeTransaction(tx);
        const hash = keccak256(serialized);
        const signCmd = new SignCommand({
          KeyId: keyArn,
          Message: Buffer.from(hash.slice(2), 'hex'),
          MessageType: 'DIGEST',
          SigningAlgorithm: 'ECDSA_SHA_256',
        });
        const signRes = await client.send(signCmd);
        if (!signRes.Signature) throw new Error('KMS Sign returned no signature');
        // DER → r/s → v recovery: see R4 runbook. Real implementation uses
        // @noble/secp256k1 to recover `v` by trying both 27/28.
        throw new Error('KMS signTransaction: DER→r/s/v decoding not yet implemented');
      },
      async signMessage(_message: string | Hex): Promise<Hex> {
        throw new Error('KMS signMessage not yet implemented');
      },
    };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'KMS signer init failed');
    return null;
  }
}

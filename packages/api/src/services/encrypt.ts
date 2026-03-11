/**
 * AES-256-GCM encryption for integration secrets stored in user_integrations.
 *
 * Wire format: base64( iv[12 bytes] + authTag[16 bytes] + ciphertext )
 *
 * The master key is a 32-byte secret loaded from ENCRYPTION_KEY (base64-encoded).
 * Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * Security properties:
 * - Each call to encrypt() uses a fresh random IV — identical plaintexts produce different ciphertexts
 * - GCM authentication tag catches any tampering with the ciphertext
 * - The key never appears in logs; only the encrypted output is stored in the DB
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;      // 96-bit IV — recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128-bit authentication tag

function loadKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY is not set in environment.");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32)
    throw new Error(
      `ENCRYPTION_KEY must be 32 bytes when base64-decoded (got ${key.length}). ` +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    );
  return key;
}

/**
 * Encrypt a plaintext string.
 * Returns a base64 string: iv[12] + authTag[16] + ciphertext.
 */
export function encrypt(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

/**
 * Decrypt a base64 string produced by encrypt().
 * Throws if the key is wrong or the ciphertext has been tampered with.
 */
export function decrypt(encoded: string): string {
  const key = loadKey();
  const buf = Buffer.from(encoded, "base64");
  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH)
    throw new Error("Encrypted payload is too short to be valid.");
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * Convenience: encrypt a JSON-serialisable value.
 */
export function encryptJson(value: unknown): string {
  return encrypt(JSON.stringify(value));
}

/**
 * Convenience: decrypt and JSON-parse a value encrypted with encryptJson().
 */
export function decryptJson<T>(encoded: string): T {
  return JSON.parse(decrypt(encoded)) as T;
}

/**
 * Print a freshly generated key to stdout — for use in the setup script.
 * Never call this at runtime.
 */
export function generateKey(): string {
  return randomBytes(32).toString("base64");
}

/**
 * AES-256-GCM encryption utilities for token storage
 * 
 * Tokens are encrypted before storage and decrypted on retrieval.
 * Uses a versioned payload format to support future key rotation.
 */

import crypto from 'crypto';

/** Encryption algorithm */
const ALGORITHM = 'aes-256-gcm';

/** IV length in bytes (96 bits recommended for GCM) */
const IV_LENGTH = 12;

/** Auth tag length in bytes */
const TAG_LENGTH = 16;

/** Current payload version */
const CURRENT_VERSION = 1;

/**
 * Versioned encrypted payload structure
 */
interface EncryptedPayload {
  /** Version of the encryption format */
  v: number;
  /** Initialization vector (base64) */
  iv: string;
  /** Encrypted data (base64) */
  data: string;
  /** Authentication tag (base64) */
  tag: string;
}

/**
 * Get the encryption key from environment
 * @throws Error if key is missing or invalid
 */
function getEncryptionKey(): Buffer {
  const keyHex = process.env.ENCRYPTION_KEY;
  
  if (!keyHex) {
    throw new Error('ENCRYPTION_KEY environment variable is not set');
  }
  
  // Key should be 32 bytes (256 bits) as hex = 64 characters
  if (keyHex.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex characters)');
  }
  
  return Buffer.from(keyHex, 'hex');
}

/**
 * Encrypt a plaintext string using AES-256-GCM
 * 
 * @param plaintext - The string to encrypt
 * @returns JSON string containing the versioned encrypted payload
 * 
 * @example
 * ```ts
 * const encrypted = encrypt('sk_live_xxx');
 * // Returns: '{"v":1,"iv":"...","data":"...","tag":"..."}'
 * ```
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  
  // Generate a random IV for each encryption
  const iv = crypto.randomBytes(IV_LENGTH);
  
  // Create cipher
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  // Encrypt the plaintext
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  
  // Get the auth tag
  const tag = cipher.getAuthTag();
  
  // Build the versioned payload
  const payload: EncryptedPayload = {
    v: CURRENT_VERSION,
    iv: iv.toString('base64'),
    data: encrypted.toString('base64'),
    tag: tag.toString('base64')
  };
  
  return JSON.stringify(payload);
}

/**
 * Decrypt an encrypted payload string
 * 
 * @param encryptedJson - JSON string containing the encrypted payload
 * @returns The decrypted plaintext string
 * @throws Error if decryption fails or payload is invalid
 * 
 * @example
 * ```ts
 * const plaintext = decrypt('{"v":1,"iv":"...","data":"...","tag":"..."}');
 * // Returns: 'sk_live_xxx'
 * ```
 */
export function decrypt(encryptedJson: string): string {
  const key = getEncryptionKey();
  
  // Parse the payload
  let payload: EncryptedPayload;
  try {
    payload = JSON.parse(encryptedJson);
  } catch {
    throw new Error('Invalid encrypted payload: not valid JSON');
  }
  
  // Validate version
  if (payload.v !== CURRENT_VERSION) {
    throw new Error(`Unsupported encryption version: ${payload.v}`);
  }
  
  // Validate required fields
  if (!payload.iv || !payload.data || !payload.tag) {
    throw new Error('Invalid encrypted payload: missing required fields');
  }
  
  // Decode from base64
  const iv = Buffer.from(payload.iv, 'base64');
  const data = Buffer.from(payload.data, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  
  // Validate IV length
  if (iv.length !== IV_LENGTH) {
    throw new Error('Invalid encrypted payload: incorrect IV length');
  }
  
  // Validate tag length
  if (tag.length !== TAG_LENGTH) {
    throw new Error('Invalid encrypted payload: incorrect tag length');
  }
  
  // Create decipher
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  
  // Decrypt
  try {
    const decrypted = Buffer.concat([
      decipher.update(data),
      decipher.final()
    ]);
    
    return decrypted.toString('utf8');
  } catch (error) {
    // Don't leak details about decryption failures
    throw new Error('Decryption failed: invalid ciphertext or authentication tag');
  }
}

/**
 * Generate a new encryption key
 * Useful for initial setup or key rotation
 * 
 * @returns A 32-byte key as a hex string
 * 
 * @example
 * ```bash
 * # Generate a key using Node.js:
 * node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 * 
 * # Or using openssl:
 * openssl rand -hex 32
 * ```
 */
export function generateKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Hash a string using SHA-256
 * Used for hashing OAuth state values before storage
 * 
 * @param value - The string to hash
 * @returns The SHA-256 hash as a hex string
 */
export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Generate a cryptographically secure random string
 * Used for generating OAuth state values
 * 
 * @param bytes - Number of random bytes (default: 32)
 * @returns Random bytes as a hex string
 */
export function generateRandomState(bytes: number = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}


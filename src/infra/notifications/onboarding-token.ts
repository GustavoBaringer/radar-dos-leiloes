import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function parseOnboardingTokenKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('Invalid onboarding token key configuration.');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) throw new Error('Invalid onboarding token key configuration.');
  return key;
}

export function encryptOnboardingToken(token: string, key: Uint8Array): Buffer {
  if (key.byteLength !== 32) throw new Error('Invalid onboarding token key.');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptOnboardingToken(envelope: Uint8Array, key: Uint8Array): string {
  if (key.byteLength !== 32 || envelope.byteLength < 1 + IV_BYTES + TAG_BYTES + 1) {
    throw new Error('Invalid encrypted onboarding token.');
  }
  const bytes = Buffer.from(envelope);
  if (bytes[0] !== VERSION) throw new Error('Invalid encrypted onboarding token.');
  const ivStart = 1;
  const tagStart = ivStart + IV_BYTES;
  const ciphertextStart = tagStart + TAG_BYTES;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(ivStart, tagStart));
    decipher.setAuthTag(bytes.subarray(tagStart, ciphertextStart));
    const plaintext = Buffer.concat([decipher.update(bytes.subarray(ciphertextStart)), decipher.final()]);
    const token = plaintext.toString('utf8');
    if (!Buffer.from(token, 'utf8').equals(plaintext)) throw new Error('Invalid encrypted onboarding token.');
    return token;
  } catch {
    throw new Error('Invalid encrypted onboarding token.');
  }
}

export function hashOnboardingToken(token: string): string {
  // Valid tokens are 32 random bytes encoded as unpadded base64url.
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid onboarding token.');
  const decoded = Buffer.from(token, 'base64url');
  if (decoded.length !== 32 || decoded.toString('base64url') !== token) throw new Error('Invalid onboarding token.');
  return createHash('sha256').update(decoded).digest('hex');
}

export function sameOnboardingKeySecret(key: Uint8Array, configuredKey: string, secret: string | undefined): boolean {
  if (!secret) return false;
  const normalized = secret.trim();
  const keyBytes = Buffer.from(key);
  const secretBytes = Buffer.from(normalized, 'utf8');
  const sameBytes = keyBytes.length === secretBytes.length && timingSafeEqual(keyBytes, secretBytes);
  return sameBytes || normalized === configuredKey || normalized === keyBytes.toString('hex');
}

import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const TAG_OFFSET = IV_LENGTH;

function getKey(): Buffer {
  const key = process.env.EMAIL_ENCRYPTION_KEY;
  if (!key) {
    throw new Error('EMAIL_ENCRYPTION_KEY environment variable is not set');
  }
  const salt = process.env.EMAIL_ENCRYPTION_SALT || 'vaysen-crm-salt';
  return crypto.scryptSync(key, salt, 32);
}

export function encrypt(text: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decrypt(encryptedText: string): string {
  const key = getKey();
  const buf = Buffer.from(encryptedText, 'base64');
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(TAG_OFFSET, TAG_OFFSET + TAG_LENGTH);
  const encrypted = buf.subarray(TAG_OFFSET + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

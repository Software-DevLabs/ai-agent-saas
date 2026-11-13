import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * One utility for every credential at rest — bot tokens, OAuth refresh
 * tokens, provider keys. AES-256-GCM from node:crypto (audited stdlib; the
 * plan's libsodium suggestion is a native dependency, and the security
 * claim — one place, one blob, no plaintext columns — lives here either way).
 *
 * Blob format: `v1:<keyId>:<nonce b64>:<ciphertext b64 (tag appended)>`.
 * The keyId is inside the authenticated data, so a blob re-stamped with a
 * different keyId fails the tag instead of silently decrypting elsewhere.
 * Keeping the previous key in the ring makes rotation non-big-bang: write
 * with the new key, read with either, clear the old one once all rows moved.
 */

export class CryptoError extends Error {}

interface KeyEntry {
  id: string;
  key: Buffer;
}

const AAD = "saas-credentials-v1";

function decodeB64Key(raw: string, label: string): Buffer {
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new CryptoError(`${label} must decode to exactly 32 bytes`);
  return buf;
}

export class Keyring {
  private readonly current: KeyEntry;
  private readonly byId = new Map<string, Buffer>();

  constructor(current: KeyEntry, previous?: KeyEntry | undefined) {
    this.current = current;
    this.byId.set(current.id, current.key);
    if (previous) this.byId.set(previous.id, previous.key);
  }

  static fromEnv(env: {
    CREDENTIALS_KEY: string;
    CREDENTIALS_KEY_ID: string;
    CREDENTIALS_KEY_PREVIOUS?: string | undefined;
    CREDENTIALS_KEY_PREVIOUS_ID?: string | undefined;
  }): Keyring {
    const current: KeyEntry = { id: env.CREDENTIALS_KEY_ID, key: decodeB64Key(env.CREDENTIALS_KEY, "CREDENTIALS_KEY") };
    const previous: KeyEntry | undefined =
      env.CREDENTIALS_KEY_PREVIOUS && env.CREDENTIALS_KEY_PREVIOUS_ID
        ? { id: env.CREDENTIALS_KEY_PREVIOUS_ID, key: decodeB64Key(env.CREDENTIALS_KEY_PREVIOUS, "CREDENTIALS_KEY_PREVIOUS") }
        : undefined;
    return new Keyring(current, previous);
  }

  encrypt(plain: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.current.key, nonce);
    cipher.setAAD(Buffer.from(`${AAD} ${this.current.id}`));
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return `v1:${this.current.id}:${nonce.toString("base64")}:${ct.toString("base64")}`;
  }

  decrypt(blob: string): string {
    const parts = blob.split(":");
    if (parts.length !== 4 || parts[0] !== "v1" || !parts[1] || !parts[2] || !parts[3]) {
      throw new CryptoError("credential blob is not in v1 format");
    }
    const keyId = parts[1];
    const key = this.byId.get(keyId);
    if (!key) throw new CryptoError(`unknown credential key id "${keyId}" — is it still in the ring?`);
    const raw = Buffer.from(parts[3], "base64");
    if (raw.length < 16) throw new CryptoError("credential blob is truncated");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[2], "base64"));
    decipher.setAAD(Buffer.from(`${AAD} ${keyId}`));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    try {
      return Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString("utf8");
    } catch {
      throw new CryptoError("credential blob failed authentication — tampered or decrypted with the wrong key");
    }
  }
}

/** Constant-time compare for secrets that arrive over the wire (webhook tokens). */
export function safeCompare(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

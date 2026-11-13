import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { CryptoError, Keyring, safeCompare } from "../src/crypto.ts";

const b64 = () => randomBytes(32).toString("base64");

function ring(opts: { previous?: boolean } = {}) {
  return Keyring.fromEnv({
    CREDENTIALS_KEY: b64(),
    CREDENTIALS_KEY_ID: "k2",
    ...(opts.previous ? { CREDENTIALS_KEY_PREVIOUS: b64(), CREDENTIALS_KEY_PREVIOUS_ID: "k1" } : {}),
  });
}

describe("Keyring", () => {
  it("round-trips a secret", () => {
    const r = ring();
    const blob = r.encrypt("bot-token-1234");
    expect(blob.startsWith("v1:k2:")).toBe(true);
    expect(r.decrypt(blob)).toBe("bot-token-1234");
  });

  it("never leaves the plaintext in the blob", () => {
    const r = ring();
    expect(r.encrypt("super-secret-value")).not.toContain("super-secret-value");
  });

  it("rejects a tampered ciphertext", () => {
    const r = ring();
    const blob = r.encrypt("value");
    const [scheme, keyId, nonce, ct] = blob.split(":");
    const flipped = Buffer.from(ct!, "base64");
    flipped[0] = flipped[0]! ^ 0xff;
    expect(() => r.decrypt(`${scheme}:${keyId}:${nonce}:${flipped.toString("base64")}`)).toThrow(CryptoError);
  });

  it("decrypts old blobs during rotation but stamps new ones with the current key", () => {
    const previous = ring();
    const oldBlob = previous.encrypt("legacy");
    const previousKey = previous["current"] as { id: string; key: Buffer };
    const rotated = new Keyring({ id: "k2", key: randomBytes(32) }, { id: previousKey.id, key: previousKey.key });
    expect(rotated.decrypt(oldBlob)).toBe("legacy");
    expect(rotated.encrypt("fresh").startsWith("v1:k2:")).toBe(true);
  });

  it("refuses a blob re-stamped with a foreign keyId (AAD binds the id)", () => {
    const r = ring();
    const blob = r.encrypt("value");
    const restamped = blob.replace("v1:k2:", "v1:zz:");
    expect(() => r.decrypt(restamped)).toThrow(/unknown credential key id/);
  });

  it("rejects malformed blobs and bad key material", () => {
    const r = ring();
    expect(() => r.decrypt("garbage")).toThrow(CryptoError);
    expect(() => Keyring.fromEnv({ CREDENTIALS_KEY: "short", CREDENTIALS_KEY_ID: "k1" })).toThrow(/32 bytes/);
  });

  it("safeCompare matches equal strings and survives length differences", () => {
    expect(safeCompare("abc123", "abc123")).toBe(true);
    expect(safeCompare("abc123", "abc124")).toBe(false);
    expect(safeCompare("abc", "abcd")).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import {
  generateApiKey,
  hashApiKey,
  verifyApiKey,
  deriveKeyPrefixFromFullKey,
} from "./api-key.js";

describe("api-key", () => {
  it("generates a key with the stable vlr_live_ prefix", () => {
    const { fullKey, keyPrefix } = generateApiKey();
    expect(fullKey.startsWith("vlr_live_")).toBe(true);
    expect(keyPrefix.startsWith("vlr_live_")).toBe(true);
    expect(fullKey.length).toBeGreaterThan(keyPrefix.length);
  });

  it("generates unique keys on each call", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.fullKey).not.toBe(b.fullKey);
  });

  it("round-trips: a hashed key verifies successfully against the original", () => {
    const { fullKey } = generateApiKey();
    const hashed = hashApiKey(fullKey);
    expect(verifyApiKey(fullKey, hashed)).toBe(true);
  });

  it("rejects a wrong key", () => {
    const { fullKey } = generateApiKey();
    const hashed = hashApiKey(fullKey);
    const { fullKey: wrongKey } = generateApiKey();
    expect(verifyApiKey(wrongKey, hashed)).toBe(false);
  });

  it("rejects a malformed stored hash gracefully", () => {
    expect(verifyApiKey("vlr_live_whatever", "not-a-valid-hash")).toBe(false);
  });

  it("produces different hashes for the same key on repeated calls (random salt)", () => {
    const { fullKey } = generateApiKey();
    const hash1 = hashApiKey(fullKey);
    const hash2 = hashApiKey(fullKey);
    expect(hash1).not.toBe(hash2);
    // but both still verify correctly against the same original key
    expect(verifyApiKey(fullKey, hash1)).toBe(true);
    expect(verifyApiKey(fullKey, hash2)).toBe(true);
  });

  describe("deriveKeyPrefixFromFullKey", () => {
    it("derives the exact same prefix generateApiKey() issued", () => {
      const { fullKey, keyPrefix } = generateApiKey();
      expect(deriveKeyPrefixFromFullKey(fullKey)).toBe(keyPrefix);
    });

    it("returns null for a key with the wrong prefix", () => {
      expect(deriveKeyPrefixFromFullKey("sk_live_notavolarkey")).toBeNull();
    });

    it("returns null for a key too short to contain a real prefix segment", () => {
      expect(deriveKeyPrefixFromFullKey("vlr_live_abc")).toBeNull();
    });

    it("returns null for a completely empty string", () => {
      expect(deriveKeyPrefixFromFullKey("")).toBeNull();
    });
  });
});

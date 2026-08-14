import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

// Issue 3.3 (Epic 3): API key generation, hashing, and verification.
// PRD §7 APIKey.key_prefix / .hashed_key; PRD §10.3 "API keys are stored
// hashed; only shown in plaintext once at creation/rotation."
//
// Format: `vlr_live_<43-char base64url secret>` (32 cryptographically
// random bytes, base64url-encoded). "vlr_live_" is a stable, documented
// prefix — the same idea as Stripe's `sk_live_` or GitHub's `ghp_`,
// letting a key be recognized at a glance (and, later, scanned for in
// leaked source or logs).
//
// Hashing: salted SHA-256, not bcrypt. Bcrypt and similar deliberately-
// slow key-derivation functions exist to defend low-entropy, human-
// chosen passwords against offline brute force. That threat model
// doesn't apply here — the key itself already has 256 bits of
// crypto.randomBytes entropy, computationally infeasible to guess or
// brute-force regardless of hash speed. What actually matters is being
// able to verify a presented key efficiently (SHA-256 is fast; bcrypt is
// deliberately not) while still storing nothing that lets a database
// leak directly authenticate as that key — a salted SHA-256 digest
// achieves both, and is standard practice for high-entropy API tokens
// specifically (as opposed to passwords).

const KEY_PREFIX = "vlr_live_";
const SECRET_BYTES = 32;
const SALT_BYTES = 16;
const PREFIX_DISPLAY_CHARS = 8;

export interface GeneratedApiKey {
  /** The full secret key — shown to the user exactly once, never stored. */
  fullKey: string;
  /** Short, non-secret prefix for display/lookup — safe to store in the clear. */
  keyPrefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const fullKey = `${KEY_PREFIX}${secret}`;
  const keyPrefix = `${KEY_PREFIX}${secret.slice(0, PREFIX_DISPLAY_CHARS)}`;
  return { fullKey, keyPrefix };
}

/**
 * Hashes a full API key for storage in APIKey.hashed_key. The random
 * salt is stored alongside the hash in a single "<salt>:<hash>" string,
 * since the schema (issue 3.2's migration) has one hashed_key column,
 * not a separate salt column.
 */
export function hashApiKey(fullKey: string): string {
  const salt = randomBytes(SALT_BYTES).toString("hex");
  const hash = sha256Hex(salt + fullKey);
  return `${salt}:${hash}`;
}

/**
 * Verifies a presented key against a stored hashed_key value. Uses
 * crypto.timingSafeEqual rather than `===` so that response-time
 * differences can't leak how many leading bytes of the hash matched (a
 * timing side-channel attack) — the standard reason to avoid naive
 * string comparison for secret verification.
 */
export function verifyApiKey(
  presentedKey: string,
  storedHashedKey: string,
): boolean {
  const [salt, expectedHash] = storedHashedKey.split(":");
  if (!salt || !expectedHash) {
    return false;
  }

  const actualHash = sha256Hex(salt + presentedKey);

  const expectedBuffer = Buffer.from(expectedHash, "hex");
  const actualBuffer = Buffer.from(actualHash, "hex");

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, actualBuffer);
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Issue 6.2 (Epic 6): derives the same `keyPrefix` string generateApiKey()
 * produces, but from a *presented* full key at verification time rather
 * than at issuance time. This is what lets the auth middleware do an
 * indexed `key_prefix` lookup (candidate rows, typically 0 or 1) instead
 * of fetching and hashing against every row in `api_keys` on every
 * request -- `key_prefix` exists in the schema specifically "for
 * display/lookup" (see the issue 3.2 migration's column comment).
 *
 * Returns null for anything that isn't even shaped like a Volar key
 * (wrong/missing prefix, or too short to contain a real prefix segment)
 * -- callers use that to short-circuit straight to a generic
 * "not found" auth failure without touching the database at all.
 */
export function deriveKeyPrefixFromFullKey(fullKey: string): string | null {
  if (!fullKey.startsWith(KEY_PREFIX)) {
    return null;
  }
  const secret = fullKey.slice(KEY_PREFIX.length);
  if (secret.length < PREFIX_DISPLAY_CHARS) {
    return null;
  }
  return `${KEY_PREFIX}${secret.slice(0, PREFIX_DISPLAY_CHARS)}`;
}

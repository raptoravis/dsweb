import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const KEYLEN = 64;
const SALT_LEN = 16;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Hash a password with a random per-password salt (scrypt). */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LEN);
  const hash = scryptSync(password, salt, KEYLEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** Constant-time comparison against a stored `hashPassword` output. */
export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const sessionTtlMs = SESSION_TTL_MS;

export function sessionExpiry(): number {
  return Date.now() + SESSION_TTL_MS;
}

/** Basic email shape check — presence + an `@` with a local and domain part. */
export function isEmail(value: string): boolean {
  const at = value.indexOf("@");
  return at > 0 && at < value.length - 1 && !value.includes(" ");
}

/** Basic password policy: at least 8 characters. */
export function isValidPassword(value: string): boolean {
  return value.length >= 8;
}

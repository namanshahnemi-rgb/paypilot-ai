// Password hashing with Node's built-in scrypt. A stored hash records its own
// parameters, so the cost can be raised later without breaking old hashes:
//   scrypt$<N>$<r>$<p>$<salt base64url>$<key base64url>
// Passwords are never stored, logged, or returned.
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

export type ScryptParams = { N: number; r: number; p: number };

// About 50-100 ms per hash on a small server; 32 MiB of memory per hash.
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export const PASSWORD_MIN_LENGTH = 12;
// scrypt accepts any length; the cap keeps request bodies and work bounded.
export const PASSWORD_MAX_LENGTH = 128;

function scrypt(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const options: ScryptOptions = {
    N: params.N,
    r: params.r,
    p: params.p,
    // scrypt needs 128 * N * r bytes; allow twice that.
    maxmem: 256 * params.N * params.r,
  };
  return new Promise((resolve, reject) => {
    scryptCallback(password.normalize("NFKC"), salt, KEY_LENGTH, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scrypt(password, salt, params);
  return ["scrypt", params.N, params.r, params.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

function parseHash(stored: string): { params: ScryptParams; salt: Buffer; key: Buffer } | undefined {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return undefined;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return undefined;
  // Refuse absurd parameters from a corrupted row instead of exhausting memory.
  if (N! < 2 ** 10 || N! > 2 ** 20 || r! < 1 || r! > 32 || p! < 1 || p! > 16) return undefined;
  const salt = Buffer.from(parts[4]!, "base64url");
  const key = Buffer.from(parts[5]!, "base64url");
  if (salt.length < SALT_LENGTH || key.length !== KEY_LENGTH) return undefined;
  return { params: { N: N!, r: r!, p: p! }, salt, key };
}

// Constant-time comparison of the derived keys. A malformed stored hash never
// matches.
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const key = await scrypt(password, parsed.salt, parsed.params);
  return timingSafeEqual(key, parsed.key);
}

// The minimum rules for a new password. Returns a message for the user, or
// undefined when the password is acceptable.
export function passwordProblem(password: string, email: string): string | undefined {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Use a password of at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Use a password of at most ${PASSWORD_MAX_LENGTH} characters.`;
  }
  if (password.trim().length === 0 || new Set(password).size < 4) {
    return "Choose a less predictable password.";
  }
  if (password.toLowerCase() === email.toLowerCase()) {
    return "The password must not be your email address.";
  }
  return undefined;
}

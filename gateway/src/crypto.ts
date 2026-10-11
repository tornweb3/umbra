import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

const keyHex = process.env.MASTER_KEY ?? "";
if (keyHex.length !== 64) {
  throw new Error("MASTER_KEY must be 32 bytes hex (64 chars) in .env");
}
const MASTER_KEY = Buffer.from(keyHex, "hex");

// Layout: 12-byte IV || 16-byte auth tag || ciphertext
export function encrypt(plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", MASTER_KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function decrypt(blob: Buffer): string {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", MASTER_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function hmacSign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function newSecret(): string {
  return randomBytes(32).toString("hex");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * A secret derived from MASTER_KEY for one internal purpose.
 *
 * Keeps things like page mint tickets out of the database without inventing a
 * second key for the operator to manage. Different purposes get unrelated
 * secrets, so one leaking tells you nothing about another.
 */
export function derivedSecret(purpose: string): string {
  return createHmac("sha256", MASTER_KEY).update(`umbra/${purpose}`).digest("hex");
}

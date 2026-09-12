import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import * as zxcvbnCommon from '@zxcvbn-ts/language-common';
import * as zxcvbnEn from '@zxcvbn-ts/language-en';

/*
 * Password hashing, strength estimation, TOTP and token helpers. All the
 * cryptographic choices in one file so they can be reviewed together.
 */

// ---------------------------------------------------------------- passwords

/**
 * Argon2id at the OWASP "minimum" configuration: 19 MiB, 2 iterations, 1 lane.
 * About 20 ms on an N100 and well under 200 ms on a Pi 5, which is fast
 * enough for a login and slow enough to make offline cracking expensive.
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** Minimum length. No composition rules: length and unguessability are what matter. */
export const MIN_PASSWORD_LENGTH = 10;
/** zxcvbn score below this (0–4) is rejected. 2 = "somewhat guessable". */
export const MIN_PASSWORD_SCORE = 2;

const zxcvbn = new ZxcvbnFactory({
  translations: zxcvbnEn.translations,
  graphs: zxcvbnCommon.adjacencyGraphs,
  dictionary: { ...zxcvbnCommon.dictionary, ...zxcvbnEn.dictionary },
});

export interface PasswordStrength {
  score: 0 | 1 | 2 | 3 | 4;
  warning: string;
  suggestions: string[];
  /** Human estimate for an offline attack at 1e10 guesses/s. */
  crackTime: string;
  acceptable: boolean;
  problems: string[];
}

export function passwordStrength(password: string, userInputs: string[] = []): PasswordStrength {
  const problems: string[] = [];
  if (password.length < MIN_PASSWORD_LENGTH) {
    problems.push(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const r = zxcvbn.check(password.slice(0, 100), userInputs);
  if (r.score < MIN_PASSWORD_SCORE) problems.push('Too easy to guess.');
  return {
    score: r.score,
    warning: r.feedback.warning ?? '',
    suggestions: r.feedback.suggestions,
    crackTime: r.crackTimes.offlineFastHashingXPerSecond.display,
    acceptable: problems.length === 0,
    problems,
  };
}

// ---------------------------------------------------------------- tokens

/** 256-bit random, URL-safe. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------- TOTP (RFC 6238)

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32.charAt((value << (5 - bits)) & 31);
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const offset = (h[h.length - 1] ?? 0) & 0xf;
  const code =
    (((h[offset] ?? 0) & 0x7f) << 24) |
    (((h[offset + 1] ?? 0) & 0xff) << 16) |
    (((h[offset + 2] ?? 0) & 0xff) << 8) |
    ((h[offset + 3] ?? 0) & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

export function totpCode(secretBase32: string, nowMs: number, stepS = 30): string {
  return hotp(base32Decode(secretBase32), Math.floor(nowMs / 1000 / stepS));
}

/** Accept the current step and one either side (clock skew on a boat with no NTP). */
export function verifyTotp(secretBase32: string, code: string, nowMs: number, window = 1): boolean {
  const clean = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  const secret = base32Decode(secretBase32);
  const step = Math.floor(nowMs / 1000 / 30);
  for (let i = -window; i <= window; i++) {
    if (safeEqual(hotp(secret, step + i), clean)) return true;
  }
  return false;
}

export function otpauthUrl(issuer: string, account: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ---------------------------------------------------------------- recovery codes

/** Ten codes of the form xxxxx-xxxxx from an unambiguous alphabet. */
export function generateRecoveryCodes(count = 10): string[] {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    let c = '';
    for (let j = 0; j < 10; j++) {
      if (j === 5) c += '-';
      c += alphabet.charAt(randomInt(alphabet.length));
    }
    codes.push(c);
  }
  return codes;
}

export function normaliseRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, '');
}

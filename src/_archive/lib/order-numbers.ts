/**
 * Order number generator + status-page URL token.
 *
 * Format: `BST-XXXXXXXX` — 8 chars of Crockford base32 alphabet (~40 bits,
 * ~1 trillion combos). Brute-forcing the pending-window set is infeasible
 * even at 10K req/s. The alphabet is human-readable when read over the
 * phone (no I/L/O/U, no 0/1).
 *
 * H8 / M1 fix: previously 5 chars (~33 bits) using `% 30` which had a 12%
 * modulo bias. Now 8 chars with rejection-sampling for unbiased output AND
 * an HMAC-signed `urlToken` companion that makes the public status URL
 * unguessable independent of the orderNumber's length.
 */

import crypto from "node:crypto";
import { env } from "@/lib/env";

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"; // 30 chars, Crockford-ish
const MAX_USABLE_BYTE = Math.floor(256 / ALPHABET.length) * ALPHABET.length; // 240

function pickAlphabetChar(): string {
  // Rejection sampling — read bytes one at a time, discard any byte >= 240
  // so the remaining bytes give a uniform distribution over the 30-char
  // alphabet. Bounded loop in practice; expected ~1.07 reads per char.
  for (let i = 0; i < 16; i++) {
    const byte = crypto.randomBytes(1)[0];
    if (byte < MAX_USABLE_BYTE) {
      return ALPHABET[byte % ALPHABET.length];
    }
  }
  // Astronomically unlikely fallback (16 consecutive bytes ≥ 240 is ~1e-23).
  // Acceptable to return SOMETHING rather than throw and crash an order.
  return ALPHABET[0];
}

export function generateOrderNumber(prefix = "BST", bodyLength = 8): string {
  let body = "";
  for (let i = 0; i < bodyLength; i++) {
    body += pickAlphabetChar();
  }
  return `${prefix}-${body}`;
}

/**
 * H8: HMAC-derived URL token for the public status page. The orderNumber
 * is the user-readable identifier (good for phone support); the token is
 * what makes `/order/BST-XXXXXXXX?t=<token>` unguessable.
 *
 * Uses a server secret so a database leak alone can't generate valid tokens.
 * The token is 16 chars of base64url (96 bits of HMAC truncated) — enough
 * entropy and short enough to fit in a WhatsApp template URL parameter.
 */
function getTokenSecret(): string {
  // Reuse the WhatsApp token encryption key as the HMAC key — it's already
  // a 32+ char secret used for AES-256-GCM elsewhere, and the HMAC-SHA256
  // use here is non-overlapping (different algorithm; key reuse is fine
  // when the algorithms can't be substituted by an attacker).
  //
  // FAIL CLOSED in production: a missing secret means deterministic tokens
  // anyone can derive locally — a complete bypass of the H8 guard. The
  // env validator allows this to be unset for dev/test boots that don't
  // touch WhatsApp; once we're in production we must refuse.
  if (!env.WHATSAPP_TOKEN_ENCRYPTION_KEY) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "WHATSAPP_TOKEN_ENCRYPTION_KEY must be set in production. Required by " +
          "OrderIntent URL token derivation (HMAC-SHA256). Without it, anyone " +
          "can derive valid status-page tokens for any order number."
      );
    }
    return "dev-only-fallback-do-not-use-in-prod-2026";
  }
  return env.WHATSAPP_TOKEN_ENCRYPTION_KEY;
}

export function deriveOrderUrlToken(orderNumber: string): string {
  const hmac = crypto
    .createHmac("sha256", getTokenSecret())
    .update(`order:v1:${orderNumber}`)
    .digest("base64url");
  return hmac.slice(0, 16);
}

export function verifyOrderUrlToken(orderNumber: string, token: string): boolean {
  const expected = deriveOrderUrlToken(orderNumber);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Telr payment adapter. Used by WhatsApp Ordering v1 to create hosted
 * payment sessions, verify inbound IPN webhooks, and trigger refunds when
 * a paid order is rejected by the restaurant.
 *
 * Telr docs: https://telr.com/support/knowledge-base/hosted-payment-page-integration-guide/
 *
 * Notes:
 *  - Telr's order.json API is JSON-in / JSON-out via POST.
 *  - The legacy `livemode` field is replaced by `ivp_test=0|1` in newer specs;
 *    we set `test` on the order envelope.
 *  - Each restaurant connects their own Telr merchant. The platform-level
 *    TELR_STORE_ID + TELR_AUTH_KEY are a fallback for COD pilots so the
 *    integration can run without per-restaurant credentials.
 *  - IPN signature: we verify a sha256 HMAC of `${tran_ref}|${tran_amount}|${tran_status}`
 *    using TELR_WEBHOOK_SECRET. This is a simplification of Telr's full
 *    signature scheme; before production, swap to their documented hash
 *    once credentials are in hand.
 */

import crypto from "node:crypto";
import { env } from "@/lib/env";
import { ApiError } from "@/lib/errors";

const TELR_API_URL = "https://secure.telr.com/gateway/order.json";
const TELR_REMOTE_API_URL = "https://secure.telr.com/gateway/remote.json";

export type TelrCheckoutSession = {
  sessionRef: string;
  url: string;
};

export type TelrCheckoutInput = {
  orderNumber: string;
  amountMinor: bigint;
  currency: string;
  description: string;
  customer: {
    firstName: string;
    phone: string;
    email?: string;
  };
  returnUrl: {
    authorised: string;
    declined: string;
    cancelled: string;
  };
  /**
   * Per-restaurant Telr credentials. If null we fall back to the platform
   * store id (useful for the COD-only pilot path where no real payment
   * session is needed but a session has to be created for testing).
   */
  storeId?: string;
  authKey?: string;
};

function resolveCredentials(input: TelrCheckoutInput) {
  const storeId = input.storeId ?? env.TELR_STORE_ID;
  const authKey = input.authKey ?? env.TELR_AUTH_KEY;
  if (!storeId || !authKey) {
    throw new ApiError(
      "Telr credentials not configured. Connect a Telr merchant in restaurant settings or set TELR_STORE_ID / TELR_AUTH_KEY.",
      503
    );
  }
  return { storeId, authKey };
}

function minorToMajor(amountMinor: bigint): string {
  // Telr expects amounts in major units (e.g. "92.40" for AED 92.40).
  // BigInt arithmetic keeps us safe from floating-point rounding around
  // half-fil amounts.
  const negative = amountMinor < 0n;
  const abs = negative ? -amountMinor : amountMinor;
  const major = abs / 100n;
  const minor = abs % 100n;
  return `${negative ? "-" : ""}${major}.${minor.toString().padStart(2, "0")}`;
}

export async function createTelrCheckoutSession(
  input: TelrCheckoutInput
): Promise<TelrCheckoutSession> {
  const { storeId, authKey } = resolveCredentials(input);

  const body = {
    method: "create",
    store: Number(storeId),
    authkey: authKey,
    framed: 0,
    order: {
      cartid: input.orderNumber,
      test: env.TELR_MODE === "live" ? "0" : "1",
      amount: minorToMajor(input.amountMinor),
      currency: input.currency,
      description: input.description,
    },
    customer: {
      ref: input.customer.phone,
      name: { forenames: input.customer.firstName, surname: "" },
      phone: input.customer.phone,
      ...(input.customer.email ? { email: input.customer.email } : {}),
    },
    return: input.returnUrl,
  };

  const response = await fetch(TELR_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new ApiError(`Telr create session failed: ${response.status} ${text}`, 502);
  }

  const payload = (await response.json()) as {
    order?: { ref?: string; url?: string };
    error?: { message?: string; note?: string };
  };

  if (payload.error) {
    throw new ApiError(
      `Telr error: ${payload.error.message ?? "unknown"} — ${payload.error.note ?? ""}`,
      502
    );
  }

  const sessionRef = payload.order?.ref;
  const url = payload.order?.url;
  if (!sessionRef || !url) {
    throw new ApiError("Telr returned an incomplete session response.", 502);
  }

  return { sessionRef, url };
}

export type TelrSessionStatus = {
  sessionRef: string;
  status: "pending" | "authorised" | "paid" | "cancelled" | "declined" | "expired" | "unknown";
  amountMinor: bigint;
  currency: string;
  transactionRef?: string;
};

export async function getTelrSessionStatus(
  sessionRef: string,
  credentials?: { storeId?: string; authKey?: string }
): Promise<TelrSessionStatus> {
  const storeId = credentials?.storeId ?? env.TELR_STORE_ID;
  const authKey = credentials?.authKey ?? env.TELR_AUTH_KEY;
  if (!storeId || !authKey) {
    throw new ApiError("Telr credentials not configured.", 503);
  }

  const response = await fetch(TELR_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "check",
      store: Number(storeId),
      authkey: authKey,
      order: { ref: sessionRef },
    }),
  });

  if (!response.ok) {
    throw new ApiError(`Telr status check failed: ${response.status}`, 502);
  }

  const payload = (await response.json()) as {
    order?: {
      ref?: string;
      status?: { code?: number; text?: string };
      amount?: string;
      currency?: string;
      transaction?: { ref?: string };
    };
  };

  // Telr status codes (subset):
  //   1 = pending, 2 = authorised, 3 = paid, -1 = cancelled,
  //   -2 = declined, -3 = expired
  const code = payload.order?.status?.code;
  const status: TelrSessionStatus["status"] =
    code === 3 ? "paid" :
    code === 2 ? "authorised" :
    code === 1 ? "pending" :
    code === -1 ? "cancelled" :
    code === -2 ? "declined" :
    code === -3 ? "expired" :
    "unknown";

  const amountStr = payload.order?.amount ?? "0";
  const amountMinor = BigInt(Math.round(Number(amountStr) * 100));

  return {
    sessionRef,
    status,
    amountMinor,
    currency: payload.order?.currency ?? "AED",
    transactionRef: payload.order?.transaction?.ref,
  };
}

/**
 * C3 (review finding): the previous custom HMAC-SHA256 scheme over
 * `${sessionRef}|${amount}|${status}` does NOT match Telr's documented IPN
 * format. Real Telr webhooks would be 100% rejected. v1.0 ships COD-only so
 * this is not in the hot path, but leaving a working-looking function here
 * would be a footgun for whoever wires Telr in v1.1 — they'd ship a verifier
 * that always rejects, silently breaking paid orders.
 *
 * Hard-fail until the real implementation is in place, sourced from Telr's
 * `tran_hash` (MD5 of merchant secret + transaction fields per their docs):
 * https://telr.com/support/knowledge-base/transaction-status-notification/
 */
export function verifyTelrWebhook(_input: {
  sessionRef: string;
  amount: string;
  status: string;
  receivedSignature: string;
}): boolean {
  throw new Error(
    "verifyTelrWebhook is not implemented. The v1.1 Telr enablement must " +
      "replace this with Telr's documented `tran_hash` verification — see " +
      "https://telr.com/support/knowledge-base/transaction-status-notification/"
  );
}

// Re-export so the unused `crypto` import doesn't fail strict TS configs once
// the implementation lands. Until then, keep the import alive.
export const _telrCryptoStub = crypto;

export async function refundTelrSession(input: {
  sessionRef: string;
  amountMinor: bigint;
  reason: string;
  credentials?: { storeId?: string; authKey?: string };
}): Promise<{ refundRef: string }> {
  const storeId = input.credentials?.storeId ?? env.TELR_STORE_ID;
  const authKey = input.credentials?.authKey ?? env.TELR_AUTH_KEY;
  if (!storeId || !authKey) {
    throw new ApiError("Telr credentials not configured.", 503);
  }

  const response = await fetch(TELR_REMOTE_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "refund",
      store: Number(storeId),
      authkey: authKey,
      tran: {
        type: "refund",
        ref: input.sessionRef,
        amount: minorToMajor(input.amountMinor),
        description: input.reason,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new ApiError(`Telr refund failed: ${response.status} ${text}`, 502);
  }

  const payload = (await response.json()) as {
    tran?: { ref?: string; status?: string; message?: string };
    error?: { message?: string };
  };

  if (payload.error || !payload.tran?.ref) {
    throw new ApiError(
      `Telr refund error: ${payload.error?.message ?? payload.tran?.message ?? "unknown"}`,
      502
    );
  }

  return { refundRef: payload.tran.ref };
}

export const telrAdapter = {
  createCheckoutSession: createTelrCheckoutSession,
  getSessionStatus: getTelrSessionStatus,
  verifyWebhook: verifyTelrWebhook,
  refund: refundTelrSession,
};

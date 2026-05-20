// Meta Graph API client scoped to the Bustan-owned WABA (Coworker).
//
// Distinct from lib/whatsapp-business.ts which targets per-restaurant
// integrations via Embedded Signup tokens. Coworker has a single WABA,
// single phone number, and a system-user permanent token — so the API is
// simpler (no decryption, no per-call token lookup, no needs-reconnect
// flow). The two clients deliberately do NOT share a base function: the
// authentication model is different and the failure modes diverge.
//
// Every send respects three gates, IN ORDER:
//   1. env.COWORKER_ENABLED — global off switch
//   2. env.COWORKER_DRY_RUN — reroutes to COWORKER_DRY_RUN_PHONE
//   3. caller-side window check (templates always allowed; free-form only
//      inside the 24h customer-service window)

import crypto from "node:crypto";
import { env } from "@/lib/env";
import { ApiError } from "@/lib/errors";

const GRAPH_BASE = `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}`;

type SendResult = { messageId: string; dryRun: boolean };

function requireCredentials(): {
  token: string;
  phoneNumberId: string;
  wabaId: string;
} {
  if (!env.COWORKER_ENABLED) {
    throw new ApiError("Coworker is disabled (COWORKER_ENABLED=false).", 503);
  }
  if (!env.COWORKER_ACCESS_TOKEN || !env.COWORKER_PHONE_NUMBER_ID || !env.COWORKER_WABA_ID) {
    throw new ApiError(
      "Coworker Meta credentials are not configured. Set COWORKER_ACCESS_TOKEN, COWORKER_PHONE_NUMBER_ID, COWORKER_WABA_ID.",
      503
    );
  }
  return {
    token: env.COWORKER_ACCESS_TOKEN,
    phoneNumberId: env.COWORKER_PHONE_NUMBER_ID,
    wabaId: env.COWORKER_WABA_ID,
  };
}

/** Returns the actual recipient after applying dry-run rerouting. Used by
 *  callers so persisted CoworkerMessage rows record the *real* destination
 *  during a dry-run pilot (an audit trail of "what the owner WOULD have
 *  gotten" matters more than the dry-run target). */
export function resolveRecipientForSend(targetPhoneE164: string): {
  to: string;
  dryRun: boolean;
} {
  if (env.COWORKER_DRY_RUN) {
    if (!env.COWORKER_DRY_RUN_PHONE) {
      throw new ApiError(
        "COWORKER_DRY_RUN=true but COWORKER_DRY_RUN_PHONE is not set.",
        503
      );
    }
    return { to: env.COWORKER_DRY_RUN_PHONE, dryRun: true };
  }
  return { to: targetPhoneE164, dryRun: false };
}

async function graphRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { token } = requireCredentials();
  const response = await fetch(`${GRAPH_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      payload?.error?.message ?? payload?.message ?? `Coworker Graph API failed (${response.status})`;
    throw new ApiError(message, response.status);
  }

  return payload as T;
}

// ── Template CRUD ──────────────────────────────────────────────

export interface CoworkerTemplateComponent {
  type: "BODY" | "FOOTER" | "BUTTONS";
  text?: string;
  example?: { body_text: string[][] };
  buttons?: Array<{
    type: "QUICK_REPLY" | "URL" | "PHONE_NUMBER";
    text: string;
    url?: string;
    phone_number?: string;
  }>;
}

export interface SubmitTemplateInput {
  name: string;
  locale: string;
  category: "UTILITY" | "MARKETING" | "AUTHENTICATION";
  components: CoworkerTemplateComponent[];
}

export interface SubmitTemplateResult {
  metaTemplateId: string;
  status: string;
  category: string;
}

export async function submitTemplate(input: SubmitTemplateInput): Promise<SubmitTemplateResult> {
  const { wabaId } = requireCredentials();
  const result = await graphRequest<{ id?: string; status?: string; category?: string }>(
    `/${wabaId}/message_templates`,
    {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        category: input.category,
        language: input.locale,
        components: input.components,
      }),
    }
  );
  if (!result.id) {
    throw new ApiError("Meta did not return a template id.", 502);
  }
  return {
    metaTemplateId: result.id,
    status: result.status ?? "pending",
    category: result.category ?? input.category,
  };
}

export interface RemoteTemplate {
  id?: string;
  name: string;
  status?: string;
  category?: string;
  language?: string;
  rejected_reason?: string;
  components?: Array<{ type?: string; text?: string }>;
}

export async function fetchAllTemplates(): Promise<RemoteTemplate[]> {
  const { wabaId } = requireCredentials();
  const result = await graphRequest<{ data?: RemoteTemplate[] }>(
    `/${wabaId}/message_templates?fields=id,name,status,category,language,components,rejected_reason&limit=200`
  );
  return result.data ?? [];
}

// ── Outbound message sends ─────────────────────────────────────

export interface SendTemplateInput {
  to: string;
  templateName: string;
  language: string;
  bodyParameters: string[];
}

/** Send an approved template. Always allowed regardless of 24h window. */
export async function sendTemplate(input: SendTemplateInput): Promise<SendResult> {
  const { phoneNumberId } = requireCredentials();
  const { to, dryRun } = resolveRecipientForSend(input.to);

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: to.replace(/\D/g, ""),
    type: "template",
    template: {
      name: input.templateName,
      language: { code: input.language },
      components: input.bodyParameters.length
        ? [
            {
              type: "body",
              parameters: input.bodyParameters.map((value) => ({ type: "text", text: value })),
            },
          ]
        : undefined,
    },
  };

  const response = await graphRequest<{
    messages?: Array<{ id: string }>;
  }>(`/${phoneNumberId}/messages`, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  const messageId = response.messages?.[0]?.id;
  if (!messageId) {
    throw new ApiError("Meta did not return a message id for the template send.", 502);
  }
  return { messageId, dryRun };
}

/** Send a free-form text reply. Caller must verify the 24h window is open. */
export async function sendText(input: { to: string; body: string }): Promise<SendResult> {
  const { phoneNumberId } = requireCredentials();
  const { to, dryRun } = resolveRecipientForSend(input.to);

  const response = await graphRequest<{
    messages?: Array<{ id: string }>;
  }>(`/${phoneNumberId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to.replace(/\D/g, ""),
      type: "text",
      text: { preview_url: false, body: input.body },
    }),
  });

  const messageId = response.messages?.[0]?.id;
  if (!messageId) {
    throw new ApiError("Meta did not return a message id for the text send.", 502);
  }
  return { messageId, dryRun };
}

/** Send a free-form interactive button message (reply buttons, ≤3). Caller
 *  must verify the 24h window is open. */
export async function sendInteractiveButtons(input: {
  to: string;
  body: string;
  buttons: Array<{ id: string; title: string }>;
}): Promise<SendResult> {
  if (input.buttons.length === 0 || input.buttons.length > 3) {
    throw new ApiError("Interactive button sends require 1–3 buttons.", 400);
  }
  const { phoneNumberId } = requireCredentials();
  const { to, dryRun } = resolveRecipientForSend(input.to);

  const response = await graphRequest<{
    messages?: Array<{ id: string }>;
  }>(`/${phoneNumberId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to.replace(/\D/g, ""),
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: input.body.slice(0, 1024) },
        action: {
          buttons: input.buttons.map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title.slice(0, 20) },
          })),
        },
      },
    }),
  });

  const messageId = response.messages?.[0]?.id;
  if (!messageId) {
    throw new ApiError("Meta did not return a message id for the interactive send.", 502);
  }
  return { messageId, dryRun };
}

/** Best-effort mark-as-read for an inbound message. Failure is non-fatal — we
 *  do not throw because failing to mark a message read shouldn't block the
 *  agent reply path. */
export async function markRead(input: { messageId: string }): Promise<void> {
  try {
    const { phoneNumberId } = requireCredentials();
    await graphRequest(`/${phoneNumberId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: input.messageId,
      }),
    });
  } catch (error) {
    console.warn("[coworker] markRead failed:", error);
  }
}

// ── Webhook signature verification ─────────────────────────────

/** Verify Meta's X-Hub-Signature-256 on the inbound webhook. Fails closed
 *  when COWORKER_APP_SECRET is unset — mirrors the per-restaurant webhook
 *  hardening in lib/whatsapp-business.ts. */
export function verifyWebhookSignature(rawBody: string, signature: string | undefined | null): boolean {
  if (!env.COWORKER_APP_SECRET) {
    return false;
  }
  if (!signature?.startsWith("sha256=")) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", env.COWORKER_APP_SECRET)
    .update(rawBody)
    .digest("hex");
  const received = signature.slice("sha256=".length);

  let expectedBuf: Buffer;
  let receivedBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expected, "hex");
    receivedBuf = Buffer.from(received, "hex");
  } catch {
    return false;
  }
  if (expectedBuf.length === 0 || expectedBuf.length !== receivedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

// ── Webhook payload helpers ────────────────────────────────────

export function extractInboundMessageBody(message: Record<string, unknown>): string {
  const type = (message as { type?: string }).type;
  if (type === "text") {
    return ((message as { text?: { body?: string } }).text?.body ?? "").trim();
  }
  if (type === "button") {
    return ((message as { button?: { text?: string } }).button?.text ?? "").trim();
  }
  if (type === "interactive") {
    const interactive = (message as { interactive?: Record<string, any> }).interactive ?? {};
    return (
      interactive.button_reply?.title ??
      interactive.list_reply?.title ??
      "[interactive]"
    );
  }
  if (type && typeof (message as Record<string, any>)[type] === "object") {
    const sub = (message as Record<string, any>)[type];
    if (sub?.caption) return String(sub.caption);
  }
  return type ? `[${type}]` : "[message]";
}

export function extractInboundButtonPayload(message: Record<string, unknown>): string | null {
  const type = (message as { type?: string }).type;
  if (type !== "interactive") return null;
  const interactive = (message as { interactive?: Record<string, any> }).interactive ?? {};
  return interactive.button_reply?.id ?? interactive.list_reply?.id ?? null;
}

export function mapStatusToCoworker(status: string | undefined): "sent" | "delivered" | "read" | "failed" | "queued" {
  if (status === "sent") return "sent";
  if (status === "delivered") return "delivered";
  if (status === "read") return "read";
  if (status === "failed") return "failed";
  return "queued";
}

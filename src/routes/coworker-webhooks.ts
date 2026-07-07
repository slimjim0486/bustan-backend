// Inbound webhook for the Bustan on WhatsApp number. Separate from
// /api/webhooks/whatsapp (which handles per-restaurant ordering integrations).
// Mounted at /api/webhooks/coworker.
//
// Meta verification flow:
//   GET  /api/webhooks/coworker?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
//   POST /api/webhooks/coworker  (X-Hub-Signature-256: sha256=...)
//
// Inbound message routing:
//   1. Verify signature (fails closed when COWORKER_APP_SECRET unset)
//   2. Resolve CoworkerOwner by `from` E.164 — ignore unknown numbers
//   3. Open 24h window
//   4. Persist inbound row
//   5. VERIFY/START proves control of the enrolled phone and activates it
//   6. STOP/START → pause / resume, send confirmation
//   7. Button payload → routeButtonPayload → either canned reply or agent prompt
//   8. Free text → runAgentTurn → send reply text
//
// Status webhooks (delivered/read/failed) update CoworkerMessage.

import { Hono } from "hono";
import { env } from "@/lib/env";
import {
  extractInboundButtonPayload,
  extractInboundMessageBody,
  mapStatusToCoworker,
  markRead,
  verifyWebhookSignature,
} from "@/lib/coworker/meta-client";
import { normalizeE164Phone } from "@/lib/whatsapp-business";
import { prisma } from "@/lib/prisma";
import { routeButtonPayload, runAgentTurn } from "@/services/coworker/agent";
import { sendCoworkerText } from "@/services/coworker/sender";

const WINDOW_MS = 24 * 60 * 60 * 1000;

function ack(): Response {
  // Meta requires a 200 within ~15s, otherwise it retries. We ALWAYS 200
  // after signature pass — failures during handling are logged but never
  // re-raised (a retry would just duplicate the LLM run).
  return new Response("ok", { status: 200 });
}

function getConsentCommand(body: string | null | undefined): "opt_in" | "opt_out" | null {
  const n = body?.trim().toLowerCase();
  if (!n) return null;
  if (["stop", "unsubscribe", "opt out", "opt-out", "cancel", "pause"].includes(n)) return "opt_out";
  if (["start", "resume", "subscribe", "opt in", "opt-in"].includes(n)) return "opt_in";
  return null;
}

function isVerificationCommand(body: string | null | undefined): boolean {
  const n = body?.trim().toLowerCase();
  return Boolean(n && ["verify", "verify bustan", "activate", "activate bustan"].includes(n));
}

export const coworkerWebhooksRoute = new Hono()
  // ── Meta verification handshake ──
  .get("/coworker", (c) => {
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");

    if (
      mode === "subscribe" &&
      token &&
      env.COWORKER_WEBHOOK_VERIFY_TOKEN &&
      token === env.COWORKER_WEBHOOK_VERIFY_TOKEN
    ) {
      return c.text(challenge ?? "ok", 200);
    }
    return c.text("forbidden", 403);
  })
  // ── Inbound events ──
  .post("/coworker", async (c) => {
    if (!env.COWORKER_ENABLED) {
      // Feature off — silently 200 so Meta doesn't think we're broken.
      return ack();
    }

    const rawBody = await c.req.text();
    const signature = c.req.header("x-hub-signature-256");
    if (!verifyWebhookSignature(rawBody, signature)) {
      return c.text("forbidden", 403);
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.text("bad json", 400);
    }

    const entries: any[] = Array.isArray(payload?.entry) ? payload.entry : [];
    for (const entry of entries) {
      const changes: any[] = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const change of changes) {
        const value = change?.value ?? {};
        try {
          await handleChange(value);
        } catch (e) {
          console.error("[coworker-webhook] handler failed", e);
        }
      }
    }
    return ack();
  });

async function handleChange(value: any) {
  // Status events (delivered / read / failed)
  if (Array.isArray(value.statuses)) {
    for (const status of value.statuses) {
      await applyStatusEvent(status);
    }
  }

  // Inbound messages
  if (Array.isArray(value.messages)) {
    const contacts: any[] = Array.isArray(value.contacts) ? value.contacts : [];
    for (const message of value.messages) {
      const contact = contacts.find((c) => c?.wa_id === message.from);
      await handleInboundMessage({ message, contactName: contact?.profile?.name ?? null });
    }
  }
}

async function applyStatusEvent(status: any) {
  const providerMessageId: string | undefined = status?.id;
  if (!providerMessageId) return;

  const mapped = mapStatusToCoworker(status.status);
  const occurredAt = (() => {
    const sec = Number(status.timestamp);
    return Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000) : new Date();
  })();

  const data: {
    status: typeof mapped;
    deliveredAt?: Date;
    readAt?: Date;
    failedAt?: Date;
    errorCode?: string;
    errorMessage?: string;
  } = { status: mapped };

  if (mapped === "delivered") data.deliveredAt = occurredAt;
  if (mapped === "read") data.readAt = occurredAt;
  if (mapped === "failed") {
    data.failedAt = occurredAt;
    const err = Array.isArray(status.errors) ? status.errors[0] : null;
    if (err?.code) data.errorCode = String(err.code);
    if (err?.title || err?.message) data.errorMessage = String(err.title ?? err.message).slice(0, 1000);
  }

  await prisma.coworkerMessage.updateMany({
    where: { providerMessageId },
    data,
  });
}

async function handleInboundMessage(input: {
  message: any;
  contactName: string | null;
}) {
  const fromPhone = normalizeE164Phone(String(input.message.from ?? ""));
  if (!fromPhone) return;
  const messageId = input.message.id as string | undefined;

  const owner = await prisma.coworkerOwner.findUnique({
    where: { ownerPhoneE164: fromPhone },
    include: { restaurant: { select: { id: true } }, owner: { select: { clerkId: true } } },
  });

  if (!owner) {
    // Unknown sender — log + ignore. Don't reply (no opt-in).
    console.log(`[coworker-webhook] inbound from unknown ${fromPhone} ignored`);
    return;
  }

  const body = extractInboundMessageBody(input.message);
  const buttonPayload = extractInboundButtonPayload(input.message);

  // Persist inbound, regardless of action, for audit trail
  const inboundRow = await prisma.coworkerMessage.create({
    data: {
      coworkerOwnerId: owner.id,
      restaurantId: owner.restaurantId,
      direction: "inbound",
      status: "received",
      body,
      providerMessageId: messageId,
      buttonPayload,
    },
  });

  // Open the 24h window
  const windowExpiresAt = new Date(Date.now() + WINDOW_MS);
  await prisma.coworkerOwner.update({
    where: { id: owner.id },
    data: { windowExpiresAt },
  });

  // Mark-as-read (best effort, non-blocking)
  if (messageId) {
    void markRead({ messageId });
  }

  // STOP/START
  const consent = getConsentCommand(body);
  if (consent === "opt_out") {
    await prisma.coworkerOwner.update({
      where: { id: owner.id },
      data: { status: "paused", pausedAt: new Date() },
    });
    await sendCoworkerText({
      coworkerOwnerId: owner.id,
      restaurantId: owner.restaurantId,
      body: "Paused. You won't get the daily brief or any nudges. Reply START anytime to resume.",
    });
    return;
  }
  if (consent === "opt_in") {
    await prisma.coworkerOwner.update({
      where: { id: owner.id },
      data: { status: "active", pausedAt: null },
    });
    await sendCoworkerText({
      coworkerOwnerId: owner.id,
      restaurantId: owner.restaurantId,
      body: "Verified. Bustan on WhatsApp is active for your restaurant. Your daily brief resumes tomorrow morning.",
    });
    return;
  }

  if (isVerificationCommand(body)) {
    await prisma.coworkerOwner.update({
      where: { id: owner.id },
      data: { status: "active", pausedAt: null, optedOutAt: null },
    });
    await sendCoworkerText({
      coworkerOwnerId: owner.id,
      restaurantId: owner.restaurantId,
      body: "Verified. Bustan on WhatsApp is active for your restaurant. You can now ask for numbers, drafts, menu edits, and next actions here.",
    });
    return;
  }

  if (owner.status === "pilot") {
    await sendCoworkerText({
      coworkerOwnerId: owner.id,
      restaurantId: owner.restaurantId,
      body: "To activate Bustan on WhatsApp for this restaurant, reply VERIFY from this phone.",
    });
    return;
  }

  if (owner.status === "paused" || owner.status === "opted_out") {
    await sendCoworkerText({
      coworkerOwnerId: owner.id,
      restaurantId: owner.restaurantId,
      body: "Bustan on WhatsApp is paused for this restaurant. Reply START when you want to resume.",
    });
    return;
  }

  // Button payloads
  if (buttonPayload) {
    const action = routeButtonPayload(buttonPayload);
    if (action) {
      if (action.kind === "reply") {
        await sendCoworkerText({
          coworkerOwnerId: owner.id,
          restaurantId: owner.restaurantId,
          body: action.text ?? "Got it.",
        });
        return;
      }
      if (action.kind === "prompt" && action.prompt) {
        const reply = await runAgentTurn({
          restaurantId: owner.restaurantId,
          clerkId: owner.owner.clerkId,
          message: action.prompt,
          messageId,
        });
        await sendCoworkerText({
          coworkerOwnerId: owner.id,
          restaurantId: owner.restaurantId,
          body: reply.text,
        });
        return;
      }
    }
  }

  // Free text → agent
  if (!body || body.startsWith("[") /* placeholder text */) {
    // Non-text content (image, audio etc) — ack but skip LLM for v1.
    await sendCoworkerText({
      coworkerOwnerId: owner.id,
      restaurantId: owner.restaurantId,
      body: "I got your message, but I can only handle text in this version. Try typing a question!",
    });
    return;
  }

  try {
    const reply = await runAgentTurn({
      restaurantId: owner.restaurantId,
      clerkId: owner.owner.clerkId,
      message: body,
      messageId,
    });
    await sendCoworkerText({
      coworkerOwnerId: owner.id,
      restaurantId: owner.restaurantId,
      body: reply.text,
    });
  } catch (e) {
    console.error("[coworker-webhook] agent failed", e);
    await sendCoworkerText({
      coworkerOwnerId: owner.id,
      restaurantId: owner.restaurantId,
      body: "Something hiccuped on my side. Try again in a moment, or message support if it keeps happening.",
    }).catch(() => {});
  }
}

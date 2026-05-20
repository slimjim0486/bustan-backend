// Central send pipeline. Every outbound to Meta goes through here so the
// CoworkerMessage row, idempotency key, dry-run rerouting, cost tracking, and
// error handling stay in one place.

import { Prisma } from "@prisma/client";
import { env } from "@/lib/env";
import {
  resolveRecipientForSend,
  sendInteractiveButtons,
  sendTemplate,
  sendText,
} from "@/lib/coworker/meta-client";
import {
  type CoworkerTemplateDefinition,
  renderTemplatePreview,
} from "@/lib/coworker/templates";
import { prisma } from "@/lib/prisma";

export interface SendTemplateBriefArgs {
  coworkerOwnerId: string;
  restaurantId: string;
  template: CoworkerTemplateDefinition;
  variables: string[];
  idempotencyKey: string;
}

export interface SendOutcome {
  messageId: string | null;
  dryRun: boolean;
  duplicated: boolean;
  status: "sent" | "failed" | "skipped_duplicate";
  errorMessage?: string;
}

/** Send a Daily Brief (or any template) — idempotent per `idempotencyKey`.
 *  A duplicate call returns `skipped_duplicate` instead of sending twice. */
export async function sendCoworkerTemplate(args: SendTemplateBriefArgs): Promise<SendOutcome> {
  const owner = await prisma.coworkerOwner.findUnique({
    where: { id: args.coworkerOwnerId },
  });
  if (!owner) {
    return { messageId: null, dryRun: false, duplicated: false, status: "failed", errorMessage: "Owner not found" };
  }
  if (owner.status === "opted_out" || owner.status === "paused") {
    return {
      messageId: null,
      dryRun: false,
      duplicated: false,
      status: "skipped_duplicate",
      errorMessage: `Owner status=${owner.status}`,
    };
  }

  const preview = renderTemplatePreview(args.template, args.variables);

  // Reserve the row first so we can reject duplicates atomically. The unique
  // index on idempotency_key means a second concurrent send for the same key
  // raises P2002 — we catch and return skipped_duplicate.
  let row;
  try {
    row = await prisma.coworkerMessage.create({
      data: {
        coworkerOwnerId: args.coworkerOwnerId,
        restaurantId: args.restaurantId,
        direction: "outbound",
        status: "queued",
        templateName: args.template.name,
        body: preview,
        idempotencyKey: args.idempotencyKey,
        costUsd: new Prisma.Decimal(env.COWORKER_UTILITY_COST_USD),
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return {
        messageId: null,
        dryRun: false,
        duplicated: true,
        status: "skipped_duplicate",
      };
    }
    throw error;
  }

  // Compute dry-run BEFORE sending so we record what the owner *would have*
  // received, plus the actual recipient envelope (which during dry-run is the
  // pilot phone). resolveRecipientForSend is the only place the env flag is read.
  const { dryRun } = resolveRecipientForSend(owner.ownerPhoneE164);

  try {
    const result = await sendTemplate({
      to: owner.ownerPhoneE164,
      templateName: args.template.name,
      language: args.template.locale,
      bodyParameters: args.variables,
    });
    await prisma.coworkerMessage.update({
      where: { id: row.id },
      data: {
        status: "sent",
        providerMessageId: result.messageId,
        sentAt: new Date(),
        dryRun: result.dryRun,
      },
    });
    return { messageId: result.messageId, dryRun: result.dryRun, duplicated: false, status: "sent" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.coworkerMessage.update({
      where: { id: row.id },
      data: {
        status: "failed",
        failedAt: new Date(),
        errorMessage: message.slice(0, 1000),
        dryRun,
      },
    });
    return { messageId: null, dryRun, duplicated: false, status: "failed", errorMessage: message };
  }
}

/** Free-form reply inside the 24h window — used by the inbound agent loop.
 *  Caller MUST have already verified `coworkerOwner.windowExpiresAt > now`. */
export async function sendCoworkerText(args: {
  coworkerOwnerId: string;
  restaurantId: string;
  body: string;
}): Promise<SendOutcome> {
  const owner = await prisma.coworkerOwner.findUnique({
    where: { id: args.coworkerOwnerId },
  });
  if (!owner) {
    return { messageId: null, dryRun: false, duplicated: false, status: "failed", errorMessage: "Owner not found" };
  }
  if (!owner.windowExpiresAt || owner.windowExpiresAt < new Date()) {
    return {
      messageId: null,
      dryRun: false,
      duplicated: false,
      status: "failed",
      errorMessage: "24h customer-service window closed; only templates allowed.",
    };
  }

  const row = await prisma.coworkerMessage.create({
    data: {
      coworkerOwnerId: args.coworkerOwnerId,
      restaurantId: args.restaurantId,
      direction: "outbound",
      status: "queued",
      body: args.body,
      // Free-form sends inside the window are free per Meta service-conversation pricing.
      costUsd: null,
    },
  });

  try {
    const result = await sendText({ to: owner.ownerPhoneE164, body: args.body });
    await prisma.coworkerMessage.update({
      where: { id: row.id },
      data: {
        status: "sent",
        providerMessageId: result.messageId,
        sentAt: new Date(),
        dryRun: result.dryRun,
      },
    });
    return { messageId: result.messageId, dryRun: result.dryRun, duplicated: false, status: "sent" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.coworkerMessage.update({
      where: { id: row.id },
      data: {
        status: "failed",
        failedAt: new Date(),
        errorMessage: message.slice(0, 1000),
      },
    });
    return { messageId: null, dryRun: false, duplicated: false, status: "failed", errorMessage: message };
  }
}

/** Free-form reply with quick-reply buttons (1–3). Same window rule as text. */
export async function sendCoworkerButtons(args: {
  coworkerOwnerId: string;
  restaurantId: string;
  body: string;
  buttons: Array<{ id: string; title: string }>;
}): Promise<SendOutcome> {
  const owner = await prisma.coworkerOwner.findUnique({
    where: { id: args.coworkerOwnerId },
  });
  if (!owner) {
    return { messageId: null, dryRun: false, duplicated: false, status: "failed", errorMessage: "Owner not found" };
  }
  if (!owner.windowExpiresAt || owner.windowExpiresAt < new Date()) {
    return {
      messageId: null,
      dryRun: false,
      duplicated: false,
      status: "failed",
      errorMessage: "24h window closed.",
    };
  }

  const row = await prisma.coworkerMessage.create({
    data: {
      coworkerOwnerId: args.coworkerOwnerId,
      restaurantId: args.restaurantId,
      direction: "outbound",
      status: "queued",
      body: args.body,
      costUsd: null,
    },
  });

  try {
    const result = await sendInteractiveButtons({
      to: owner.ownerPhoneE164,
      body: args.body,
      buttons: args.buttons,
    });
    await prisma.coworkerMessage.update({
      where: { id: row.id },
      data: {
        status: "sent",
        providerMessageId: result.messageId,
        sentAt: new Date(),
        dryRun: result.dryRun,
      },
    });
    return { messageId: result.messageId, dryRun: result.dryRun, duplicated: false, status: "sent" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.coworkerMessage.update({
      where: { id: row.id },
      data: {
        status: "failed",
        failedAt: new Date(),
        errorMessage: message.slice(0, 1000),
      },
    });
    return { messageId: null, dryRun: false, duplicated: false, status: "failed", errorMessage: message };
  }
}

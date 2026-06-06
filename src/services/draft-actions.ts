// Sous Chef draft-action service.
//
// Persistent home for every action Sous Chef drafts on the owner's behalf.
// Chat tools, page macros, and existing crons (event-stager, sabt-pack,
// gsc-sync) all write through createDraft. Approval moves a draft into the
// Scheduled section with a 60s grace window before the worker executes it,
// giving the owner an Undo affordance with no extra infra.

import type { DraftAction, PromotionType } from "@prisma/client";
import { DraftActionKind, DraftActionStatus, DraftActionSource, Prisma } from "@prisma/client";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { executeCampaignSend } from "@/services/campaign-send";
import { getRestaurantEntitlements } from "@/lib/entitlements";
import { briefInputSchema } from "@/services/ad-studio-ai";
import {
  enforceGenerateRateLimit,
  enforceGlobalBudget,
} from "@/services/ad-studio-ai/guards";
import { enqueueAdStudioGeneration } from "@/queue/ad-studio-jobs";
import { checkAiLimit, logAiUsage } from "@/lib/ai-usage";
import { enqueueMenuItemImage } from "@/queue/image-generation";
import {
  ensurePrimaryImageRecord,
  getNextImageSlot,
  syncMenuItemImageSummary,
} from "@/lib/menu-item-images";

// 14-day TTL for drafts that sit in pending without a decision.
const DEFAULT_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;
// 60s grace window between approve and ship so the owner can undo.
export const APPROVE_TO_SHIP_GRACE_MS = 60 * 1000;

// Sending WhatsApp messages to customers is irreversible — give the owner a
// longer rope on those. Everything else keeps the standard 60s.
const ACTION_TYPE_GRACE_MS: Record<string, number> = {
  whatsapp_campaign_send: 5 * 60 * 1000,
};

export function getApproveToShipGraceMs(actionType: string): number {
  return ACTION_TYPE_GRACE_MS[actionType] ?? APPROVE_TO_SHIP_GRACE_MS;
}
// UAE is UTC+4 year-round (no DST). All "today" cutoffs in the Inbox follow
// the owner's calendar, not the Railway-box UTC clock.
const GST_OFFSET_MS = 4 * 60 * 60 * 1000;

function startOfTodayGst(now = new Date()): Date {
  const gstNow = new Date(now.getTime() + GST_OFFSET_MS);
  // Truncate to the start of the GST calendar day, then convert back to UTC.
  const gstMidnight = Date.UTC(
    gstNow.getUTCFullYear(),
    gstNow.getUTCMonth(),
    gstNow.getUTCDate()
  );
  return new Date(gstMidnight - GST_OFFSET_MS);
}

function startOfMonthGst(now = new Date()): Date {
  const gstNow = new Date(now.getTime() + GST_OFFSET_MS);
  const gstFirst = Date.UTC(gstNow.getUTCFullYear(), gstNow.getUTCMonth(), 1);
  return new Date(gstFirst - GST_OFFSET_MS);
}

/**
 * The `ownerUserId` column on DraftAction stores `User.id` (Prisma cuid),
 * matching the convention used elsewhere in the schema (SupportTicket,
 * OwnerWhisper, Restaurant.ownerId). Callers pass the Clerk subject; we
 * resolve once and reuse.
 */
async function resolveUserIdFromClerk(clerkId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true },
  });
  if (!user) {
    throw new ApiError("User not found for current session", 401);
  }
  return user.id;
}

export interface CreateDraftParams {
  kind?: DraftActionKind;
  actionType: string;
  source: DraftActionSource;
  title: string;
  subtitle?: string | null;
  iconKey?: string | null;
  affectedSurface?: string | null;
  payload: Prisma.InputJsonValue;
  preview: Prisma.InputJsonValue;
  childCount?: number;
  estimatedImpact?: Prisma.InputJsonValue | null;
  parentDraftId?: string | null;
  adProjectId?: string | null;
  campaignId?: string | null;
  menuItemId?: string | null;
  expiresAt?: Date;
}

async function insertDraftRow(
  restaurantId: string,
  ownerUserId: string,
  params: CreateDraftParams
): Promise<DraftAction> {
  return prisma.draftAction.create({
    data: {
      restaurantId,
      ownerUserId,
      kind: params.kind ?? DraftActionKind.single,
      actionType: params.actionType,
      source: params.source,
      title: params.title,
      subtitle: params.subtitle ?? null,
      iconKey: params.iconKey ?? null,
      affectedSurface: params.affectedSurface ?? null,
      payload: params.payload,
      preview: params.preview,
      childCount: params.childCount ?? 0,
      estimatedImpact: params.estimatedImpact ?? Prisma.JsonNull,
      parentDraftId: params.parentDraftId ?? null,
      adProjectId: params.adProjectId ?? null,
      campaignId: params.campaignId ?? null,
      menuItemId: params.menuItemId ?? null,
      expiresAt: params.expiresAt ?? new Date(Date.now() + DEFAULT_EXPIRY_MS),
    },
  });
}

export async function createDraft(
  restaurantId: string,
  clerkId: string,
  params: CreateDraftParams
): Promise<DraftAction> {
  const ownerUserId = await resolveUserIdFromClerk(clerkId);
  return insertDraftRow(restaurantId, ownerUserId, params);
}

/**
 * System-initiated drafts (background crons like event-stager, sabt-pack,
 * gsc-sync). Callers already have a User.id in hand from their Restaurant
 * lookup, so we skip the clerkId → User.id translation. Source must be a
 * non-owner-initiated source (event_stager / sabt_pack / gsc_sync / page_macro).
 */
export async function createSystemDraft(
  restaurantId: string,
  ownerUserId: string,
  params: CreateDraftParams
): Promise<DraftAction> {
  return insertDraftRow(restaurantId, ownerUserId, params);
}

/**
 * Idempotent system-draft creator for cron-mirrored entities. Returns the
 * existing draft if one already exists for the same (adProjectId, actionType)
 * pair — protects against:
 *   - duplicate rows when a cron retries (sabt-pack on email-failure retry)
 *   - permanently-missing rows when the first-day mirror crashes after the
 *     entity was created (event-stager would otherwise never re-attempt)
 *   - the daily cron resurrecting a draft the owner already acted on. The
 *     AdProject is the entity; once the owner has decided (approved → opened,
 *     or rejected → dismissed), nagging them again the next morning is noise.
 *
 * Statuses that block a new draft (any prior decision counts):
 *   pending / approved / scheduled / shipped / rejected
 *
 * Statuses that allow a fresh draft (owner never effectively saw the original):
 *   expired — TTL passed before they decided
 *   failed  — system error during ship; the work didn't actually happen
 *
 * Sabt-pack's adProjectId rotates weekly, so this dedupe doesn't suppress its
 * weekly cadence — each week's new AdProject row gets its own draft.
 */
export async function ensureSystemDraftForAdProject(
  restaurantId: string,
  ownerUserId: string,
  adProjectId: string,
  params: CreateDraftParams
): Promise<{ draft: DraftAction; created: boolean }> {
  const existing = await prisma.draftAction.findFirst({
    where: {
      restaurantId,
      adProjectId,
      actionType: params.actionType,
      status: {
        in: [
          DraftActionStatus.pending,
          DraftActionStatus.approved,
          DraftActionStatus.scheduled,
          DraftActionStatus.shipped,
          DraftActionStatus.rejected,
        ],
      },
    },
  });
  if (existing) {
    return { draft: existing, created: false };
  }
  const draft = await insertDraftRow(restaurantId, ownerUserId, {
    ...params,
    adProjectId,
  });
  return { draft, created: true };
}

/**
 * Result of an approve call. `primary` is the draft the caller asked to
 * approve (returned to the HTTP client). `toShip` is the set of drafts that
 * the route needs to enqueue worker jobs for — one row for single/bulk
 * drafts; the parent + every child for bundles.
 */
export interface ApproveResult {
  primary: DraftAction;
  toShip: DraftAction[];
}

/**
 * Atomically transition a draft from pending → approved/scheduled. Uses
 * updateMany with a prior-status guard so concurrent approve clicks (or an
 * approve racing a reject) cannot double-fire. The first writer wins; later
 * writers see count=0 and surface a 409 Conflict.
 *
 * Bundle drafts (kind=bundle) cascade into a transaction that approves the
 * parent AND every child atomically — "Ship all (6)" must not half-fire if
 * the DB blips midway through.
 */
export async function approveDraft(
  draftId: string,
  restaurantId: string,
  clerkId: string,
  options: { shipAt?: Date } = {}
): Promise<ApproveResult> {
  const ownerUserId = await resolveUserIdFromClerk(clerkId);
  const status = options.shipAt ? DraftActionStatus.scheduled : DraftActionStatus.approved;
  const now = new Date();

  // Branch on kind so the bundle path can cascade. Read kind+status+actionType
  // with one query so the race-loss path can still distinguish 404 vs 410 vs
  // 409, and so the grace window can be sized per actionType.
  const target = await prisma.draftAction.findFirst({
    where: { id: draftId, restaurantId },
    select: { id: true, kind: true, status: true, expiresAt: true, actionType: true },
  });

  if (!target) throw new ApiError("Draft not found", 404);
  if (target.status !== DraftActionStatus.pending) {
    throw new ApiError(`Cannot approve a draft in status "${target.status}"`, 409);
  }
  if (target.expiresAt < now) {
    throw new ApiError("This draft has expired. Ask Sous Chef to redraft it.", 410);
  }

  // An explicit caller-supplied shipAt always wins; otherwise the grace window
  // is sized by the draft's own actionType (whatsapp_campaign_send gets 5min).
  const shipAt =
    options.shipAt ?? new Date(now.getTime() + getApproveToShipGraceMs(target.actionType));

  if (target.kind === DraftActionKind.bundle) {
    return approveBundleDraft({
      draftId,
      restaurantId,
      ownerUserId,
      shipAt,
      status,
      now,
      explicitShipAt: options.shipAt,
    });
  }

  const result = await prisma.draftAction.updateMany({
    where: {
      id: draftId,
      restaurantId,
      status: DraftActionStatus.pending,
      expiresAt: { gt: now },
    },
    data: { status, decisionAt: now, decidedBy: ownerUserId, shipAt },
  });

  if (result.count === 0) {
    // Race-loss between read above and update — surface a 409.
    throw new ApiError("Draft state changed mid-approve, please retry", 409);
  }

  const refreshed = await prisma.draftAction.findUnique({ where: { id: draftId } });
  if (!refreshed) throw new ApiError("Draft not found after approve", 500);
  return { primary: refreshed, toShip: [refreshed] };
}

async function approveBundleDraft(args: {
  draftId: string;
  restaurantId: string;
  ownerUserId: string;
  shipAt: Date;
  status: DraftActionStatus;
  now: Date;
  // When the caller pinned an explicit shipAt, every row (parent + children)
  // uses it verbatim. When absent, each child gets a grace sized by its OWN
  // actionType so a whatsapp_campaign_send child still earns its 5-min undo
  // even inside a bundle.
  explicitShipAt?: Date;
}): Promise<ApproveResult> {
  const { draftId, restaurantId, ownerUserId, shipAt, status, now, explicitShipAt } = args;

  const { primary, children } = await prisma.$transaction(async (tx) => {
    const parentUpdate = await tx.draftAction.updateMany({
      where: {
        id: draftId,
        restaurantId,
        status: DraftActionStatus.pending,
        expiresAt: { gt: now },
      },
      data: { status, decisionAt: now, decidedBy: ownerUserId, shipAt },
    });
    if (parentUpdate.count === 0) {
      throw new ApiError("Bundle state changed mid-approve, please retry", 409);
    }

    // Cascade to children: only pending children get approved. Children in
    // other terminal states (already rejected one before approving the
    // bundle) are left alone — owner explicitly chose to skip them. Group the
    // update by actionType so each child's shipAt reflects its own grace
    // window (no extra reads in the common single-grace case).
    const pendingChildren = await tx.draftAction.findMany({
      where: {
        parentDraftId: draftId,
        restaurantId,
        status: DraftActionStatus.pending,
      },
      select: { id: true, actionType: true },
    });
    const childIdsByGrace = new Map<number, string[]>();
    for (const child of pendingChildren) {
      const graceMs = explicitShipAt
        ? -1 // sentinel: use the pinned shipAt for everything
        : getApproveToShipGraceMs(child.actionType);
      const bucket = childIdsByGrace.get(graceMs) ?? [];
      bucket.push(child.id);
      childIdsByGrace.set(graceMs, bucket);
    }
    for (const [graceMs, ids] of childIdsByGrace) {
      const childShipAt = graceMs < 0 ? shipAt : new Date(now.getTime() + graceMs);
      await tx.draftAction.updateMany({
        where: { id: { in: ids }, restaurantId, status: DraftActionStatus.pending },
        data: { status, decisionAt: now, decidedBy: ownerUserId, shipAt: childShipAt },
      });
    }

    const refreshedParent = await tx.draftAction.findUnique({ where: { id: draftId } });
    const refreshedChildren = await tx.draftAction.findMany({
      where: {
        parentDraftId: draftId,
        status: { in: [DraftActionStatus.approved, DraftActionStatus.scheduled] },
      },
    });
    return { primary: refreshedParent!, children: refreshedChildren };
  });

  // Parent ships first (as a coordination no-op), then children fire in
  // parallel at the same shipAt. Order in toShip doesn't matter for the
  // worker (jobs run independently) but keeping the parent first makes the
  // History view's "shipped at" timestamps tell a coherent story.
  return { primary, toShip: [primary, ...children] };
}

export async function rejectDraft(
  draftId: string,
  restaurantId: string,
  clerkId: string,
  reason?: string
): Promise<DraftAction> {
  const ownerUserId = await resolveUserIdFromClerk(clerkId);
  const now = new Date();
  const ACTIVE_STATUSES = [
    DraftActionStatus.pending,
    DraftActionStatus.approved,
    DraftActionStatus.scheduled,
  ] as const;

  // Bundle reject MUST cascade. Without this, owner approves a bundle at T=0,
  // rejects the parent at T=30s — and the 3 children's pg-boss jobs still fire
  // at T=60s because shipDraft only checks the child's own status. Result:
  // owner explicitly said no, system did it anyway.
  const target = await prisma.draftAction.findFirst({
    where: { id: draftId, restaurantId },
    select: { kind: true, status: true },
  });
  if (!target) throw new ApiError("Draft not found", 404);
  if (!ACTIVE_STATUSES.includes(target.status as (typeof ACTIVE_STATUSES)[number])) {
    throw new ApiError(`Cannot reject a draft in status "${target.status}"`, 409);
  }

  const refreshed = await prisma.$transaction(async (tx) => {
    const parentUpdate = await tx.draftAction.updateMany({
      where: { id: draftId, restaurantId, status: { in: [...ACTIVE_STATUSES] } },
      data: {
        status: DraftActionStatus.rejected,
        decisionAt: now,
        decidedBy: ownerUserId,
        rejectionReason: reason ?? null,
        shipAt: null,
      },
    });
    if (parentUpdate.count === 0) {
      throw new ApiError("Draft state changed mid-reject, please retry", 409);
    }

    if (target.kind === DraftActionKind.bundle) {
      // Cascade to every still-active child. Children already in shipped /
      // rejected / failed are left alone (terminal states).
      await tx.draftAction.updateMany({
        where: {
          parentDraftId: draftId,
          restaurantId,
          status: { in: [...ACTIVE_STATUSES] },
        },
        data: {
          status: DraftActionStatus.rejected,
          decisionAt: now,
          decidedBy: ownerUserId,
          rejectionReason: reason ? `Parent bundle rejected: ${reason}` : "Parent bundle rejected",
          shipAt: null,
        },
      });
    }

    // Per-actionType cleanup. Lives in the same transaction so a reject +
    // dependent-state rollback either both succeed or both abort.
    await onDraftRejected(tx, draftId, restaurantId);

    return tx.draftAction.findUnique({ where: { id: draftId } });
  });

  if (!refreshed) throw new ApiError("Draft not found after reject", 500);
  return refreshed;
}

export async function cancelScheduledDraft(
  draftId: string,
  restaurantId: string
): Promise<DraftAction> {
  const APPROVED_OR_SCHEDULED = [
    DraftActionStatus.approved,
    DraftActionStatus.scheduled,
  ] as const;

  const target = await prisma.draftAction.findFirst({
    where: { id: draftId, restaurantId },
    select: { kind: true, status: true },
  });
  if (!target) throw new ApiError("Draft not found", 404);
  if (
    !APPROVED_OR_SCHEDULED.includes(
      target.status as (typeof APPROVED_OR_SCHEDULED)[number]
    )
  ) {
    throw new ApiError(
      `Only approved or scheduled drafts can be undone (status: ${target.status})`,
      409
    );
  }

  // Bundle Undo MUST cascade. Otherwise: owner approves bundle, sees Undo
  // toast, taps Undo at T=10s — parent flips back to pending but children's
  // T=60s ship jobs still fire because shipDraft only checks each child's
  // own status. The Undo button effectively becomes a lie.
  const refreshed = await prisma.$transaction(async (tx) => {
    const parentUpdate = await tx.draftAction.updateMany({
      where: { id: draftId, restaurantId, status: { in: [...APPROVED_OR_SCHEDULED] } },
      data: {
        status: DraftActionStatus.pending,
        decisionAt: null,
        decidedBy: null,
        shipAt: null,
      },
    });
    if (parentUpdate.count === 0) {
      throw new ApiError("Draft state changed mid-undo, please retry", 409);
    }

    if (target.kind === DraftActionKind.bundle) {
      await tx.draftAction.updateMany({
        where: {
          parentDraftId: draftId,
          restaurantId,
          status: { in: [...APPROVED_OR_SCHEDULED] },
        },
        data: {
          status: DraftActionStatus.pending,
          decisionAt: null,
          decidedBy: null,
          shipAt: null,
        },
      });
    }

    return tx.draftAction.findUnique({ where: { id: draftId } });
  });

  if (!refreshed) throw new ApiError("Draft not found after undo", 500);
  return refreshed;
}

/**
 * Per-actionType post-reject cleanup. Some shippers carry external state
 * (e.g. review_reply optimistically flips GbpReview.status to draft_pending
 * when the draft is created); rejection has to reverse that so the same
 * review doesn't get stuck unable-to-be-redrafted.
 */
async function onDraftRejected(
  tx: Prisma.TransactionClient,
  draftId: string,
  restaurantId: string
): Promise<void> {
  const draft = await tx.draftAction.findUnique({
    where: { id: draftId },
    select: { actionType: true, payload: true, kind: true },
  });
  if (!draft) return;

  // Bundles: cleanup is fanned out as each child's reject cascade fires its
  // own onDraftRejected via the updateMany above (status flipped to rejected
  // synchronously). For non-bundle review_reply parents, reset every targeted
  // GbpReview back to unanswered so the owner can ask again.
  if (draft.actionType === "review_reply") {
    const payload = draft.payload as { items?: Array<{ reviewId?: string }> };
    const reviewIds = (payload.items ?? [])
      .map((i) => i.reviewId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (reviewIds.length > 0) {
      await tx.gbpReview.updateMany({
        where: {
          id: { in: reviewIds },
          restaurantId,
          status: "draft_pending",
        },
        data: { status: "unanswered", draftedAt: null },
      });
    }
  }
}

/**
 * Inline edit — deliberately restricts this to cosmetic fields
 * (title, subtitle). Allowing arbitrary payload edits would let an owner
 * (or a bug) steer a draft at a different menu item / promotion; per-
 * actionType validation lands in Phase 2 when the Edit affordance is wired.
 */
export async function updateDraftPayload(
  draftId: string,
  restaurantId: string,
  next: { title?: string; subtitle?: string | null }
): Promise<DraftAction> {
  const result = await prisma.draftAction.updateMany({
    where: { id: draftId, restaurantId, status: DraftActionStatus.pending },
    data: {
      ...(next.title !== undefined && { title: next.title }),
      ...(next.subtitle !== undefined && { subtitle: next.subtitle }),
    },
  });

  if (result.count === 0) {
    const current = await prisma.draftAction.findFirst({
      where: { id: draftId, restaurantId },
      select: { status: true },
    });
    if (!current) throw new ApiError("Draft not found", 404);
    throw new ApiError(
      `Only pending drafts can be edited (status: ${current.status})`,
      409
    );
  }

  const refreshed = await prisma.draftAction.findUnique({ where: { id: draftId } });
  if (!refreshed) throw new ApiError("Draft not found after edit", 500);
  return refreshed;
}

// ── shipDraft — the dispatcher ──────────────────────────────────────────────

interface ShipResult {
  ok: boolean;
  message?: string;
  data?: Record<string, unknown>;
}

export async function shipDraft(draftId: string): Promise<ShipResult> {
  const draft = await prisma.draftAction.findUnique({ where: { id: draftId } });
  if (!draft) return { ok: false, message: "Draft missing at ship time" };
  if (
    draft.status !== DraftActionStatus.approved &&
    draft.status !== DraftActionStatus.scheduled
  ) {
    return { ok: false, message: `Draft is in status "${draft.status}", not shippable` };
  }
  if (draft.expiresAt < new Date()) {
    await prisma.draftAction.update({
      where: { id: draftId },
      data: { status: DraftActionStatus.expired, shipError: "Draft expired before ship" },
    });
    return { ok: false, message: "Draft expired before ship" };
  }

  try {
    const result = await dispatchShip(draft);
    const shipResult: Prisma.InputJsonValue = {
      message: result.message ?? null,
      data: (result.data ?? null) as Prisma.InputJsonValue,
    };
    await prisma.draftAction.update({
      where: { id: draftId },
      data: {
        status: DraftActionStatus.shipped,
        shippedAt: new Date(),
        shipResult,
      },
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.draftAction.update({
      where: { id: draftId },
      data: {
        status: DraftActionStatus.failed,
        shipError: message,
      },
    });
    return { ok: false, message };
  }
}

async function dispatchShip(draft: DraftAction): Promise<ShipResult> {
  switch (draft.actionType) {
    case "menu_description":
      return shipMenuDescription(draft);
    case "price_change":
    case "menu_item_update":
      return shipMenuItemUpdate(draft);
    case "promotion_create":
      return shipPromotionCreate(draft);
    case "promotion_update":
      return shipPromotionUpdate(draft);
    case "menu_item_create":
      return shipMenuItemCreate(draft);
    case "menu_section_create":
      return shipMenuSectionCreate(draft);
    case "restaurant_profile_update":
      return shipRestaurantProfileUpdate(draft);
    case "publish_menu":
      return shipPublishMenu(draft);
    case "availability_toggle":
      return shipAvailabilityToggle(draft);
    case "menu_items_bulk_update":
      return shipMenuItemsBulkUpdate(draft);
    case "menu_descriptions_bulk":
      return shipMenuDescriptionsBulk(draft);
    case "dietary_tags_apply":
      return shipDietaryTagsApply(draft);
    case "review_reply":
      return shipReviewReply(draft);
    case "ad_project_review":
    case "sabt_pack_review":
    case "marketing_bundle":
      return shipReviewAcknowledgment(draft);
    case "ad_campaign_create":
      return shipAdCampaignCreate(draft);
    case "ad_campaign_create_and_generate":
      return shipAdCampaignCreateAndGenerate(draft);
    case "dish_images_generate":
      return shipDishImagesGenerate(draft);
    case "whatsapp_campaign_create":
      return shipWhatsappCampaignCreate(draft);
    case "whatsapp_campaign_send":
      return shipWhatsappCampaignSend(draft);
    default:
      throw new Error(`No shipper registered for actionType="${draft.actionType}"`);
  }
}

interface MenuDescriptionPayload {
  menuItemId: string;
  description: string;
}

async function shipMenuDescription(draft: DraftAction): Promise<ShipResult> {
  const payload = draft.payload as unknown as MenuDescriptionPayload;
  if (!payload?.menuItemId || typeof payload.description !== "string") {
    throw new Error("menu_description payload missing menuItemId or description");
  }

  // updateMany scoped by restaurantId so a tampered payload can't reach a
  // foreign tenant's menu item (defense-in-depth on top of route auth).
  const result = await prisma.menuItem.updateMany({
    where: { id: payload.menuItemId, restaurantId: draft.restaurantId },
    data: {
      description: payload.description,
      aiDescriptionStatus: "accepted",
    },
  });
  if (result.count === 0) {
    throw new Error("Target menu item not found in restaurant");
  }

  const item = await prisma.menuItem.findUnique({
    where: { id: payload.menuItemId },
    select: { id: true, name: true, description: true },
  });

  return {
    ok: true,
    message: `Updated description for "${item?.name ?? "menu item"}"`,
    data: { menuItemId: payload.menuItemId, description: item?.description ?? null },
  };
}

interface MenuItemUpdatePayload {
  menuItemId: string;
  name?: string;
  description?: string;
  price?: number;
  isAvailable?: boolean;
}

async function shipMenuItemUpdate(draft: DraftAction): Promise<ShipResult> {
  const payload = draft.payload as unknown as MenuItemUpdatePayload;
  if (!payload?.menuItemId) {
    throw new Error("menu_item_update payload missing menuItemId");
  }

  const data: Record<string, unknown> = {};
  if (payload.name !== undefined) data.name = payload.name;
  if (payload.description !== undefined) data.description = payload.description;
  if (payload.price !== undefined) data.price = new Prisma.Decimal(payload.price);
  if (payload.isAvailable !== undefined) {
    data.isAvailable = payload.isAvailable;
    data.soldOutDate = payload.isAvailable ? null : new Date();
  }

  if (Object.keys(data).length === 0) {
    throw new Error("menu_item_update payload had no fields to change");
  }

  const result = await prisma.menuItem.updateMany({
    where: { id: payload.menuItemId, restaurantId: draft.restaurantId },
    data,
  });
  if (result.count === 0) {
    throw new Error("Target menu item not found in restaurant");
  }

  const item = await prisma.menuItem.findUnique({
    where: { id: payload.menuItemId },
    select: { id: true, name: true, price: true },
  });

  return {
    ok: true,
    message: `Updated "${item?.name ?? "menu item"}"`,
    data: { menuItemId: payload.menuItemId, price: item?.price.toString() ?? null },
  };
}

interface PromotionCreatePayload {
  type: PromotionType;
  title: string;
  subtitle?: string | null;
  description?: string | null;
  badgeLabel?: string | null;
  terms?: string | null;
  promoPrice?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
  itemIds: string[];
  isFeatured?: boolean;
  // Calendar moment linkage (Ramadan, Eid, National Day, etc.). Optional —
  // populated when Sous Chef creates a promo from an event prompt.
  sourceMomentId?: string | null;
  sourceMomentYear?: number | null;
  sourceMomentStartsOn?: string | null;
}

async function shipPromotionCreate(draft: DraftAction): Promise<ShipResult> {
  const payload = draft.payload as unknown as PromotionCreatePayload;
  if (!payload?.title || !Array.isArray(payload.itemIds) || payload.itemIds.length === 0) {
    throw new Error("promotion_create payload missing title or itemIds");
  }

  // Filter the payload itemIds to only those that belong to this restaurant.
  // Mirrors the defense-in-depth on menu_item shippers — a tampered payload
  // can't attach a competitor's menu item to a promotion.
  const ownedItems = await prisma.menuItem.findMany({
    where: { id: { in: payload.itemIds }, restaurantId: draft.restaurantId },
    select: { id: true },
  });
  if (ownedItems.length === 0) {
    throw new Error("None of the requested menu items belong to this restaurant");
  }

  const created = await prisma.promotion.create({
    data: {
      restaurantId: draft.restaurantId,
      type: payload.type,
      title: payload.title,
      subtitle: payload.subtitle ?? null,
      description: payload.description ?? null,
      badgeLabel: payload.badgeLabel ?? null,
      terms: payload.terms ?? null,
      promoPrice: payload.promoPrice != null ? new Prisma.Decimal(payload.promoPrice) : null,
      startsAt: payload.startsAt ? new Date(payload.startsAt) : null,
      endsAt: payload.endsAt ? new Date(payload.endsAt) : null,
      sourceMomentId: payload.sourceMomentId ?? null,
      sourceMomentYear: payload.sourceMomentYear ?? null,
      sourceMomentStartsOn: payload.sourceMomentStartsOn ? new Date(payload.sourceMomentStartsOn) : null,
      isFeatured: payload.isFeatured ?? false,
      items: {
        create: ownedItems.map((m) => ({ menuItemId: m.id })),
      },
    },
    select: { id: true, title: true },
  });

  return {
    ok: true,
    message: `Created promotion "${created.title}"`,
    data: { promotionId: created.id, itemCount: ownedItems.length },
  };
}

interface PromotionUpdatePayload {
  promotionId: string;
  title?: string;
  subtitle?: string;
  description?: string;
  badgeLabel?: string;
  terms?: string;
  promoPrice?: number | null;
  startsAt?: string;
  endsAt?: string;
  isActive?: boolean;
  replaceItemIds?: string[];
}

async function shipPromotionUpdate(draft: DraftAction): Promise<ShipResult> {
  const payload = draft.payload as unknown as PromotionUpdatePayload;
  if (!payload?.promotionId) {
    throw new Error("promotion_update payload missing promotionId");
  }

  const promo = await prisma.promotion.findFirst({
    where: { id: payload.promotionId, restaurantId: draft.restaurantId },
    select: { id: true, title: true },
  });
  if (!promo) {
    return { ok: false, message: "Promotion no longer exists — it may have been deleted since this draft was created." };
  }

  const data: Prisma.PromotionUpdateInput = {};
  if (payload.title !== undefined) data.title = payload.title.trim();
  if (payload.subtitle !== undefined) data.subtitle = payload.subtitle;
  if (payload.description !== undefined) data.description = payload.description;
  if (payload.badgeLabel !== undefined) data.badgeLabel = payload.badgeLabel;
  if (payload.terms !== undefined) data.terms = payload.terms;
  if (payload.promoPrice !== undefined) {
    data.promoPrice = payload.promoPrice != null ? new Prisma.Decimal(payload.promoPrice) : null;
  }
  if (payload.startsAt !== undefined) data.startsAt = payload.startsAt ? new Date(payload.startsAt) : null;
  if (payload.endsAt !== undefined) data.endsAt = payload.endsAt ? new Date(payload.endsAt) : null;
  if (payload.isActive !== undefined) data.isActive = payload.isActive;

  await prisma.$transaction(async (tx) => {
    if (payload.replaceItemIds && payload.replaceItemIds.length > 0) {
      // Defense-in-depth: only re-attach items that belong to this restaurant,
      // mirroring shipPromotionCreate's tampered-payload guard.
      const owned = await tx.menuItem.findMany({
        where: { id: { in: payload.replaceItemIds }, restaurantId: draft.restaurantId },
        select: { id: true },
      });
      if (owned.length !== payload.replaceItemIds.length) {
        throw new Error("promotion_update payload contains items not belonging to this restaurant");
      }
      await tx.promotionItem.deleteMany({ where: { promotionId: promo.id } });
      data.items = {
        create: owned.map((m, index) => ({
          menuItemId: m.id,
          role: "included",
          displayOrder: index,
        })),
      };
    }
    await tx.promotion.update({ where: { id: promo.id }, data });
  });

  return {
    ok: true,
    message: payload.isActive === false ? `Promotion "${promo.title}" ended.` : `Promotion "${promo.title}" updated.`,
  };
}

interface MenuItemCreatePayload {
  sectionId: string;
  name: string;
  description?: string | null;
  price: number;
}

async function shipMenuItemCreate(draft: DraftAction): Promise<ShipResult> {
  const payload = draft.payload as unknown as MenuItemCreatePayload;
  if (!payload?.sectionId || !payload.name?.trim()) {
    throw new Error("menu_item_create payload missing sectionId or name");
  }
  if (!Number.isFinite(payload.price) || payload.price < 0) {
    throw new Error("menu_item_create payload has invalid price");
  }

  const section = await prisma.menuSection.findFirst({
    where: { id: payload.sectionId, restaurantId: draft.restaurantId },
    select: { id: true },
  });
  if (!section) throw new Error("Target section not found in restaurant");

  const maxOrder = await prisma.menuItem.aggregate({
    where: { sectionId: payload.sectionId },
    _max: { displayOrder: true },
  });

  const item = await prisma.menuItem.create({
    data: {
      restaurantId: draft.restaurantId,
      sectionId: payload.sectionId,
      name: payload.name,
      description: payload.description ?? null,
      price: new Prisma.Decimal(payload.price),
      currency: "AED",
      displayOrder: (maxOrder._max.displayOrder ?? -1) + 1,
    },
    select: { id: true, name: true },
  });

  return {
    ok: true,
    message: `"${item.name}" added to menu`,
    data: { menuItemId: item.id },
  };
}

interface MenuSectionCreatePayload {
  name: string;
}

async function shipMenuSectionCreate(draft: DraftAction): Promise<ShipResult> {
  const payload = draft.payload as unknown as MenuSectionCreatePayload;
  const name = payload?.name?.trim();
  if (!name) throw new Error("menu_section_create payload missing name");

  const maxOrder = await prisma.menuSection.aggregate({
    where: { restaurantId: draft.restaurantId },
    _max: { displayOrder: true },
  });

  const section = await prisma.menuSection.create({
    data: {
      restaurantId: draft.restaurantId,
      name,
      displayOrder: (maxOrder._max.displayOrder ?? -1) + 1,
    },
    select: { id: true, name: true },
  });

  return {
    ok: true,
    message: `Section "${section.name}" created`,
    data: { sectionId: section.id },
  };
}

interface RestaurantProfileUpdatePayload {
  description?: string;
  whatsappNumber?: string;
  location?: string;
  address?: string;
  phone?: string;
  website?: string;
}

async function shipRestaurantProfileUpdate(draft: DraftAction): Promise<ShipResult> {
  const payload = draft.payload as unknown as RestaurantProfileUpdatePayload;
  const data: Record<string, unknown> = {};
  if (payload.description !== undefined) data.description = payload.description;
  if (payload.whatsappNumber !== undefined) data.whatsappNumber = payload.whatsappNumber;
  if (payload.location !== undefined) data.location = payload.location;
  if (payload.address !== undefined) data.address = payload.address;
  if (payload.phone !== undefined) data.phone = payload.phone;
  if (payload.website !== undefined) data.website = payload.website;

  if (Object.keys(data).length === 0) {
    throw new Error("restaurant_profile_update payload had no fields to change");
  }

  await prisma.restaurant.update({ where: { id: draft.restaurantId }, data });
  return { ok: true, message: "Restaurant profile updated", data: { updated: Object.keys(data) } };
}

interface PublishMenuPayload {
  publish: boolean;
}

async function shipPublishMenu(draft: DraftAction): Promise<ShipResult> {
  const payload = draft.payload as unknown as PublishMenuPayload;
  // A missing/null `publish` key must NOT silently coerce to false and
  // unpublish a live restaurant — require an explicit boolean.
  if (typeof payload?.publish !== "boolean") {
    throw new Error("publish_menu payload missing required boolean 'publish'");
  }
  await prisma.restaurant.update({
    where: { id: draft.restaurantId },
    data: { isPublished: payload.publish },
  });
  return {
    ok: true,
    message: payload.publish ? "Restaurant published" : "Restaurant unpublished",
    data: { isPublished: payload.publish },
  };
}

interface AvailabilityTogglePayload {
  menuItemIds: string[];
  available: boolean;
}

async function shipAvailabilityToggle(draft: DraftAction): Promise<ShipResult> {
  const payload = draft.payload as unknown as AvailabilityTogglePayload;
  if (!Array.isArray(payload.menuItemIds) || payload.menuItemIds.length === 0) {
    throw new Error("availability_toggle payload missing menuItemIds");
  }
  // A missing/null `available` must NOT silently coerce to false and mark
  // items sold-out — require an explicit boolean.
  if (typeof payload.available !== "boolean") {
    throw new Error("availability_toggle payload missing required boolean 'available'");
  }

  // Scope to this restaurant to prevent cross-tenant mutation.
  const result = await prisma.menuItem.updateMany({
    where: { id: { in: payload.menuItemIds }, restaurantId: draft.restaurantId },
    data: {
      isAvailable: payload.available,
      soldOutDate: payload.available ? null : new Date(),
    },
  });
  if (result.count === 0) {
    throw new Error("No matching menu items found in restaurant");
  }

  return {
    ok: true,
    message: `${result.count} item${result.count === 1 ? "" : "s"} marked ${payload.available ? "available" : "sold out"}`,
    data: { count: result.count, available: payload.available },
  };
}

interface MenuItemsBulkUpdatePayload {
  items: Array<{
    menuItemId: string;
    name?: string;
    description?: string;
    price?: number;
    isAvailable?: boolean;
  }>;
}

async function shipMenuItemsBulkUpdate(draft: DraftAction): Promise<ShipResult> {
  const payload = draft.payload as unknown as MenuItemsBulkUpdatePayload;
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    throw new Error("menu_items_bulk_update payload missing items");
  }

  // Validate before opening the transaction so a single bad price doesn't
  // half-apply a 50-item batch.
  for (const item of payload.items) {
    if (item.price !== undefined && (!Number.isFinite(item.price) || item.price < 0)) {
      throw new Error(`menu_items_bulk_update: invalid price for ${item.menuItemId}`);
    }
  }

  let updated = 0;
  await prisma.$transaction(async (tx) => {
    for (const item of payload.items) {
      const data: Record<string, unknown> = {};
      if (item.name !== undefined) data.name = item.name;
      if (item.description !== undefined) data.description = item.description;
      if (item.price !== undefined) data.price = new Prisma.Decimal(item.price);
      if (item.isAvailable !== undefined) {
        data.isAvailable = item.isAvailable;
        data.soldOutDate = item.isAvailable ? null : new Date();
      }
      if (Object.keys(data).length === 0) continue;
      const r = await tx.menuItem.updateMany({
        where: { id: item.menuItemId, restaurantId: draft.restaurantId },
        data,
      });
      updated += r.count;
    }
  });

  return {
    ok: true,
    message: `Updated ${updated} item${updated === 1 ? "" : "s"}`,
    data: { count: updated },
  };
}

interface MenuDescriptionsBulkPayload {
  // map of menuItemId → new description
  suggestions: Record<string, string>;
}

async function shipMenuDescriptionsBulk(draft: DraftAction): Promise<ShipResult> {
  const payload = draft.payload as unknown as MenuDescriptionsBulkPayload;
  const entries = Object.entries(payload.suggestions ?? {});
  if (entries.length === 0) {
    throw new Error("menu_descriptions_bulk payload missing suggestions");
  }

  let updated = 0;
  await prisma.$transaction(async (tx) => {
    for (const [menuItemId, description] of entries) {
      const r = await tx.menuItem.updateMany({
        where: { id: menuItemId, restaurantId: draft.restaurantId },
        data: { description, aiDescriptionStatus: "accepted" },
      });
      updated += r.count;
    }
  });

  return {
    ok: true,
    message: `Updated ${updated} description${updated === 1 ? "" : "s"}`,
    data: { count: updated },
  };
}

interface DietaryTagsApplyPayload {
  suggestions: Array<{
    menuItemId: string;
    tagIds: string[];
  }>;
}

async function shipDietaryTagsApply(draft: DraftAction): Promise<ShipResult> {
  const payload = draft.payload as unknown as DietaryTagsApplyPayload;
  if (!Array.isArray(payload.suggestions) || payload.suggestions.length === 0) {
    throw new Error("dietary_tags_apply payload missing suggestions");
  }

  // Filter to items that belong to this restaurant.
  const itemIds = payload.suggestions.map((s) => s.menuItemId);
  const ownedItems = await prisma.menuItem.findMany({
    where: { id: { in: itemIds }, restaurantId: draft.restaurantId },
    select: { id: true },
  });
  const ownedSet = new Set(ownedItems.map((i) => i.id));

  // Pre-validate every tagId so an FK violation doesn't half-apply the batch.
  const tagIds = Array.from(new Set(payload.suggestions.flatMap((s) => s.tagIds)));
  const knownTags = await prisma.dietaryTag.findMany({
    where: { id: { in: tagIds } },
    select: { id: true },
  });
  const knownTagSet = new Set(knownTags.map((t) => t.id));
  const unknownTags = tagIds.filter((id) => !knownTagSet.has(id));
  if (unknownTags.length > 0) {
    throw new Error(`Unknown dietary tag ids: ${unknownTags.slice(0, 5).join(", ")}`);
  }

  let appliedTags = 0;
  let itemCount = 0;
  // Atomic — if any upsert fails, the whole batch rolls back rather than
  // leaving the menu in a partially-tagged "half-correct" state.
  await prisma.$transaction(async (tx) => {
    for (const suggestion of payload.suggestions) {
      if (!ownedSet.has(suggestion.menuItemId)) continue;
      itemCount++;
      for (const tagId of suggestion.tagIds) {
        await tx.menuItemDietaryTag.upsert({
          where: { menuItemId_tagId: { menuItemId: suggestion.menuItemId, tagId } },
          create: { menuItemId: suggestion.menuItemId, tagId, source: "ai_confirmed" },
          update: { source: "ai_confirmed" },
        });
        appliedTags++;
      }
    }
  });

  return {
    ok: true,
    message: `Applied ${appliedTags} dietary tags across ${itemCount} items`,
    data: { tagCount: appliedTags, itemCount },
  };
}

interface AdCampaignCreatePayload {
  name: string;
  campaignType: string;
  goal: string;
  countries: string[];
  cuisines: string[];
  targetPlatforms: string[];
  budgetTier: string;
  budgetAed: number;
  durationWeeks?: number | null;
  startsOn?: string | null;
  endsOn?: string | null;
  primaryDishId?: string | null;
  brandVoice?: string | null;
  briefJson?: Record<string, unknown> | null;
  /**
   * When set, the shipper UPDATES the existing event-stager AdProject for
   * this moment instead of creating a fresh row. Prevents the
   * `plan_marketing_week` bundle from doubling up on the calendar's
   * already-staged campaign.
   */
  sourceMomentId?: string | null;
  sourceMomentYear?: number | null;
}

/**
 * Creates or updates an AdProject in DRAFT status — mirrors the event-stager
 * pattern. No auto-generation (cost control); owner clicks Generate from Ad
 * Studio when they're ready to spend. Used by bundle children for the "3
 * Meta ads" row of a weekend marketing bundle.
 *
 * Idempotency contract: when `sourceMomentId + sourceMomentYear` is present
 * AND an AdProject already exists for that (restaurant, moment, year) tuple
 * (event-stager's daily cron seeds these), we UPDATE that row instead of
 * creating a parallel project. Without this guard, `plan_marketing_week`
 * approving its ad child creates a second AdProject for an event that the
 * calendar already has on the books.
 */
async function shipAdCampaignCreate(draft: DraftAction): Promise<ShipResult> {
  const payload = draft.payload as unknown as AdCampaignCreatePayload;
  if (!payload?.name || !payload.campaignType || !payload.goal) {
    throw new Error("ad_campaign_create payload missing name/campaignType/goal");
  }
  if (!Array.isArray(payload.countries) || payload.countries.length === 0) {
    throw new Error("ad_campaign_create payload missing countries");
  }
  if (!Number.isFinite(payload.budgetAed) || payload.budgetAed < 0) {
    throw new Error("ad_campaign_create payload has invalid budgetAed");
  }

  if (payload.sourceMomentId && payload.sourceMomentYear) {
    const existing = await prisma.adProject.findUnique({
      where: {
        uniq_event_stage_per_moment: {
          restaurantId: draft.restaurantId,
          sourceMomentId: payload.sourceMomentId,
          sourceMomentYear: payload.sourceMomentYear,
        },
      },
      select: { id: true, status: true, name: true },
    });
    if (existing) {
      // Refresh the row with the bundle's enriched details (theme, hero
      // dish) but DO NOT touch status — it might already be `generating`
      // or `ready` and we don't want to demote it back to draft.
      const updated = await prisma.adProject.update({
        where: { id: existing.id },
        data: {
          name: payload.name,
          budgetAed: payload.budgetAed,
          budgetTier: payload.budgetTier ?? "lean",
          primaryDishId: payload.primaryDishId ?? null,
          brandVoice: payload.brandVoice ?? null,
          briefJson: (payload.briefJson ?? {}) as Prisma.InputJsonValue,
        },
        select: { id: true, name: true },
      });
      return {
        ok: true,
        message: `Refreshed event campaign "${updated.name}" with bundle details — open Ad Studio to generate`,
        data: { adProjectId: updated.id, reusedExisting: true },
      };
    }
  }

  const project = await prisma.adProject.create({
    data: {
      restaurantId: draft.restaurantId,
      name: payload.name,
      campaignType: payload.campaignType,
      goal: payload.goal,
      countries: payload.countries,
      cuisines: payload.cuisines ?? ["all"],
      targetPlatforms: payload.targetPlatforms ?? ["meta"],
      budgetTier: payload.budgetTier ?? "lean",
      budgetAed: payload.budgetAed,
      durationWeeks: payload.durationWeeks ?? null,
      startsOn: payload.startsOn ? new Date(payload.startsOn) : null,
      endsOn: payload.endsOn ? new Date(payload.endsOn) : null,
      primaryDishId: payload.primaryDishId ?? null,
      brandVoice: payload.brandVoice ?? null,
      status: "draft",
      briefJson: (payload.briefJson ?? {}) as Prisma.InputJsonValue,
      sourceMomentId: payload.sourceMomentId ?? null,
      sourceMomentYear: payload.sourceMomentYear ?? null,
    },
    select: { id: true, name: true },
  });

  return {
    ok: true,
    message: `Ad campaign "${project.name}" created — open Ad Studio to generate`,
    data: { adProjectId: project.id, reusedExisting: false },
  };
}

interface AdCampaignCreateAndGeneratePayload {
  brief: Record<string, unknown> & { name: string; budgetAed: number };
  sourceMomentId?: string | null;
  sourceMomentYear?: number | null;
  sourceMomentStartsOn?: string | null;
}

/**
 * Chat-initiated ad campaign that, on approval, BOTH creates the AdProject and
 * kicks off creative generation — the owner reviews finished variants in Ad
 * Studio rather than clicking Generate themselves. Distinct from
 * `ad_campaign_create` (bundle/event path, draft-only, no auto-generate).
 */
async function shipAdCampaignCreateAndGenerate(draft: DraftAction): Promise<ShipResult> {
  const payload = draft.payload as unknown as AdCampaignCreateAndGeneratePayload;
  if (!payload?.brief?.name) {
    throw new Error("ad_campaign_create_and_generate payload missing brief");
  }

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: draft.restaurantId },
    include: { subscription: true },
  });
  if (!restaurant) {
    return { ok: false, message: "Restaurant not found." };
  }
  const ents = getRestaurantEntitlements(restaurant);

  // Re-check quota at ship time (may have been consumed during the grace window).
  // NOTE: moment-collision reuse below consumes no quota; this check can in rare cases block a reuse-only approval — accepted.
  if (ents.adProjectMonthlyLimit !== null) {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const created = await prisma.adProject.count({
      where: { restaurantId: draft.restaurantId, createdAt: { gte: monthStart } },
    });
    if (created >= ents.adProjectMonthlyLimit) {
      return { ok: false, message: "Monthly ad project limit reached since this draft was created." };
    }
  }

  const parsed = briefInputSchema.parse({ ...payload.brief, restaurantId: draft.restaurantId });

  // Guard against the (restaurantId, sourceMomentId, sourceMomentYear) unique
  // constraint — the event-stager cron may have already staged a project for
  // this moment. Reuse it (flip to generating) rather than crashing on a P2002.
  if (payload.sourceMomentId && payload.sourceMomentYear) {
    const existing = await prisma.adProject.findUnique({
      where: {
        uniq_event_stage_per_moment: {
          restaurantId: draft.restaurantId,
          sourceMomentId: payload.sourceMomentId,
          sourceMomentYear: payload.sourceMomentYear,
        },
      },
      select: { id: true, name: true, status: true },
    });
    if (existing) {
      // Only auto-flip + enqueue from a fresh state. A `ready`/`exported`
      // project already has approved creatives that the generation worker
      // upserts by variant, so regenerating here would silently overwrite
      // them — we don't want to clobber finished work the owner didn't
      // explicitly ask to regenerate.
      if (existing.status === "draft" || existing.status === "failed") {
        await enforceGlobalBudget();
        await enforceGenerateRateLimit(draft.restaurantId);
        const flipped = await prisma.adProject.updateMany({
          where: { id: existing.id, status: { not: "generating" } },
          data: { status: "generating", lastError: null },
        });
        if (flipped.count === 0) {
          return {
            ok: true,
            message: `Ad campaign "${existing.name}" is already generating in Ad Studio.`,
            data: { adProjectId: existing.id, reusedExisting: true },
          };
        }
        const numberOfVariants = Math.min(Math.max(ents.adGenerationsPerProject, 1), 6);
        await enqueueAdStudioGeneration({ projectId: existing.id, numberOfVariants });
        return {
          ok: true,
          message: `Ad campaign "${existing.name}" — generating ${numberOfVariants} variants in Ad Studio.`,
          data: { adProjectId: existing.id, reusedExisting: true },
        };
      }
      if (existing.status === "generating") {
        return {
          ok: true,
          message: `Campaign "${existing.name}" for this event is already generating — check Ad Studio.`,
        };
      }
      // `ready`, `exported`, `archived`, or anything else: leave the finished
      // project untouched and point the owner at Ad Studio to review/regenerate.
      return {
        ok: true,
        message: `You already have a campaign "${existing.name}" for this event — open Ad Studio to review it or regenerate from there.`,
        data: { adProjectId: existing.id },
      };
    }
  }

  await enforceGlobalBudget();
  await enforceGenerateRateLimit(draft.restaurantId);

  const project = await prisma.adProject.create({
    data: {
      restaurantId: draft.restaurantId,
      name: parsed.name,
      campaignType: parsed.campaignType,
      goal: parsed.goal,
      countries: parsed.countries,
      cuisines: parsed.cuisines,
      targetPlatforms: parsed.targetPlatforms,
      budgetTier: parsed.budgetTier,
      budgetAed: parsed.budgetAed,
      durationWeeks: parsed.durationWeeks ?? null,
      primaryDishId: parsed.primaryDishId ?? null,
      brandVoice: parsed.brandVoice ?? null,
      status: "generating",
      briefJson: parsed as unknown as Prisma.InputJsonValue,
      sourceMomentId: payload.sourceMomentId ?? null,
      sourceMomentYear: payload.sourceMomentYear ?? null,
      sourceMomentStartsOn: payload.sourceMomentStartsOn ? new Date(payload.sourceMomentStartsOn) : null,
    },
  });

  const numberOfVariants = Math.min(Math.max(ents.adGenerationsPerProject, 1), 6);
  await enqueueAdStudioGeneration({ projectId: project.id, numberOfVariants });

  return {
    ok: true,
    message: `Ad campaign "${project.name}" created — generating ${numberOfVariants} variants in Ad Studio.`,
    data: { adProjectId: project.id },
  };
}

interface DishImagesGeneratePayload {
  menuItemIds: string[];
  promptModifier: string | null;
}

/**
 * Queues one AI image generation per menu item. Mirrors the single-image route
 * (POST /ai/generate-image) per item: stage a "none" MenuItemImage row inside a
 * transaction, enqueue, then flip the row to "generating" + sync the item
 * summary. The enqueue happens BEFORE the status flip and, on failure, the row
 * is deleted (compensating cleanup) so a failed enqueue never leaves a phantom
 * pending image — exactly as the route does.
 *
 * Quota is re-checked at ship; if the remaining allowance dropped below the
 * drafted batch size since drafting, the whole batch is refused (no partial
 * fulfillment) and the owner is told to ask for a smaller batch.
 */
async function shipDishImagesGenerate(draft: DraftAction): Promise<ShipResult> {
  const payload = draft.payload as unknown as DishImagesGeneratePayload;
  if (!payload?.menuItemIds?.length) {
    throw new Error("dish_images_generate payload missing menuItemIds");
  }

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: draft.restaurantId },
    include: { subscription: true },
  });
  if (!restaurant) return { ok: false, message: "Restaurant not found." };
  const ents = getRestaurantEntitlements(restaurant);

  const usage = await checkAiLimit(draft.restaurantId, "dish_image_generation", ents.dishImageGenerationLimit);
  const remaining = usage.remaining ?? Number.MAX_SAFE_INTEGER;
  if (remaining < payload.menuItemIds.length) {
    return { ok: false, message: `Image quota changed since drafting — ${remaining} generations remain but ${payload.menuItemIds.length} were requested. Ask Sous Chef for a smaller batch.` };
  }

  let queued = 0;
  const failures: string[] = [];
  for (const menuItemId of payload.menuItemIds) {
    try {
      const item = await prisma.menuItem.findFirst({
        where: { id: menuItemId, restaurantId: draft.restaurantId },
        select: { id: true, name: true },
      });
      if (!item) { failures.push(menuItemId); continue; }

      const image = await prisma.$transaction(async (tx) => {
        const prepared = await ensurePrimaryImageRecord(tx, item.id);
        const images = prepared?.images ?? [];
        if (images.some((img) => img.imageStatus === "none" || img.imageStatus === "generating")) {
          return null; // generation already pending — skip, not an error
        }
        const nextSlot = getNextImageSlot(images);
        if (nextSlot === null) return null; // variant limit reached
        return tx.menuItemImage.create({
          data: {
            menuItemId: item.id,
            slot: nextSlot,
            promptModifier: payload.promptModifier,
            imageStatus: "none",
            isPrimary: images.length === 0,
            originType: "bustan_ai",
            derivationType: "synthetic_generation",
            parentImageId: null,
          },
        });
      });
      if (!image) { failures.push(item.name); continue; }

      // Enqueue BEFORE flipping to "generating"; on enqueue failure delete the
      // staged row and resync so we never leave a phantom pending image.
      try {
        await enqueueMenuItemImage({
          menuItemId: item.id,
          imageId: image.id,
          priority: ents.imageGenerationPriority,
          // allowFallback intentionally omitted — defer to GOOGLE_IMAGE_ALLOW_FALLBACK, same as the dashboard route.
        });
      } catch (enqueueError) {
        await prisma.$transaction(async (tx) => {
          await tx.menuItemImage.delete({ where: { id: image.id } });
          await syncMenuItemImageSummary(tx, item.id);
        });
        throw enqueueError;
      }

      await prisma.$transaction(async (tx) => {
        await tx.menuItemImage.update({ where: { id: image.id }, data: { imageStatus: "generating" } });
        await syncMenuItemImageSummary(tx, item.id);
      });
      await logAiUsage(draft.restaurantId, "dish_image_generation", 0, 0, 0.04);
      queued += 1;
    } catch {
      failures.push(menuItemId);
    }
  }

  return {
    ok: queued > 0,
    message: `Generating ${queued} dish photo${queued === 1 ? "" : "s"}${failures.length ? ` (${failures.length} skipped)` : ""} — they'll appear on the menu as they finish.`,
    data: { queued, skipped: failures.length },
  };
}

interface WhatsappCampaignCreatePayload {
  name: string;
  campaignType: "inactive_30" | "weekend_special" | "new_promotion";
  templateName: string;
  body: string;
  targetSegment: string;
  promotionId?: string | null;
}

/**
 * Creates a WhatsApp Campaign in DRAFT status. Owner reviews + triggers send
 * from /dashboard/crm — bulk-sending dozens-to-thousands of WhatsApp messages
 * must always have a final human confirmation, both for cost reasons (each
 * marketing message has a per-template fee) and to satisfy Meta's policy on
 * "explicit consent per blast".
 */
async function shipWhatsappCampaignCreate(draft: DraftAction): Promise<ShipResult> {
  const payload = draft.payload as unknown as WhatsappCampaignCreatePayload;
  if (!payload?.name || !payload.templateName || !payload.body) {
    throw new Error("whatsapp_campaign_create payload missing name/templateName/body");
  }
  if (!payload.targetSegment) {
    throw new Error("whatsapp_campaign_create payload missing targetSegment");
  }

  const campaign = await prisma.campaign.create({
    data: {
      restaurantId: draft.restaurantId,
      name: payload.name,
      type: payload.campaignType,
      templateName: payload.templateName,
      body: payload.body,
      targetSegment: payload.targetSegment,
      status: "draft",
      promotionId: payload.promotionId ?? null,
    },
    select: { id: true, name: true },
  });

  return {
    ok: true,
    message: `WhatsApp campaign "${campaign.name}" drafted — open CRM to review and send`,
    data: { campaignId: campaign.id },
  };
}

interface WhatsappCampaignSendPayload {
  type: "inactive_30" | "weekend_special" | "new_promotion";
  inactiveDays?: number;
  templateName?: string;
  body?: string;
  name?: string;
  promotionId?: string | null;
  restaurantName: string;
}

/**
 * Unlike whatsapp_campaign_create (stages a CRM draft for bundles), approving
 * this draft IS the final confirmation: the 5-minute grace window is the undo.
 * Eligibility is re-resolved inside executeCampaignSend at ship time, so
 * consents changed during the grace are honored.
 */
async function shipWhatsappCampaignSend(draft: DraftAction): Promise<ShipResult> {
  const payload = draft.payload as unknown as WhatsappCampaignSendPayload;
  if (!payload?.type || !payload.restaurantName) {
    throw new Error("whatsapp_campaign_send payload missing type/restaurantName");
  }

  const result = await executeCampaignSend({
    restaurantId: draft.restaurantId,
    restaurantName: payload.restaurantName,
    type: payload.type,
    inactiveDays: payload.inactiveDays,
    templateName: payload.templateName,
    body: payload.body,
    name: payload.name,
    promotionId: payload.promotionId ?? null,
    sourceDraftId: draft.id,
  });

  const skipped = result.skippedFrequency + result.skippedTier;
  const message =
    result.mode === "meta_cloud_api"
      ? `Sent to ${result.sent} of ${result.targeted} customers${result.failed ? ` (${result.failed} failed)` : ""}${skipped ? ` (${skipped} skipped by caps)` : ""}.`
      : `Logged ${result.sent} tap-to-send WhatsApp links in CRM (no Meta API connection — open CRM to send).`;

  return {
    ok: true,
    message,
    data: {
      campaignId: result.campaign.id,
      targeted: result.targeted,
      sent: result.sent,
      failed: result.failed,
      skippedFrequency: result.skippedFrequency,
      skippedTier: result.skippedTier,
      mode: result.mode,
    },
  };
}

interface ReviewReplyPayload {
  items: Array<{
    reviewId: string;
    reply: string;
  }>;
}

/**
 * Marks each GbpReview's draftReply + flips status to draft_approved. Phase 3
 * stops here intentionally — Bustan can't post replies back to Google
 * automatically (no GBP OAuth integration), so the inbox card carries a
 * "Copy reply" affordance and the owner pastes manually. When GBP OAuth
 * lands later, this shipper becomes the auto-post path and the card UX
 * drops the copy step.
 */
async function shipReviewReply(draft: DraftAction): Promise<ShipResult> {
  const payload = draft.payload as unknown as ReviewReplyPayload;
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    throw new Error("review_reply payload missing items");
  }

  const now = new Date();
  const requested = payload.items.length;
  let updated = 0;
  await prisma.$transaction(async (tx) => {
    for (const item of payload.items) {
      if (!item.reviewId || !item.reply?.trim()) continue;
      // Scope by restaurantId so a tampered payload can't reach another
      // tenant's review row. The status filter intentionally excludes
      // has_owner_reply / posted / ignored so reviews the owner already
      // resolved (e.g. replied directly on Google between draft and ship)
      // don't get a stale Sous Chef reply overlaid.
      const result = await tx.gbpReview.updateMany({
        where: {
          id: item.reviewId,
          restaurantId: draft.restaurantId,
          status: { in: ["unanswered", "draft_pending"] },
        },
        data: {
          draftReply: item.reply,
          status: "draft_approved",
          draftedAt: now,
          approvedAt: now,
        },
      });
      updated += result.count;
    }
  });

  // Surface count drift so the owner notices when some replies were skipped
  // (e.g. they replied via Google directly between draft creation and approval).
  const drifted = requested - updated;
  const message =
    drifted > 0
      ? `${updated} review repl${updated === 1 ? "y" : "ies"} ready to copy · ${drifted} skipped (already answered on Google)`
      : `${updated} review repl${updated === 1 ? "y" : "ies"} ready to copy`;

  return {
    ok: true,
    message,
    data: { count: updated, requested, skipped: drifted },
  };
}

/**
 * "Review-only" drafts (event-stager AdProjects, sabt-pack bundles, and the
 * marketing_bundle coordination parent). These surface as cards but don't
 * have a destructive ship action — the actual generation happens when the
 * owner clicks into Ad Studio / CRM, or when child drafts run.
 *
 * Cost note: event-stager deliberately writes the project shell + brief and
 * does NOT call /generate (which costs tokens + image-gen credits). Keeping
 * that contract intact here — the owner clicks Generate from Ad Studio when
 * they're ready to spend.
 */
async function shipReviewAcknowledgment(draft: DraftAction): Promise<ShipResult> {
  // The marketing_bundle parent is a coordination row; its children are the
  // real shippers. The history view should tell the owner WHERE each child
  // landed, not just "respective surfaces".
  if (draft.actionType === "marketing_bundle") {
    const previewChildren =
      (draft.preview as { children?: Array<{ actionType: string }> })?.children ?? [];
    const destinations = summariseBundleDestinations(previewChildren);
    return {
      ok: true,
      message: destinations
        ? `Marketing bundle shipped · ${destinations}`
        : `Marketing bundle shipped · ${draft.childCount} action${draft.childCount === 1 ? "" : "s"} queued`,
      data: {
        childCount: draft.childCount,
        destinations,
        acknowledgedAt: new Date().toISOString(),
      },
    };
  }
  return {
    ok: true,
    message: `Acknowledged · open ${draft.affectedSurface ?? "the relevant page"} to continue`,
    data: {
      adProjectId: draft.adProjectId,
      campaignId: draft.campaignId,
      acknowledgedAt: new Date().toISOString(),
    },
  };
}

/**
 * Server-side mirror of the frontend summariseBundleDestinations helper.
 * Lives here so `shipResult.message` (stored in the DB + rendered in History)
 * names where each bundle child actually landed.
 */
function summariseBundleDestinations(
  children: Array<{ actionType: string }>
): string {
  if (children.length === 0) return "";
  const buckets = new Map<string, { count: number; labels: Set<string> }>();
  for (const child of children) {
    const destination = destinationForActionType(child.actionType);
    const label = actionTypeLabel(child.actionType);
    const existing = buckets.get(destination) ?? { count: 0, labels: new Set() };
    existing.count += 1;
    existing.labels.add(label);
    buckets.set(destination, existing);
  }
  return Array.from(buckets.entries())
    .map(([destination, { count, labels }]) => {
      const label = Array.from(labels).join("/");
      const noun = count === 1 ? label : `${label}s`.replace(/ss$/, "s");
      return `${count} ${noun} in ${destination}`;
    })
    .join(" · ");
}

function destinationForActionType(actionType: string): string {
  if (actionType === "ad_campaign_create") return "Ad Studio";
  if (actionType === "whatsapp_campaign_create") return "WhatsApp CRM";
  if (actionType === "review_reply") return "Inbox";
  if (actionType === "restaurant_profile_update") return "Storefront";
  if (actionType === "publish_menu") return "Inbox";
  return "Menu";
}

function actionTypeLabel(actionType: string): string {
  switch (actionType) {
    case "ad_campaign_create":
      return "ad campaign";
    case "whatsapp_campaign_create":
      return "WhatsApp blast";
    case "promotion_create":
      return "promotion";
    case "menu_description":
    case "menu_descriptions_bulk":
      return "description";
    case "menu_item_create":
      return "new item";
    case "menu_section_create":
      return "new section";
    case "price_change":
      return "price change";
    case "menu_item_update":
    case "menu_items_bulk_update":
      return "item update";
    case "availability_toggle":
      return "availability change";
    case "dietary_tags_apply":
      return "dietary tag pass";
    case "restaurant_profile_update":
      return "profile update";
    case "publish_menu":
      return "publish toggle";
    case "review_reply":
      return "review reply";
    default:
      return actionType.replace(/_/g, " ");
  }
}

// ── Inbox summary / list helpers ────────────────────────────────────────────

export async function getInboxSummary(restaurantId: string): Promise<{
  pending: number;
  scheduled: number;
  todayCount: number;
  shippedThisMonth: number;
}> {
  const now = new Date();
  const startOfToday = startOfTodayGst(now);
  const startOfMonth = startOfMonthGst(now);

  const [pending, scheduled, todayCount, shippedThisMonth] = await Promise.all([
    prisma.draftAction.count({
      where: { restaurantId, status: DraftActionStatus.pending, parentDraftId: null },
    }),
    prisma.draftAction.count({
      where: {
        restaurantId,
        status: { in: [DraftActionStatus.approved, DraftActionStatus.scheduled] },
        parentDraftId: null,
      },
    }),
    prisma.draftAction.count({
      where: {
        restaurantId,
        status: DraftActionStatus.pending,
        createdAt: { gte: startOfToday },
        parentDraftId: null,
      },
    }),
    prisma.draftAction.count({
      where: {
        restaurantId,
        status: DraftActionStatus.shipped,
        shippedAt: { gte: startOfMonth },
        parentDraftId: null,
      },
    }),
  ]);

  return { pending, scheduled, todayCount, shippedThisMonth };
}

/**
 * Aggregated stats for the History card on the Sous Chef Inbox. All counts
 * are lazy reads (no new cron). The "time saved" estimate is intentionally
 * coarse — 90 seconds per shipped single action, 30 seconds per child of a
 * bulk action — calibrated so an owner who ships 30 things in a month sees
 * a believable "~45 minutes saved" number, not a fabricated hour-and-a-half.
 */
const TIME_SAVED_PER_SINGLE_SEC = 90;
const TIME_SAVED_PER_BULK_CHILD_SEC = 30;

export async function getInboxHistory(
  restaurantId: string,
  options: { since?: Date } = {}
): Promise<{
  actionsShipped: number;
  timeSavedMinutes: number;
  customersReached: number;
  shippedByType: Record<string, number>;
}> {
  const since = options.since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // SQL-level aggregation — returns a small grouped result instead of
  // streaming every shipped row back to Node. Critical for Portfolio users
  // who can ship 1000+ drafts/month across brands.
  const grouped = await prisma.draftAction.groupBy({
    by: ["actionType", "kind"],
    where: {
      restaurantId,
      status: DraftActionStatus.shipped,
      shippedAt: { gte: since },
      parentDraftId: null,
    },
    _count: { _all: true },
    _sum: { childCount: true },
  });

  let actionsShipped = 0;
  let timeSavedSec = 0;
  const shippedByType: Record<string, number> = {};
  for (const row of grouped) {
    const count = row._count._all;
    actionsShipped += count;
    shippedByType[row.actionType] = (shippedByType[row.actionType] ?? 0) + count;
    if (row.kind === DraftActionKind.bulk || row.kind === DraftActionKind.bundle) {
      const childCountSum = row._sum.childCount ?? 0;
      // Defensive: bulks with childCount=0 fall back to 1 per row.
      const effectiveChildren = Math.max(childCountSum, count);
      timeSavedSec += effectiveChildren * TIME_SAVED_PER_BULK_CHILD_SEC;
    } else {
      timeSavedSec += count * TIME_SAVED_PER_SINGLE_SEC;
    }
  }

  // "Customers reached" is a real ad/whatsapp metric. Phase 5 only routes
  // review/staging drafts (no audience deliveries yet). Stays 0 until Phase 3
  // wires WhatsApp campaigns through drafts. Surface as 0 explicitly rather
  // than fudging.
  const customersReached = 0;

  return {
    actionsShipped,
    timeSavedMinutes: Math.round(timeSavedSec / 60),
    customersReached,
    shippedByType,
  };
}

/**
 * Surface-scoped count for inline banners on /dashboard/menu, /ad-studio etc.
 * Matches drafts whose affectedSurface STARTS WITH the given prefix, so
 * "/dashboard/ad-studio" matches both the studio root and per-project routes.
 */
export async function getSurfaceInboxSummary(
  restaurantId: string,
  surfacePrefix: string
): Promise<{ pending: number; topTitles: string[] }> {
  const drafts = await prisma.draftAction.findMany({
    where: {
      restaurantId,
      status: DraftActionStatus.pending,
      affectedSurface: { startsWith: surfacePrefix },
      parentDraftId: null,
    },
    select: { title: true },
    orderBy: { createdAt: "desc" },
    take: 3,
  });
  const total = await prisma.draftAction.count({
    where: {
      restaurantId,
      status: DraftActionStatus.pending,
      affectedSurface: { startsWith: surfacePrefix },
      parentDraftId: null,
    },
  });
  return { pending: total, topTitles: drafts.map((d) => d.title) };
}

export type InboxSection = "today" | "pending" | "scheduled" | "history";

export async function listInbox(
  restaurantId: string,
  section: InboxSection,
  options: { limit?: number; cursor?: string } = {}
): Promise<{ drafts: DraftAction[]; nextCursor: string | null }> {
  const limit = Math.min(options.limit ?? 25, 50);
  const now = new Date();
  const startOfToday = startOfTodayGst(now);

  const where: Prisma.DraftActionWhereInput = { restaurantId, parentDraftId: null };

  if (section === "today") {
    where.status = DraftActionStatus.pending;
    where.createdAt = { gte: startOfToday };
  } else if (section === "pending") {
    where.status = DraftActionStatus.pending;
    where.createdAt = { lt: startOfToday };
  } else if (section === "scheduled") {
    where.status = { in: [DraftActionStatus.approved, DraftActionStatus.scheduled] };
  } else {
    where.status = {
      in: [DraftActionStatus.shipped, DraftActionStatus.rejected, DraftActionStatus.failed],
    };
  }

  const drafts = await prisma.draftAction.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(options.cursor && { skip: 1, cursor: { id: options.cursor } }),
  });

  const hasMore = drafts.length > limit;
  const trimmed = hasMore ? drafts.slice(0, limit) : drafts;
  return { drafts: trimmed, nextCursor: hasMore ? trimmed[trimmed.length - 1].id : null };
}

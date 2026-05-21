// Sous Chef inbox HTTP routes.
//
// Mounted at /api/inbox. All endpoints are owner-scoped (clerkId must own the
// restaurant the draft belongs to) and tier-gated (Sous Chef requires Pro+).
// Mutations enqueue the draft-ship worker job rather than mutating target
// entities directly — that work lives in shipDraft() inside
// services/draft-actions.ts.

import { Hono } from "hono";
import { z } from "zod";
import { ApiError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { getRestaurantEntitlements } from "@/lib/entitlements";
import { requireAuth } from "@/middleware/auth";
import {
  approveDraft,
  cancelScheduledDraft,
  getInboxHistory,
  getInboxSummary,
  getSurfaceInboxSummary,
  listInbox,
  rejectDraft,
  updateDraftPayload,
} from "@/services/draft-actions";
import { enqueueDraftShip } from "@/queue/draft-ship";
import { DraftActionStatus } from "@prisma/client";

const sectionSchema = z.enum(["today", "pending", "scheduled", "history"]);

const RESTAURANT_PLAN_INCLUDE = {
  subscription: true,
  operatorAccount: { include: { _count: { select: { brands: true } } } },
} as const;

/**
 * Resolves the restaurant + asserts (a) the requester owns it and
 * (b) Sous Chef is enabled on their plan. Mutating routes call this twice
 * (once to load the restaurant, then via loadOwnedDraft) — both checks the
 * same tier gate so a downgrade between page load and approve still blocks
 * the action.
 */
async function loadOwnedRestaurant(restaurantId: string, clerkId: string) {
  const restaurant = await prisma.restaurant.findFirst({
    where: { id: restaurantId, owner: { clerkId } },
    include: RESTAURANT_PLAN_INCLUDE,
  });
  if (!restaurant) throw new ApiError("Restaurant not found", 404);

  const entitlements = getRestaurantEntitlements(restaurant);
  if (!entitlements.menuAssistantEnabled) {
    throw new ApiError(
      "Sous Chef is included in Pro and Portfolio plans. Upgrade in Billing to use the Inbox.",
      402
    );
  }
  return { restaurant, entitlements };
}

async function loadOwnedDraft(draftId: string, clerkId: string) {
  const draft = await prisma.draftAction.findUnique({
    where: { id: draftId },
    include: {
      restaurant: {
        include: {
          ...RESTAURANT_PLAN_INCLUDE,
          owner: { select: { clerkId: true } },
        },
      },
    },
  });
  if (!draft) throw new ApiError("Draft not found", 404);
  if (draft.restaurant.owner.clerkId !== clerkId) {
    // Don't leak that the draft exists for a different tenant.
    throw new ApiError("Draft not found", 404);
  }
  const entitlements = getRestaurantEntitlements(draft.restaurant);
  if (!entitlements.menuAssistantEnabled) {
    throw new ApiError(
      "Sous Chef is included in Pro and Portfolio plans. Upgrade in Billing to act on this draft.",
      402
    );
  }
  return draft;
}

const rejectSchema = z.object({ reason: z.string().max(500).optional() });
// Phase 1: only cosmetic edits. Payload/preview rewrites land in Phase 2 with
// per-actionType schema validation — until then, allowing arbitrary payload
// edits would let an owner (or an attacker) steer a draft at a foreign entity.
const editSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  subtitle: z.string().max(400).nullable().optional(),
});
const bulkApproveSchema = z.object({
  draftIds: z.array(z.string().cuid()).min(1).max(50),
});

export const inboxRoute = new Hono<{
  Variables: { auth: { clerkId: string; email: string | null } };
}>()
  .get("/:restaurantId/summary", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const restaurantId = c.req.param("restaurantId");
      await loadOwnedRestaurant(restaurantId, auth.clerkId);
      const summary = await getInboxSummary(restaurantId);
      return c.json(summary);
    } catch (error) {
      return errorResponse(c, error);
    }
  })

  // ── GET /:restaurantId/history ───────────────────────────────────
  // Lazy 30-day rollup for the History card on the inbox home.
  .get("/:restaurantId/history", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const restaurantId = c.req.param("restaurantId");
      await loadOwnedRestaurant(restaurantId, auth.clerkId);
      const history = await getInboxHistory(restaurantId);
      return c.json(history);
    } catch (error) {
      return errorResponse(c, error);
    }
  })

  // ── GET /:restaurantId/by-surface?prefix=/dashboard/menu ─────────
  // Powers the inline banners on Menu/Ad Studio/CRM/Google pages.
  .get("/:restaurantId/by-surface", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const restaurantId = c.req.param("restaurantId");
      await loadOwnedRestaurant(restaurantId, auth.clerkId);
      const prefix = c.req.query("prefix");
      if (!prefix || !prefix.startsWith("/dashboard/")) {
        throw new ApiError("prefix must start with /dashboard/", 400);
      }
      const summary = await getSurfaceInboxSummary(restaurantId, prefix);
      return c.json(summary);
    } catch (error) {
      return errorResponse(c, error);
    }
  })

  .get("/:restaurantId", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const restaurantId = c.req.param("restaurantId");
      await loadOwnedRestaurant(restaurantId, auth.clerkId);

      const section = sectionSchema.parse(c.req.query("section") ?? "today");
      const cursor = c.req.query("cursor") ?? undefined;
      const limit = Math.min(Number(c.req.query("limit") ?? 25), 50);

      const result = await listInbox(restaurantId, section, { limit, cursor });
      return c.json(result);
    } catch (error) {
      return errorResponse(c, error);
    }
  })

  .get("/draft/:draftId", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const draftId = c.req.param("draftId");
      const draft = await loadOwnedDraft(draftId, auth.clerkId);

      const children =
        draft.childCount > 0
          ? await prisma.draftAction.findMany({
              where: { parentDraftId: draft.id },
              orderBy: { createdAt: "asc" },
            })
          : [];

      return c.json({ draft, children });
    } catch (error) {
      return errorResponse(c, error);
    }
  })

  .post("/draft/:draftId/approve", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const draftId = c.req.param("draftId");
      const draft = await loadOwnedDraft(draftId, auth.clerkId);

      const result = await approveDraft(draft.id, draft.restaurantId, auth.clerkId);
      // For bundles, `toShip` contains the parent + every approved child;
      // for singles/bulks, it's just the one row.
      await Promise.all(
        result.toShip
          .filter((d) => d.shipAt !== null)
          .map((d) => enqueueDraftShip(d.id, d.shipAt!))
      );
      return c.json({ draft: result.primary });
    } catch (error) {
      return errorResponse(c, error);
    }
  })

  .post("/draft/:draftId/reject", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const draftId = c.req.param("draftId");
      const body = rejectSchema.parse(await c.req.json().catch(() => ({})));
      const draft = await loadOwnedDraft(draftId, auth.clerkId);

      const updated = await rejectDraft(draft.id, draft.restaurantId, auth.clerkId, body.reason);
      return c.json({ draft: updated });
    } catch (error) {
      return errorResponse(c, error);
    }
  })

  .post("/draft/:draftId/edit", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const draftId = c.req.param("draftId");
      const body = editSchema.parse(await c.req.json());
      const draft = await loadOwnedDraft(draftId, auth.clerkId);

      const updated = await updateDraftPayload(draft.id, draft.restaurantId, {
        title: body.title,
        subtitle: body.subtitle,
      });
      return c.json({ draft: updated });
    } catch (error) {
      return errorResponse(c, error);
    }
  })

  .post("/draft/:draftId/cancel-scheduled", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const draftId = c.req.param("draftId");
      const draft = await loadOwnedDraft(draftId, auth.clerkId);

      const updated = await cancelScheduledDraft(draft.id, draft.restaurantId);
      // We do NOT cancel the pg-boss job here. shipDraft is idempotent and
      // refuses to ship a draft that's not in approved/scheduled state, so a
      // stale job will simply log "not shippable" and exit.
      return c.json({ draft: updated });
    } catch (error) {
      return errorResponse(c, error);
    }
  })

  .post("/:restaurantId/bulk-approve", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const restaurantId = c.req.param("restaurantId");
      await loadOwnedRestaurant(restaurantId, auth.clerkId);
      const body = bulkApproveSchema.parse(await c.req.json());

      const drafts = await prisma.draftAction.findMany({
        where: {
          id: { in: body.draftIds },
          restaurantId,
          status: DraftActionStatus.pending,
        },
        select: { id: true },
      });

      const toShip: { id: string; shipAt: Date }[] = [];
      let approvedCount = 0;
      const skipped: { id: string; reason: string }[] = [];
      // approveDraft is gated atomically inside the service, so we can run the
      // batch in parallel without worrying about double-fires across drafts.
      // Bundle drafts inside the batch cascade their own children — toShip
      // captures every draft that needs a ship job, parent + children.
      await Promise.all(
        drafts.map(async (d) => {
          try {
            const result = await approveDraft(d.id, restaurantId, auth.clerkId);
            approvedCount++;
            for (const ship of result.toShip) {
              if (ship.shipAt) toShip.push({ id: ship.id, shipAt: ship.shipAt });
            }
          } catch (error) {
            skipped.push({
              id: d.id,
              reason: error instanceof Error ? error.message : "Unknown error",
            });
          }
        })
      );
      // Enqueue ship jobs after all DB writes settle.
      await Promise.all(toShip.map((a) => enqueueDraftShip(a.id, a.shipAt)));

      return c.json({ approved: approvedCount, skipped });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

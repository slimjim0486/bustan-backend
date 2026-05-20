// Owner-facing Coworker routes — opt-in/opt-out toggle for the WhatsApp
// delivery surface. Mounted at /api/coworker.
//
// Auth: requireAuth + ownership check (clerkId must own restaurantId).
// Side effects: create/update CoworkerOwner row. Does NOT submit templates or
// send messages — those are admin-only and scheduled.

import { Hono } from "hono";
import { z } from "zod";
import { env } from "@/lib/env";
import { ApiError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { normalizeE164Phone } from "@/lib/whatsapp-business";
import { requireAuth } from "@/middleware/auth";

const enrollSchema = z.object({
  ownerPhoneE164: z
    .string()
    .min(8)
    .max(20)
    .transform((v) => normalizeE164Phone(v))
    .refine((v): v is string => v !== null, { message: "Invalid phone number" }),
  locale: z.enum(["en", "ar"]).default("en"),
  dailyBriefAt: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "Use HH:mm format")
    .default("08:00"),
});

const updateSchema = z.object({
  locale: z.enum(["en", "ar"]).optional(),
  dailyBriefAt: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "Use HH:mm format")
    .optional(),
  status: z.enum(["pilot", "active", "paused"]).optional(),
});

async function loadOwnedRestaurant(restaurantId: string, clerkId: string) {
  const r = await prisma.restaurant.findFirst({
    where: { id: restaurantId, owner: { clerkId } },
    include: { owner: { select: { id: true } } },
  });
  if (!r) throw new ApiError("Restaurant not found", 404);
  return r;
}

export const coworkerRoute = new Hono<{
  Variables: { auth: { clerkId: string; email: string | null } };
}>()
  // ── GET /:restaurantId/status — read current enrolment ──
  .get("/:restaurantId/status", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const restaurantId = c.req.param("restaurantId");
      await loadOwnedRestaurant(restaurantId, auth.clerkId);

      const row = await prisma.coworkerOwner.findUnique({
        where: { restaurantId },
        select: {
          id: true,
          ownerPhoneE164: true,
          locale: true,
          timezone: true,
          dailyBriefAt: true,
          status: true,
          optedInAt: true,
          pausedAt: true,
          windowExpiresAt: true,
        },
      });

      return c.json({
        enabled: env.COWORKER_ENABLED,
        dryRun: env.COWORKER_DRY_RUN,
        displayPhone: env.COWORKER_DISPLAY_PHONE ?? null,
        enrolment: row,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  // ── POST /:restaurantId/enroll — opt-in ──
  .post("/:restaurantId/enroll", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const restaurantId = c.req.param("restaurantId");
      const restaurant = await loadOwnedRestaurant(restaurantId, auth.clerkId);

      if (!env.COWORKER_ENABLED) {
        throw new ApiError(
          "Coworker isn't enabled in this environment yet. Check back soon.",
          503
        );
      }

      const data = enrollSchema.parse(await c.req.json());

      // Defend against the same phone being claimed by two restaurants.
      const conflict = await prisma.coworkerOwner.findUnique({
        where: { ownerPhoneE164: data.ownerPhoneE164 },
        select: { restaurantId: true },
      });
      if (conflict && conflict.restaurantId !== restaurantId) {
        throw new ApiError(
          "That phone number is already enrolled for a different restaurant on Bustan.",
          409
        );
      }

      const row = await prisma.coworkerOwner.upsert({
        where: { restaurantId },
        create: {
          restaurantId,
          ownerUserId: restaurant.owner.id,
          ownerPhoneE164: data.ownerPhoneE164,
          locale: data.locale,
          dailyBriefAt: data.dailyBriefAt,
          status: "pilot",
        },
        update: {
          ownerPhoneE164: data.ownerPhoneE164,
          locale: data.locale,
          dailyBriefAt: data.dailyBriefAt,
          status: "pilot",
          pausedAt: null,
          optedOutAt: null,
        },
      });

      return c.json({ ok: true, enrolment: row });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  // ── PATCH /:restaurantId — change locale/time/status (owner-controlled) ──
  .patch("/:restaurantId", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const restaurantId = c.req.param("restaurantId");
      await loadOwnedRestaurant(restaurantId, auth.clerkId);
      const data = updateSchema.parse(await c.req.json());

      const row = await prisma.coworkerOwner.findUnique({ where: { restaurantId } });
      if (!row) throw new ApiError("Not enrolled. Use POST /enroll first.", 404);

      const updated = await prisma.coworkerOwner.update({
        where: { id: row.id },
        data: {
          ...(data.locale && { locale: data.locale }),
          ...(data.dailyBriefAt && { dailyBriefAt: data.dailyBriefAt }),
          ...(data.status === "paused" && { status: "paused", pausedAt: new Date() }),
          ...(data.status === "active" && { status: "active", pausedAt: null }),
          ...(data.status === "pilot" && { status: "pilot", pausedAt: null }),
        },
      });

      return c.json({ ok: true, enrolment: updated });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  // ── DELETE /:restaurantId — opt out completely ──
  .delete("/:restaurantId", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const restaurantId = c.req.param("restaurantId");
      await loadOwnedRestaurant(restaurantId, auth.clerkId);

      const row = await prisma.coworkerOwner.findUnique({ where: { restaurantId } });
      if (!row) return c.json({ ok: true });

      await prisma.coworkerOwner.update({
        where: { id: row.id },
        data: { status: "opted_out", optedOutAt: new Date() },
      });
      return c.json({ ok: true });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

import { Hono } from "hono";
import { z } from "zod";
import { ApiError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { getRestaurantEntitlements } from "@/lib/entitlements";
import { requireAuth } from "@/middleware/auth";
import { resolveEffectiveAutonomy, isHighImpactPaused } from "@/services/agent/autonomy";
import {
  STANDING_INSTRUCTION_TYPE,
  MAX_STANDING_INSTRUCTIONS,
  validateStandingInstruction,
} from "@/lib/standing-instructions";

// Same include the inbox route uses so getRestaurantEntitlements can resolve
// the plan (subscription + operatorAccount brand count).
const RESTAURANT_PLAN_INCLUDE = {
  subscription: true,
  operatorAccount: { include: { _count: { select: { brands: true } } } },
} as const;

// Owner-scoped loader. Unlike the inbox loader this does NOT gate on a plan
// feature — every plan can READ its autonomy state (to see the locked/upsell
// view); individual routes apply their own entitlement gate.
async function loadOwned(restaurantId: string, clerkId: string) {
  const restaurant = await prisma.restaurant.findFirst({
    where: { id: restaurantId, owner: { clerkId } },
    include: RESTAURANT_PLAN_INCLUDE,
  });
  if (!restaurant) throw new ApiError("Restaurant not found", 404);
  const entitlements = getRestaurantEntitlements(restaurant);
  return { restaurant, entitlements };
}

export const optInSchema = z.object({ enabled: z.boolean() });
export const instructionSchema = z.object({ content: z.string() });

export const autonomyRoute = new Hono<{
  Variables: { auth: { clerkId: string; email: string | null } };
}>()
  .get("/:restaurantId", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const { restaurant, entitlements } = await loadOwned(c.req.param("restaurantId"), auth.clerkId);
      const instructions = await prisma.ownerChatMemory.findMany({
        where: { restaurantId: restaurant.id, type: STANDING_INSTRUCTION_TYPE },
        orderBy: { createdAt: "asc" },
        select: { id: true, content: true },
      });
      return c.json({
        available: entitlements.agentAutonomy === "guarded_auto",
        optedIn: restaurant.agentAutonomyOptIn,
        effective: resolveEffectiveAutonomy(restaurant, entitlements),
        paused: await isHighImpactPaused(restaurant.id),
        standingInstructionsEnabled: entitlements.standingInstructionsEnabled,
        instructions,
      });
    } catch (e) {
      return errorResponse(c, e);
    }
  })
  .put("/:restaurantId/opt-in", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const { restaurant, entitlements } = await loadOwned(c.req.param("restaurantId"), auth.clerkId);
      if (entitlements.agentAutonomy !== "guarded_auto") {
        throw new ApiError("Autonomous mode is included with Full-time and Head-of-group plans.", 403);
      }
      const { enabled } = optInSchema.parse(await c.req.json());
      await prisma.restaurant.update({
        where: { id: restaurant.id },
        data: { agentAutonomyOptIn: enabled },
      });
      return c.json({ optedIn: enabled });
    } catch (e) {
      return errorResponse(c, e);
    }
  })
  .post("/:restaurantId/resume", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const { restaurant } = await loadOwned(c.req.param("restaurantId"), auth.clerkId);
      await prisma.restaurant.update({
        where: { id: restaurant.id },
        data: { autonomyResumedAt: new Date() },
      });
      return c.json({ resumed: true });
    } catch (e) {
      return errorResponse(c, e);
    }
  })
  .post("/:restaurantId/instructions", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const { restaurant, entitlements } = await loadOwned(c.req.param("restaurantId"), auth.clerkId);
      if (!entitlements.standingInstructionsEnabled) {
        throw new ApiError("Standing instructions are included with Full-time and Head-of-group plans.", 403);
      }
      const { content } = instructionSchema.parse(await c.req.json());
      const clean = validateStandingInstruction(content);
      const count = await prisma.ownerChatMemory.count({
        where: { restaurantId: restaurant.id, type: STANDING_INSTRUCTION_TYPE },
      });
      if (count >= MAX_STANDING_INSTRUCTIONS) {
        throw new ApiError(`You can keep up to ${MAX_STANDING_INSTRUCTIONS} standing instructions.`, 400);
      }
      const created = await prisma.ownerChatMemory.create({
        data: {
          restaurantId: restaurant.id,
          type: STANDING_INSTRUCTION_TYPE,
          content: clean,
          confidence: 1,
          expiresAt: null,
        },
        select: { id: true, content: true },
      });
      return c.json({ instruction: created }, 201);
    } catch (e) {
      return errorResponse(c, e);
    }
  })
  .delete("/:restaurantId/instructions/:id", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const { restaurant } = await loadOwned(c.req.param("restaurantId"), auth.clerkId);
      await prisma.ownerChatMemory.deleteMany({
        where: { id: c.req.param("id"), restaurantId: restaurant.id, type: STANDING_INSTRUCTION_TYPE },
      });
      return c.json({ deleted: true });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

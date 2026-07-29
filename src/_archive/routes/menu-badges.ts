import { Hono } from "hono";
import { z } from "zod";
import { ApiError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";

const setBadgesSchema = z.object({
  badges: z.array(
    z.object({
      badgeId: z.string().min(1),
    })
  ),
});

export const menuBadgesRoute = new Hono<{
  Variables: {
    auth: {
      clerkId: string;
      email: string | null;
    };
  };
}>()
  // Public: list all available badge types
  .get("/", async (c) => {
    try {
      const badges = await prisma.badgeType.findMany({
        orderBy: [{ category: "asc" }, { displayOrder: "asc" }],
      });
      return c.json(badges);
    } catch (error) {
      return errorResponse(c, error);
    }
  })

  // Set badges on a menu item (replaces existing)
  .post("/items/:id/badges", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const itemId = c.req.param("id");
      const data = setBadgesSchema.parse(await c.req.json());

      const item = await prisma.menuItem.findUnique({
        where: { id: itemId },
        include: {
          restaurant: { include: { owner: true } },
        },
      });

      if (!item || item.restaurant.owner.clerkId !== auth.clerkId) {
        throw new ApiError("Menu item not found", 404);
      }

      // Remove existing badges and set new ones
      await prisma.$transaction(async (tx) => {
        await tx.menuItemBadge.deleteMany({
          where: { menuItemId: itemId },
        });

        for (const badge of data.badges) {
          await tx.menuItemBadge.create({
            data: {
              menuItemId: itemId,
              badgeId: badge.badgeId,
            },
          });
        }
      });

      const updated = await prisma.menuItemBadge.findMany({
        where: { menuItemId: itemId },
        include: { badge: true },
      });

      return c.json(updated);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

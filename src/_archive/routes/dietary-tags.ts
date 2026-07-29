import { Hono } from "hono";
import { z } from "zod";
import { ApiError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";

const setTagsSchema = z.object({
  tags: z.array(
    z.object({
      tagId: z.string().min(1),
      source: z.enum(["manual", "ai_suggested", "ai_confirmed"]).default("manual"),
      confidence: z.number().optional(),
    })
  ),
});

export const dietaryTagsRoute = new Hono<{
  Variables: {
    auth: {
      clerkId: string;
      email: string | null;
    };
  };
}>()
  // Public: list all available tags
  .get("/", async (c) => {
    try {
      const tags = await prisma.dietaryTag.findMany({
        orderBy: [{ category: "asc" }, { label: "asc" }],
      });
      return c.json(tags);
    } catch (error) {
      return errorResponse(c, error);
    }
  })

  // Set tags on a menu item
  .post("/items/:id/tags", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const itemId = c.req.param("id");
      const data = setTagsSchema.parse(await c.req.json());

      const item = await prisma.menuItem.findUnique({
        where: { id: itemId },
        include: {
          restaurant: { include: { owner: true } },
        },
      });

      if (!item || item.restaurant.owner.clerkId !== auth.clerkId) {
        throw new ApiError("Menu item not found", 404);
      }

      // Remove existing tags and set new ones
      await prisma.$transaction(async (tx) => {
        await tx.menuItemDietaryTag.deleteMany({
          where: { menuItemId: itemId },
        });

        for (const tag of data.tags) {
          await tx.menuItemDietaryTag.create({
            data: {
              menuItemId: itemId,
              tagId: tag.tagId,
              source: tag.source,
              confidence: tag.confidence,
            },
          });
        }
      });

      const updated = await prisma.menuItemDietaryTag.findMany({
        where: { menuItemId: itemId },
        include: { tag: true },
      });

      return c.json(updated);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

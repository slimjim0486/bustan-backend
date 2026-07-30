import { Hono } from "hono";
import { z } from "zod";
import { ApiError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";
import {
  extractServicesFromSource,
  validateServiceExtraction,
} from "@/services/claude";

const serviceInputSchema = z.object({
  categoryId: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).max(120).optional(),
  name: z.string().trim().min(1).max(160),
  nameAr: z.string().trim().max(160).nullable().optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  priceAed: z.number().int().min(0).max(1_000_000),
  durationMinutes: z.number().int().min(5).max(1440).default(60),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
});

const serviceUpdateSchema = serviceInputSchema.partial();

const extractionSchema = z
  .object({
    restaurantId: z.string().trim().min(1),
    sourceText: z.string().max(200_000).optional(),
    fileName: z.string().trim().max(240).optional(),
    contentType: z
      .enum([
        "application/pdf",
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
      ])
      .optional(),
    base64: z.string().max(18_000_000).optional(),
  })
  .refine((input) => input.sourceText?.trim() || input.base64, {
    message: "Provide source text or a supported file",
  });

const importSchema = z.object({
  services: z.array(
    z.object({
      category: z.string().trim().min(1).max(120),
      name: z.string().trim().min(1).max(160),
      nameAr: z.string().trim().max(160).nullable().optional(),
      description: z.string().trim().max(1000).nullable().optional(),
      priceAed: z.number().int().min(0).max(1_000_000),
      durationMinutes: z.number().int().min(5).max(1440).nullable().optional(),
    })
  ).min(1).max(500),
});

async function assertOwnedRestaurant(
  restaurantId: string,
  clerkId: string
) {
  const restaurant = await prisma.restaurant.findFirst({
    where: { id: restaurantId, owner: { clerkId } },
    select: { id: true },
  });
  if (!restaurant) throw new ApiError("Business not found", 404);
}

const servicesRouteBase = new Hono<{
  Variables: {
    auth: {
      clerkId: string;
      email: string | null;
    };
  };
}>();

servicesRouteBase.use("*", requireAuth);

export const servicesRoute = servicesRouteBase
  .post("/extract", async (c) => {
    try {
      const auth = c.get("auth");
      const input = extractionSchema.parse(await c.req.json());
      await assertOwnedRestaurant(input.restaurantId, auth.clerkId);
      const draft = await extractServicesFromSource(input);
      return c.json(validateServiceExtraction(draft));
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .get("/:restaurantId", async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      await assertOwnedRestaurant(restaurantId, c.get("auth").clerkId);
      const categories = await prisma.serviceCategory.findMany({
        where: { restaurantId },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        include: {
          services: {
            orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
          },
        },
      });
      return c.json({ categories });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/:restaurantId/import", async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      await assertOwnedRestaurant(restaurantId, c.get("auth").clerkId);
      const input = importSchema.parse(await c.req.json());

      const result = await prisma.$transaction(async (tx) => {
        const categoryNames = Array.from(
          new Set(input.services.map((service) => service.category))
        );
        const existing = await tx.serviceCategory.findMany({
          where: { restaurantId, name: { in: categoryNames } },
        });
        const categoryByName = new Map(
          existing.map((category) => [category.name, category])
        );

        for (const [sortOrder, name] of categoryNames.entries()) {
          if (!categoryByName.has(name)) {
            const category = await tx.serviceCategory.create({
              data: { restaurantId, name, sortOrder },
            });
            categoryByName.set(name, category);
          }
        }

        const created = [];
        for (const [sortOrder, service] of input.services.entries()) {
          const category = categoryByName.get(service.category);
          if (!category) {
            throw new ApiError("Unable to create service category", 500);
          }
          created.push(
            await tx.service.create({
              data: {
                restaurantId,
                categoryId: category.id,
                name: service.name,
                nameAr: service.nameAr ?? null,
                description: service.description ?? null,
                priceAed: service.priceAed,
                durationMinutes: service.durationMinutes ?? 60,
                sortOrder,
              },
            })
          );
        }
        return created;
      });

      return c.json({ imported: result.length, services: result }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/:restaurantId", async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      await assertOwnedRestaurant(restaurantId, c.get("auth").clerkId);
      const input = serviceInputSchema
        .refine((value) => value.categoryId || value.category, {
          message: "Choose or name a service category",
        })
        .parse(await c.req.json());

      const service = await prisma.$transaction(async (tx) => {
        let categoryId = input.categoryId;
        if (categoryId) {
          const category = await tx.serviceCategory.findFirst({
            where: { id: categoryId, restaurantId },
            select: { id: true },
          });
          if (!category) throw new ApiError("Service category not found", 404);
        } else {
          const existing = await tx.serviceCategory.findFirst({
            where: { restaurantId, name: input.category! },
          });
          categoryId =
            existing?.id ??
            (
              await tx.serviceCategory.create({
                data: { restaurantId, name: input.category! },
              })
            ).id;
        }

        return tx.service.create({
          data: {
            restaurantId,
            categoryId,
            name: input.name,
            nameAr: input.nameAr ?? null,
            description: input.description ?? null,
            priceAed: input.priceAed,
            durationMinutes: input.durationMinutes,
            isActive: input.isActive,
            sortOrder: input.sortOrder,
          },
        });
      });
      return c.json({ service }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .put("/:restaurantId/:serviceId", async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      const serviceId = c.req.param("serviceId");
      await assertOwnedRestaurant(restaurantId, c.get("auth").clerkId);
      const input = serviceUpdateSchema.parse(await c.req.json());

      const existing = await prisma.service.findFirst({
        where: { id: serviceId, restaurantId },
      });
      if (!existing) throw new ApiError("Service not found", 404);

      if (input.categoryId) {
        const category = await prisma.serviceCategory.findFirst({
          where: { id: input.categoryId, restaurantId },
        });
        if (!category) throw new ApiError("Service category not found", 404);
      }

      const service = await prisma.service.update({
        where: { id: serviceId },
        data: {
          categoryId: input.categoryId,
          name: input.name,
          nameAr: input.nameAr,
          description: input.description,
          priceAed: input.priceAed,
          durationMinutes: input.durationMinutes,
          isActive: input.isActive,
          sortOrder: input.sortOrder,
        },
      });
      return c.json({ service });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .delete("/:restaurantId/:serviceId", async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      const serviceId = c.req.param("serviceId");
      await assertOwnedRestaurant(restaurantId, c.get("auth").clerkId);
      const existing = await prisma.service.findFirst({
        where: { id: serviceId, restaurantId },
        include: { _count: { select: { bookings: true } } },
      });
      if (!existing) throw new ApiError("Service not found", 404);
      if (existing._count.bookings > 0) {
        await prisma.service.update({
          where: { id: serviceId },
          data: { isActive: false },
        });
        return c.json({ deleted: false, deactivated: true });
      }
      await prisma.service.delete({ where: { id: serviceId } });
      return c.json({ deleted: true, deactivated: false });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

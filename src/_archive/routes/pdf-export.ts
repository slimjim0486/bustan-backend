import { Hono } from "hono";
import { getRestaurantEntitlements } from "@/lib/entitlements";
import { ApiError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { buildPublicMenuItemWhere } from "@/lib/menu-visibility";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";
import { generateQrDataUrl } from "@/lib/qr-code";

export const menuPrintRoute = new Hono()
  .get("/:restaurantId", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const { restaurantId } = c.req.param();

      const restaurant = await prisma.restaurant.findUnique({
        where: { id: restaurantId },
        include: {
          owner: { select: { clerkId: true } },
          operatorAccount: {
            select: {
              status: true,
              _count: {
                select: {
                  brands: true,
                },
              },
            },
          },
          subscription: { select: { plan: true, status: true } },
          menuSections: {
            orderBy: { displayOrder: "asc" },
            include: {
              items: {
                where: buildPublicMenuItemWhere(),
                orderBy: { displayOrder: "asc" },
                include: {
                  dietaryTags: {
                    include: {
                      tag: { select: { label: true } },
                    },
                  },
                },
              },
            },
          },
        },
      });

      if (!restaurant) {
        throw new ApiError("Restaurant not found", 404);
      }

      if (restaurant.owner.clerkId !== auth.clerkId) {
        throw new ApiError("Not authorized", 403);
      }

      const entitlements = getRestaurantEntitlements(restaurant);

      const restaurantQr = await generateQrDataUrl(
        `https://getbustan.com/${restaurant.slug}`,
        300
      );

      const whatsappQr = restaurant.whatsappNumber
        ? await generateQrDataUrl(
            `https://wa.me/${restaurant.whatsappNumber.replace(/[^0-9]/g, "")}`,
            200
          )
        : null;

      return c.json({
        restaurant: {
          name: restaurant.name,
          slug: restaurant.slug,
          cuisineType: restaurant.cuisineType,
          location: restaurant.location,
          themeKey: restaurant.themeKey,
          logoUrl: restaurant.logoUrl,
          whatsappNumber: restaurant.whatsappNumber,
        },
        sections: restaurant.menuSections.map((section) => ({
          name: section.name,
          items: section.items.map((item) => ({
            name: item.name,
            description: item.description,
            price: item.price ? Number(item.price) : null,
            currency: item.currency ?? "AED",
            dietaryTags: item.dietaryTags.map((dt) => dt.tag.label),
          })),
        })),
        hideBranding: entitlements.hideBranding,
        qrCodes: {
          restaurant: restaurantQr,
          whatsapp: whatsappQr,
        },
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

export const pdfExportRoute = menuPrintRoute;

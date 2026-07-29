import { Hono } from "hono";
import { z } from "zod";
import {
  getEffectiveRestaurantBillingState,
  getRestaurantEntitlements,
} from "@/lib/entitlements";
import { ApiError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { buildPublicMenuItemWhere } from "@/lib/dormant-menu-query";
import { prisma } from "@/lib/prisma";
import {
  assertAllowedPublicOrigin,
  consumeRateLimit,
  getClientIp,
} from "@/lib/public-request-guards";
import { requireAuth } from "@/middleware/auth";

const pageViewSchema = z.object({
  restaurantId: z.string().cuid(),
  path: z.string().min(1),
  referrer: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
});

const brandingClickSchema = z.object({
  restaurantId: z.string().cuid(),
  path: z.string().min(1).optional(),
  referrer: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
});

const menuItemLikeSchema = z.object({
  restaurantId: z.string().cuid(),
  menuItemId: z.string().cuid(),
  path: z.string().min(1),
  referrer: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
});

const analyticsImportSchema = z.object({
  source: z.enum([
    "google_business_profile",
    "instagram",
    "delivery_platform",
    "pos",
    "previous_menu_provider",
    "website_analytics",
    "other",
  ]),
  originalFileName: z.string().min(1).max(255),
  originalFileUrl: z.string().url().optional(),
  contentType: z.string().max(120).optional(),
  csvText: z.string().max(1_000_000).optional(),
});

const metricAliases: Record<string, string[]> = {
  views: [
    "views",
    "page_views",
    "page views",
    "menu_views",
    "menu views",
    "profile_views",
    "profile views",
    "visits",
    "sessions",
    "users",
  ],
  short_link_clicks: [
    "clicks",
    "link_clicks",
    "link clicks",
    "short_link_clicks",
    "short link clicks",
    "website_clicks",
    "website clicks",
    "menu_clicks",
    "menu clicks",
    "qr_scans",
    "qr scans",
  ],
  whatsapp_clicks: [
    "whatsapp",
    "whatsapp_clicks",
    "whatsapp clicks",
    "click_to_whatsapp",
    "click to whatsapp",
    "chat_clicks",
    "chat clicks",
  ],
  orders: ["orders", "order_count", "order count", "completed_orders", "completed orders"],
  revenue: ["revenue", "sales", "gross_sales", "gross sales", "total_sales", "total sales", "gmv"],
};

const dateAliases = ["date", "day", "metric_date", "metric date", "period", "period_start", "period start"];

function normalizeHeader(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function parseCsvRows(input: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(field.trim());
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(field.trim());
      if (row.some((cell) => cell.length > 0)) {
        rows.push(row);
      }
      row = [];
      field = "";
      continue;
    }

    field += char;
  }

  row.push(field.trim());
  if (row.some((cell) => cell.length > 0)) {
    rows.push(row);
  }

  return rows;
}

function parseDateOnly(value: string) {
  const trimmed = value.trim();
  const iso = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  }

  const slash = trimmed.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (slash) {
    const first = Number(slash[1]);
    const second = Number(slash[2]);
    const year = Number(slash[3].length === 2 ? `20${slash[3]}` : slash[3]);
    const dayFirst = first > 12;
    const month = dayFirst ? second : first;
    const day = dayFirst ? first : second;
    return new Date(Date.UTC(year, month - 1, day));
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

function parseMetricValue(value: string) {
  const cleaned = value.replace(/,/g, "").replace(/[^\d.-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") {
    return null;
  }
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractImportedMetrics(csvText: string) {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) {
    return { rowCount: Math.max(rows.length - 1, 0), metrics: [] };
  }

  const headers = rows[0].map(normalizeHeader);
  const dateIndex = headers.findIndex((header) => dateAliases.includes(header));
  if (dateIndex < 0) {
    return { rowCount: rows.length - 1, metrics: [] };
  }

  const metricColumns = Object.entries(metricAliases).flatMap(([metricType, aliases]) =>
    headers
      .map((header, index) => ({ header, index }))
      .filter((entry) => aliases.includes(entry.header))
      .map((entry) => ({ metricType, index: entry.index }))
  );

  const metricsByKey = new Map<
    string,
    {
      metricDate: Date;
      metricType: string;
      value: number;
      unit: string;
      currency: string | null;
    }
  >();

  for (const row of rows.slice(1, 1001)) {
    const metricDate = parseDateOnly(row[dateIndex] ?? "");
    if (!metricDate) {
      continue;
    }

    for (const column of metricColumns) {
      const parsed = parseMetricValue(row[column.index] ?? "");
      if (parsed === null) {
        continue;
      }

      const metricDay = metricDate.toISOString().slice(0, 10);
      const key = `${metricDay}:${column.metricType}`;
      const existing = metricsByKey.get(key);

      if (existing) {
        existing.value += parsed;
      } else {
        metricsByKey.set(key, {
          metricDate,
          metricType: column.metricType,
          value: parsed,
          unit: column.metricType === "revenue" ? "money" : "count",
          currency: column.metricType === "revenue" ? "AED" : null,
        });
      }
    }
  }

  return {
    rowCount: rows.length - 1,
    metrics: Array.from(metricsByKey.values()).map((metric) => ({
      ...metric,
      value: metric.value.toFixed(2),
    })),
  };
}

export const analyticsRoute = new Hono<{
  Variables: {
    auth: {
      clerkId: string;
      email: string | null;
    };
  };
}>()
  .post("/page-view", async (c) => {
    try {
      const clientIp = getClientIp(c);
      assertAllowedPublicOrigin(c);

      const data = pageViewSchema.parse(await c.req.json());
      const restaurant = await prisma.restaurant.findUnique({
        where: { id: data.restaurantId },
        include: {
          subscription: true,
          operatorAccount: {
            include: {
              _count: {
                select: {
                  brands: true,
                },
              },
            },
          },
        },
      });

      if (!restaurant) {
        throw new ApiError("Restaurant not found", 404);
      }

      const effectiveBillingState = getEffectiveRestaurantBillingState(restaurant);
      if (!effectiveBillingState.isPublished) {
        throw new ApiError("Restaurant not found", 404);
      }

      const allowedPaths = new Set([
        `/${restaurant.slug}`,
        `/embed/${restaurant.slug}`,
      ]);

      if (!allowedPaths.has(data.path)) {
        throw new ApiError("Invalid analytics path", 400);
      }

      const globalLimit = consumeRateLimit({
        key: `analytics:global:${clientIp}`,
        limit: 120,
        windowMs: 10 * 60_000,
      });
      if (!globalLimit.allowed) {
        return c.json({ ok: true, rateLimited: true }, 202);
      }

      const perPageLimit = consumeRateLimit({
        key: `analytics:page:${clientIp}:${data.restaurantId}:${data.path}`,
        limit: 3,
        windowMs: 30 * 60_000,
      });
      if (!perPageLimit.allowed) {
        return c.json({ ok: true, rateLimited: true }, 202);
      }

      await prisma.pageView.create({
        data: {
          restaurantId: data.restaurantId,
          path: data.path,
          referrer: data.referrer ?? null,
          userAgent: data.userAgent ?? null,
        },
      });

      return c.json({ ok: true }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/branding-click", async (c) => {
    try {
      const clientIp = getClientIp(c);
      assertAllowedPublicOrigin(c);

      const data = brandingClickSchema.parse(await c.req.json());
      const restaurant = await prisma.restaurant.findUnique({
        where: { id: data.restaurantId },
        include: {
          subscription: true,
          operatorAccount: {
            include: {
              _count: {
                select: {
                  brands: true,
                },
              },
            },
          },
        },
      });

      if (!restaurant) {
        throw new ApiError("Restaurant not found", 404);
      }

      const effectiveBillingState = getEffectiveRestaurantBillingState(restaurant);
      if (!effectiveBillingState.isPublished) {
        throw new ApiError("Restaurant not found", 404);
      }

      const globalLimit = consumeRateLimit({
        key: `analytics:branding:global:${clientIp}`,
        limit: 30,
        windowMs: 10 * 60_000,
      });
      if (!globalLimit.allowed) {
        return c.json({ ok: true, rateLimited: true }, 202);
      }

      const perRestaurantLimit = consumeRateLimit({
        key: `analytics:branding:${clientIp}:${data.restaurantId}`,
        limit: 1,
        windowMs: 30 * 60_000,
      });
      if (!perRestaurantLimit.allowed) {
        return c.json({ ok: true, rateLimited: true }, 202);
      }

      await prisma.brandingClick.create({
        data: {
          restaurantId: data.restaurantId,
          path: data.path ?? null,
          referrer: data.referrer ?? null,
          userAgent: data.userAgent ?? null,
        },
      });

      return c.json({ ok: true }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/menu-item-like", async (c) => {
    try {
      const clientIp = getClientIp(c);
      assertAllowedPublicOrigin(c);

      const data = menuItemLikeSchema.parse(await c.req.json());
      const restaurant = await prisma.restaurant.findUnique({
        where: { id: data.restaurantId },
        include: {
          subscription: true,
          operatorAccount: {
            include: {
              _count: {
                select: {
                  brands: true,
                },
              },
            },
          },
        },
      });

      if (!restaurant) {
        throw new ApiError("Restaurant not found", 404);
      }

      const effectiveBillingState = getEffectiveRestaurantBillingState(restaurant);
      if (!effectiveBillingState.isPublished) {
        throw new ApiError("Restaurant not found", 404);
      }

      const allowedPaths = new Set([
        `/${restaurant.slug}`,
        `/embed/${restaurant.slug}`,
      ]);

      if (!allowedPaths.has(data.path)) {
        throw new ApiError("Invalid analytics path", 400);
      }

      const menuItem = await prisma.menuItem.findFirst({
        where: {
          ...buildPublicMenuItemWhere(),
          id: data.menuItemId,
          restaurantId: data.restaurantId,
        },
        select: {
          id: true,
        },
      });

      if (!menuItem) {
        throw new ApiError("Menu item not found", 404);
      }

      const globalLimit = consumeRateLimit({
        key: `analytics:item-like:global:${clientIp}`,
        limit: 120,
        windowMs: 10 * 60_000,
      });
      if (!globalLimit.allowed) {
        return c.json({ ok: true, rateLimited: true }, 202);
      }

      const perItemLimit = consumeRateLimit({
        key: `analytics:item-like:${clientIp}:${data.restaurantId}:${data.menuItemId}`,
        limit: 1,
        windowMs: 24 * 60 * 60_000,
      });
      if (!perItemLimit.allowed) {
        return c.json({ ok: true, rateLimited: true }, 202);
      }

      await prisma.menuItemLike.create({
        data: {
          restaurantId: data.restaurantId,
          menuItemId: data.menuItemId,
          path: data.path,
          referrer: data.referrer ?? null,
          userAgent: data.userAgent ?? null,
        },
      });

      return c.json({ ok: true }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/:restaurantId/imports", requireAuth, async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      const auth = c.get("auth");
      const data = analyticsImportSchema.parse(await c.req.json());

      const restaurant = await prisma.restaurant.findFirst({
        where: {
          id: restaurantId,
          owner: {
            clerkId: auth.clerkId,
          },
        },
        select: {
          id: true,
        },
      });

      if (!restaurant) {
        throw new ApiError("Restaurant not found", 404);
      }

      const hasCsv =
        Boolean(data.csvText?.trim()) ||
        data.contentType?.includes("csv") ||
        data.originalFileName.toLowerCase().endsWith(".csv");
      const parsed = data.csvText ? extractImportedMetrics(data.csvText) : null;

      if (hasCsv && (!parsed || parsed.metrics.length === 0)) {
        throw new ApiError(
          "CSV needs a date column and at least one supported metric column: views, clicks, WhatsApp clicks, orders, or revenue.",
          400
        );
      }

      const dates = parsed?.metrics.map((metric) => metric.metricDate.getTime()) ?? [];
      const startedOn = dates.length ? new Date(Math.min(...dates)) : null;
      const endedOn = dates.length ? new Date(Math.max(...dates)) : null;
      const status = parsed?.metrics.length ? "imported" : "needs_review";
      const notes =
        status === "needs_review"
          ? "File saved for manual review. PDF analytics extraction is not automated yet."
          : null;

      const analyticsImport = await prisma.$transaction(async (tx) => {
        const created = await tx.analyticsImport.create({
          data: {
            restaurantId,
            source: data.source,
            status,
            originalFileName: data.originalFileName,
            originalFileUrl: data.originalFileUrl ?? null,
            contentType: data.contentType ?? null,
            rowCount: parsed?.rowCount ?? 0,
            metricCount: parsed?.metrics.length ?? 0,
            startedOn,
            endedOn,
            notes,
          },
        });

        if (parsed?.metrics.length) {
          await tx.analyticsImportMetric.createMany({
            data: parsed.metrics.map((metric) => ({
              importId: created.id,
              restaurantId,
              metricDate: metric.metricDate,
              metricType: metric.metricType,
              value: metric.value,
              unit: metric.unit,
              currency: metric.currency,
            })),
          });
        }

        return created;
      });

      return c.json(
        {
          id: analyticsImport.id,
          source: analyticsImport.source,
          status: analyticsImport.status,
          originalFileName: analyticsImport.originalFileName,
          rowCount: analyticsImport.rowCount,
          metricCount: analyticsImport.metricCount,
          startedOn: analyticsImport.startedOn?.toISOString() ?? null,
          endedOn: analyticsImport.endedOn?.toISOString() ?? null,
          notes: analyticsImport.notes,
          createdAt: analyticsImport.createdAt.toISOString(),
        },
        201
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .get("/:restaurantId", requireAuth, async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      const auth = c.get("auth");

      const restaurant = await prisma.restaurant.findFirst({
        where: {
          id: restaurantId,
          owner: {
            clerkId: auth.clerkId,
          },
        },
        include: {
          subscription: true,
          operatorAccount: {
            include: {
              _count: {
                select: {
                  brands: true,
                },
              },
            },
          },
        },
      });

      if (!restaurant) {
        throw new ApiError("Restaurant not found", 404);
      }

      const entitlements = getRestaurantEntitlements(restaurant);
      const includeTopPaths = entitlements.analyticsTier === "advanced";
      const activeShortLink = await prisma.restaurantShortLink.findUnique({
        where: { restaurantId },
        select: {
          id: true,
          code: true,
        },
      });

      const todayCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const weekCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const emptyTopPaths: Array<{ path: string; _count: { path: number } }> = [];
      const emptyTopLikedItems: Array<{ menuItemId: string; _count: { menuItemId: number } }> = [];
      const emptyTopOrderedItems: Array<{
        menuItemId: string | null;
        _sum: { quantity: number | null };
      }> = [];

      const [
        totalViews,
        viewsToday,
        viewsThisWeek,
        topPaths,
        shortLinkTotalClicks,
        shortLinkClicksToday,
        shortLinkClicksThisWeek,
        whatsappTotalClicks,
        whatsappClicksToday,
        whatsappClicksThisWeek,
        whatsappOrderClicks,
        cartOrdersTotal,
        cartOrdersThisWeek,
        cartRevenueTotal,
        cartRevenueThisWeek,
        topOrderedItemGroups,
        menuItemLikesTotal,
        menuItemLikesToday,
        menuItemLikesThisWeek,
        topLikedItemGroups,
        brandingTotalClicks,
        brandingClicksThisWeek,
        analyticsImports,
        importedMetricGroups,
      ] = await Promise.all([
        prisma.pageView.count({ where: { restaurantId } }),
        prisma.pageView.count({
          where: {
            restaurantId,
            createdAt: {
              gte: todayCutoff,
            },
          },
        }),
        prisma.pageView.count({
          where: {
            restaurantId,
            createdAt: {
              gte: weekCutoff,
            },
          },
        }),
        includeTopPaths
          ? prisma.pageView.groupBy({
              by: ["path"],
              where: { restaurantId },
              _count: {
                path: true,
              },
              orderBy: {
                _count: {
                  path: "desc",
                },
              },
              take: 5,
            })
          : Promise.resolve(emptyTopPaths),
        activeShortLink
          ? prisma.restaurantShortLinkClick.count({
              where: {
                restaurantId,
                shortLinkId: activeShortLink.id,
              },
            })
          : Promise.resolve(0),
        activeShortLink
          ? prisma.restaurantShortLinkClick.count({
              where: {
                restaurantId,
                shortLinkId: activeShortLink.id,
                createdAt: {
                  gte: todayCutoff,
                },
              },
            })
          : Promise.resolve(0),
        activeShortLink
          ? prisma.restaurantShortLinkClick.count({
              where: {
                restaurantId,
                shortLinkId: activeShortLink.id,
                createdAt: {
                  gte: weekCutoff,
                },
              },
            })
          : Promise.resolve(0),
        prisma.whatsAppClick.count({
          where: {
            restaurantId,
          },
        }),
        prisma.whatsAppClick.count({
          where: {
            restaurantId,
            createdAt: {
              gte: todayCutoff,
            },
          },
        }),
        prisma.whatsAppClick.count({
          where: {
            restaurantId,
            createdAt: {
              gte: weekCutoff,
            },
          },
        }),
        prisma.whatsAppClick.count({
          where: {
            restaurantId,
            source: "cart_order",
          },
        }),
        prisma.whatsAppCartOrder.count({
          where: {
            restaurantId,
          },
        }),
        prisma.whatsAppCartOrder.count({
          where: {
            restaurantId,
            createdAt: {
              gte: weekCutoff,
            },
          },
        }),
        prisma.whatsAppCartOrder.aggregate({
          where: {
            restaurantId,
          },
          _sum: {
            totalPrice: true,
          },
        }),
        prisma.whatsAppCartOrder.aggregate({
          where: {
            restaurantId,
            createdAt: {
              gte: weekCutoff,
            },
          },
          _sum: {
            totalPrice: true,
          },
        }),
        prisma.whatsAppCartOrderItem
          .groupBy({
            by: ["menuItemId"],
            where: {
              menuItemId: {
                not: null,
              },
              order: {
                restaurantId,
              },
            },
            _sum: {
              quantity: true,
            },
            orderBy: {
              _sum: {
                quantity: "desc",
              },
            },
            take: 5,
          })
          .catch(() => emptyTopOrderedItems),
        prisma.menuItemLike.count({
          where: {
            restaurantId,
          },
        }),
        prisma.menuItemLike.count({
          where: {
            restaurantId,
            createdAt: {
              gte: todayCutoff,
            },
          },
        }),
        prisma.menuItemLike.count({
          where: {
            restaurantId,
            createdAt: {
              gte: weekCutoff,
            },
          },
        }),
        prisma.menuItemLike.groupBy({
          by: ["menuItemId"],
          where: {
            restaurantId,
          },
          _count: {
            menuItemId: true,
          },
          orderBy: {
            _count: {
              menuItemId: "desc",
            },
          },
          take: 5,
        }).catch(() => emptyTopLikedItems),
        prisma.brandingClick.count({ where: { restaurantId } }),
        prisma.brandingClick.count({
          where: { restaurantId, createdAt: { gte: weekCutoff } },
        }),
        prisma.analyticsImport.findMany({
          where: { restaurantId },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: {
            id: true,
            source: true,
            status: true,
            originalFileName: true,
            rowCount: true,
            metricCount: true,
            startedOn: true,
            endedOn: true,
            notes: true,
            createdAt: true,
          },
        }),
        prisma.analyticsImportMetric.groupBy({
          by: ["metricType"],
          where: { restaurantId },
          _sum: {
            value: true,
          },
        }),
      ]);

      const topLikedItems =
        topLikedItemGroups.length === 0
          ? []
          : await prisma.menuItem.findMany({
              where: {
                id: {
                  in: topLikedItemGroups.map((entry) => entry.menuItemId),
                },
                restaurantId,
              },
              select: {
                id: true,
                name: true,
              },
            }).then((items) => {
              const itemsById = new Map(items.map((item) => [item.id, item]));

              return topLikedItemGroups
                .map((entry) => {
                  const menuItem = itemsById.get(entry.menuItemId);
                  if (!menuItem) {
                    return null;
                  }

                  return {
                    menuItemId: menuItem.id,
                    name: menuItem.name,
                    likes: entry._count.menuItemId,
                  };
                })
                .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
            });
      const topOrderedItems =
        topOrderedItemGroups.length === 0
          ? []
          : await prisma.menuItem
              .findMany({
                where: {
                  id: {
                    in: topOrderedItemGroups
                      .map((entry) => entry.menuItemId)
                      .filter((entry): entry is string => Boolean(entry)),
                  },
                  restaurantId,
                },
                select: {
                  id: true,
                  name: true,
                },
              })
              .then((items) => {
                const itemsById = new Map(items.map((item) => [item.id, item]));

                return topOrderedItemGroups
                  .map((entry) => {
                    if (!entry.menuItemId) {
                      return null;
                    }

                    return {
                      menuItemId: entry.menuItemId,
                      name: itemsById.get(entry.menuItemId)?.name ?? "Deleted item",
                      totalOrdered: entry._sum.quantity ?? 0,
                    };
                  })
                  .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
              });
      const inquiryClicks = Math.max(whatsappTotalClicks - whatsappOrderClicks, 0);
      const estimatedRevenue = Number(cartRevenueTotal._sum.totalPrice ?? 0);
      const estimatedRevenueThisWeek = Number(cartRevenueThisWeek._sum.totalPrice ?? 0);
      const importedTotals = importedMetricGroups.reduce<Record<string, number>>((acc, entry) => {
        acc[entry.metricType] = Number(entry._sum.value ?? 0);
        return acc;
      }, {});

      return c.json({
        tier: entitlements.analyticsTier,
        totalViews,
        viewsToday,
        viewsThisWeek,
        likes: {
          total: menuItemLikesTotal,
          today: menuItemLikesToday,
          thisWeek: menuItemLikesThisWeek,
          topItems: topLikedItems,
        },
        whatsapp: restaurant.whatsappNumber
          ? {
              totalClicks: whatsappTotalClicks,
              clicksToday: whatsappClicksToday,
              clicksThisWeek: whatsappClicksThisWeek,
              inquiryClicks,
              orderClicks: whatsappOrderClicks,
              orders: {
                total: cartOrdersTotal,
                thisWeek: cartOrdersThisWeek,
                estimatedRevenue,
                estimatedRevenueThisWeek,
                topItems: topOrderedItems,
              },
            }
          : null,
        shortLink: activeShortLink
          ? {
              code: activeShortLink.code,
              totalClicks: shortLinkTotalClicks,
              clicksToday: shortLinkClicksToday,
              clicksThisWeek: shortLinkClicksThisWeek,
            }
          : null,
        topPaths: topPaths.map((entry) => ({
          path: entry.path,
          views: entry._count.path,
        })),
        branding: {
          totalClicks: brandingTotalClicks,
          clicksThisWeek: brandingClicksThisWeek,
        },
        importedBaseline: {
          totals: importedTotals,
          imports: analyticsImports.map((entry) => ({
            id: entry.id,
            source: entry.source,
            status: entry.status,
            originalFileName: entry.originalFileName,
            rowCount: entry.rowCount,
            metricCount: entry.metricCount,
            startedOn: entry.startedOn?.toISOString() ?? null,
            endedOn: entry.endedOn?.toISOString() ?? null,
            notes: entry.notes,
            createdAt: entry.createdAt.toISOString(),
          })),
        },
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

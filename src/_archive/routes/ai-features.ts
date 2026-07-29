import { Hono } from "hono";
import { z } from "zod";
import { getRestaurantEntitlements } from "@/lib/entitlements";
import {
  checkAiLimit,
  computeMenuHash,
  getAiUsageSummary,
  logAiUsage,
} from "@/lib/ai-usage";
import { ApiError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";
import { sendLifecycleEmail } from "@/services/email";
import {
  enhanceSingleDescription,
  enhanceBulkDescriptions,
  suggestPromotionContent,
} from "@/services/description-writer";
import { suggestDietaryTags } from "@/services/dietary-tagger";
import { analyzeMenu, normalizeMenuAnalysisResult } from "@/services/menu-analyzer";

const enhanceSchema = z.object({
  menuItemId: z.string().min(1),
  tone: z.enum(["casual", "upscale", "playful", "formal"]).optional(),
});

const bulkEnhanceSchema = z.object({
  restaurantId: z.string().min(1),
  mode: z.enum(["missing", "weak", "all"]),
  tone: z.enum(["casual", "upscale", "playful", "formal"]).optional(),
});

const promotionContentSchema = z.object({
  restaurantId: z.string().min(1),
  type: z.enum(["discounted_item", "deal", "combo"]),
  itemIds: z.array(z.string().min(1)).min(1),
  title: z.string().optional().nullable(),
  subtitle: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  badgeLabel: z.string().optional().nullable(),
  terms: z.string().optional().nullable(),
  promoPrice: z.string().optional().nullable(),
  startsAt: z.string().optional().nullable(),
  endsAt: z.string().optional().nullable(),
  tone: z.enum(["casual", "upscale", "playful", "formal"]).optional(),
});

const acceptDescriptionsSchema = z.object({
  actions: z.array(
    z.object({
      menuItemId: z.string().min(1),
      action: z.enum(["accept", "reject"]),
      description: z.string().optional(),
    })
  ),
});

const suggestTagsSchema = z.object({
  restaurantId: z.string().min(1),
});

const setTagsSchema = z.object({
  tags: z.array(
    z.object({
      tagId: z.string().min(1),
      source: z.enum(["manual", "ai_suggested", "ai_confirmed"]).default("manual"),
      confidence: z.number().optional(),
    })
  ),
});

const confirmTagsBulkSchema = z.object({
  actions: z.array(
    z.object({
      menuItemId: z.string().min(1),
      tagId: z.string().min(1),
      action: z.enum(["confirm", "reject"]),
    })
  ),
});

const analyzeMenuSchema = z.object({
  restaurantId: z.string().min(1),
});

const applyMenuFixSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1),
    kind: z.literal("adjust_price"),
    menuItemId: z.string().min(1),
    suggestedPrice: z.number().positive(),
    reason: z.string().min(1).max(400),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("replace_description"),
    menuItemId: z.string().min(1),
    suggestedDescription: z.string().min(1).max(400),
    reason: z.string().min(1).max(400),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("add_menu_item"),
    targetSectionName: z.string().min(1).max(120),
    suggestedName: z.string().min(1).max(120),
    suggestedDescription: z.string().min(1).max(400),
    suggestedPrice: z.number().positive(),
    reason: z.string().min(1).max(400),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("normalize_name"),
    menuItemId: z.string().min(1),
    suggestedName: z.string().min(1).max(120),
    reason: z.string().min(1).max(400),
  }),
]);

const applyMenuFixesSchema = z.object({
  restaurantId: z.string().min(1),
  mode: z.enum(["stage", "apply"]).default("stage"),
  fixes: z.array(applyMenuFixSchema).min(1).max(50),
});

type ApplyMenuFix = z.infer<typeof applyMenuFixSchema>;
type PreparedMenuFix =
  | {
      fixId: string;
      kind: "adjust_price";
      itemId: string;
      suggestedPrice: number;
      preview: StagedMenuFix;
    }
  | {
      fixId: string;
      kind: "replace_description";
      itemId: string;
      suggestedDescription: string;
      preview: StagedMenuFix;
    }
  | {
      fixId: string;
      kind: "normalize_name";
      itemId: string;
      suggestedName: string;
      preview: StagedMenuFix;
    }
  | {
      fixId: string;
      kind: "add_menu_item";
      targetSectionName: string;
      suggestedName: string;
      suggestedDescription: string;
      suggestedPrice: number;
      preview: StagedMenuFix;
    };

interface StagedMenuFix {
  fixId: string;
  kind: ApplyMenuFix["kind"];
  title: string;
  targetLabel: string;
  sectionName: string | null;
  reason: string;
  willCreateSection: boolean;
  preview: {
    field: "price" | "description" | "name" | "item";
    before: string | null;
    after: string;
  };
}

async function getOwnedRestaurant(restaurantId: string, clerkId: string) {
  const restaurant = await prisma.restaurant.findFirst({
    where: {
      id: restaurantId,
      owner: { clerkId },
    },
    include: {
      owner: {
        select: {
          email: true,
          fullName: true,
        },
      },
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

  return restaurant;
}

function normalizeComparableText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeOptionalText(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function formatAed(value: number) {
  return `AED ${value.toFixed(2)}`;
}

function formatNewItemPreview(input: {
  name: string;
  description: string;
  price: number;
}) {
  return `${input.name} • ${input.description} • ${formatAed(input.price)}`;
}

async function buildStagedMenuFixes(
  restaurantId: string,
  fixes: ApplyMenuFix[]
): Promise<{
  stagedFixes: StagedMenuFix[];
  preparedFixes: PreparedMenuFix[];
  warnings: string[];
}> {
  const sections = await prisma.menuSection.findMany({
    where: { restaurantId },
    orderBy: { displayOrder: "asc" },
    include: {
      items: {
        orderBy: { displayOrder: "asc" },
        select: {
          id: true,
          name: true,
          description: true,
          price: true,
        },
      },
    },
  });

  const itemMap = new Map(
    sections.flatMap((section) =>
      section.items.map((item) => [
        item.id,
        {
          ...item,
          price: Number(item.price),
          sectionName: section.name,
        },
      ])
    )
  );

  const sectionMap = new Map(
    sections.map((section) => [normalizeComparableText(section.name), section])
  );

  const stagedFixes: StagedMenuFix[] = [];
  const preparedFixes: PreparedMenuFix[] = [];
  const warnings: string[] = [];
  const seenFixIds = new Set<string>();

  for (const fix of fixes) {
    if (seenFixIds.has(fix.id)) {
      continue;
    }

    seenFixIds.add(fix.id);

    if (fix.kind === "adjust_price") {
      const item = itemMap.get(fix.menuItemId);
      if (!item) {
        warnings.push(`Skipped a pricing fix because the menu item no longer exists.`);
        continue;
      }

      const suggestedPrice = Number(fix.suggestedPrice.toFixed(2));
      if (item.price === suggestedPrice) {
        warnings.push(`Skipped ${item.name} because the price already matches the AI suggestion.`);
        continue;
      }

      const preview: StagedMenuFix = {
        fixId: fix.id,
        kind: fix.kind,
        title: "Adjust price",
        targetLabel: item.name,
        sectionName: item.sectionName,
        reason: fix.reason,
        willCreateSection: false,
        preview: {
          field: "price",
          before: formatAed(item.price),
          after: formatAed(suggestedPrice),
        },
      };

      stagedFixes.push(preview);
      preparedFixes.push({
        fixId: fix.id,
        kind: fix.kind,
        itemId: item.id,
        suggestedPrice,
        preview,
      });
      continue;
    }

    if (fix.kind === "replace_description") {
      const item = itemMap.get(fix.menuItemId);
      if (!item) {
        warnings.push(`Skipped a description fix because the menu item no longer exists.`);
        continue;
      }

      const suggestedDescription = fix.suggestedDescription.trim();
      if (!suggestedDescription) {
        warnings.push(`Skipped ${item.name} because the AI description was empty.`);
        continue;
      }

      if ((item.description ?? "").trim() === suggestedDescription) {
        warnings.push(`Skipped ${item.name} because the description already matches the AI suggestion.`);
        continue;
      }

      const preview: StagedMenuFix = {
        fixId: fix.id,
        kind: fix.kind,
        title: "Replace description",
        targetLabel: item.name,
        sectionName: item.sectionName,
        reason: fix.reason,
        willCreateSection: false,
        preview: {
          field: "description",
          before: item.description ?? null,
          after: suggestedDescription,
        },
      };

      stagedFixes.push(preview);
      preparedFixes.push({
        fixId: fix.id,
        kind: fix.kind,
        itemId: item.id,
        suggestedDescription,
        preview,
      });
      continue;
    }

    if (fix.kind === "normalize_name") {
      const item = itemMap.get(fix.menuItemId);
      if (!item) {
        warnings.push(`Skipped a naming fix because the menu item no longer exists.`);
        continue;
      }

      const suggestedName = fix.suggestedName.trim();
      if (!suggestedName) {
        warnings.push(`Skipped ${item.name} because the AI naming suggestion was empty.`);
        continue;
      }

      if (item.name.trim() === suggestedName) {
        warnings.push(`Skipped ${item.name} because the name already matches the AI suggestion.`);
        continue;
      }

      const preview: StagedMenuFix = {
        fixId: fix.id,
        kind: fix.kind,
        title: "Normalize naming",
        targetLabel: item.name,
        sectionName: item.sectionName,
        reason: fix.reason,
        willCreateSection: false,
        preview: {
          field: "name",
          before: item.name,
          after: suggestedName,
        },
      };

      stagedFixes.push(preview);
      preparedFixes.push({
        fixId: fix.id,
        kind: fix.kind,
        itemId: item.id,
        suggestedName,
        preview,
      });
      continue;
    }

    const targetSectionName = fix.targetSectionName.trim();
    const normalizedSectionName = normalizeComparableText(targetSectionName);
    const existingSection = sectionMap.get(normalizedSectionName);
    const suggestedName = fix.suggestedName.trim();
    const suggestedDescription = fix.suggestedDescription.trim();
    const suggestedPrice = Number(fix.suggestedPrice.toFixed(2));

    if (!targetSectionName || !suggestedName || !suggestedDescription) {
      warnings.push(`Skipped an item-add suggestion because part of the AI payload was empty.`);
      continue;
    }

    const duplicateInSection = existingSection?.items.some(
      (item) => normalizeComparableText(item.name) === normalizeComparableText(suggestedName)
    );

    if (duplicateInSection) {
      warnings.push(`Skipped ${suggestedName} because a similarly named dish already exists in ${targetSectionName}.`);
      continue;
    }

    const preview: StagedMenuFix = {
      fixId: fix.id,
      kind: fix.kind,
      title: "Add suggested menu item",
      targetLabel: suggestedName,
      sectionName: targetSectionName,
      reason: fix.reason,
      willCreateSection: !existingSection,
      preview: {
        field: "item",
        before: null,
        after: formatNewItemPreview({
          name: suggestedName,
          description: suggestedDescription,
          price: suggestedPrice,
        }),
      },
    };

    stagedFixes.push(preview);
    preparedFixes.push({
      fixId: fix.id,
      kind: fix.kind,
      targetSectionName,
      suggestedName,
      suggestedDescription,
      suggestedPrice,
      preview,
    });
  }

  return {
    stagedFixes,
    preparedFixes,
    warnings,
  };
}

async function applyPreparedMenuFixes(
  restaurantId: string,
  preparedFixes: PreparedMenuFix[]
) {
  await prisma.$transaction(async (tx) => {
    const sections = await tx.menuSection.findMany({
      where: { restaurantId },
      orderBy: { displayOrder: "asc" },
      include: {
        items: {
          orderBy: { displayOrder: "asc" },
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    const sectionMap = new Map(
      sections.map((section) => [normalizeComparableText(section.name), section])
    );
    const itemCounts = new Map(sections.map((section) => [section.id, section.items.length]));
    let nextSectionOrder = sections.reduce(
      (max, section) => Math.max(max, section.displayOrder + 1),
      0
    );

    for (const fix of preparedFixes) {
      if (fix.kind === "adjust_price") {
        await tx.menuItem.update({
          where: { id: fix.itemId },
          data: {
            price: fix.suggestedPrice,
          },
        });
        continue;
      }

      if (fix.kind === "replace_description") {
        await tx.menuItem.update({
          where: { id: fix.itemId },
          data: {
            description: normalizeOptionalText(fix.suggestedDescription),
          },
        });
        continue;
      }

      if (fix.kind === "normalize_name") {
        await tx.menuItem.update({
          where: { id: fix.itemId },
          data: {
            name: fix.suggestedName,
          },
        });
        continue;
      }

      const normalizedSectionName = normalizeComparableText(fix.targetSectionName);
      let section = sectionMap.get(normalizedSectionName);

      if (!section) {
        section = await tx.menuSection.create({
          data: {
            restaurantId,
            name: fix.targetSectionName,
            displayOrder: nextSectionOrder,
          },
          include: {
            items: {
              orderBy: { displayOrder: "asc" },
              select: {
                id: true,
                name: true,
              },
            },
          },
        });
        sectionMap.set(normalizedSectionName, section);
        itemCounts.set(section.id, 0);
        nextSectionOrder += 1;
      }

      const displayOrder = itemCounts.get(section.id) ?? 0;

      await tx.menuItem.create({
        data: {
          restaurantId,
          sectionId: section.id,
          name: fix.suggestedName,
          description: normalizeOptionalText(fix.suggestedDescription),
          price: fix.suggestedPrice,
          currency: "AED",
          displayOrder,
        },
      });

      itemCounts.set(section.id, displayOrder + 1);
    }
  });
}

async function maybeSendMenuHealthDropNotification(input: {
  restaurantId: string;
  restaurantName: string;
  recipientEmail: string | null;
}) {
  try {
    if (!input.recipientEmail) {
      return;
    }

    const analyses = await prisma.menuAnalysis.findMany({
      where: {
        restaurantId: input.restaurantId,
        analysisType: "full",
      },
      orderBy: { createdAt: "desc" },
      take: 2,
    });

    if (analyses.length < 2) {
      return;
    }

    const latest = normalizeMenuAnalysisResult(analyses[0].result);
    const previous = normalizeMenuAnalysisResult(analyses[1].result);
    if (latest.overallScore >= previous.overallScore) {
      return;
    }

    const droppedCategories = Object.entries(latest.categories)
      .map(([key, category]) => {
        const previousCategory = previous.categories[key as keyof typeof previous.categories];
        return {
          title: category.title,
          delta: category.score - previousCategory.score,
        };
      })
      .filter((entry) => entry.delta < 0)
      .sort((a, b) => a.delta - b.delta)
      .slice(0, 3);

    const highlights = droppedCategories.length
      ? `<ul>${droppedCategories
          .map(
            (entry) =>
              `<li>${entry.title}: ${Math.abs(entry.delta)} point${Math.abs(entry.delta) === 1 ? "" : "s"} lower</li>`
          )
          .join("")}</ul>`
      : "";

    await sendLifecycleEmail({
      to: input.recipientEmail,
      subject: `${input.restaurantName} menu health dropped from ${previous.overallScore} to ${latest.overallScore}`,
      html: `
        <p>Your latest menu analysis found a drop in menu health for <strong>${input.restaurantName}</strong>.</p>
        <p>Score change: <strong>${previous.overallScore}</strong> to <strong>${latest.overallScore}</strong>.</p>
        ${highlights}
        <p>Open Menu Insights to review the staged AI fixes and bring the score back up.</p>
      `,
    });
  } catch (error) {
    console.error("Failed to send menu health notification", error);
  }
}

export const aiFeaturesRoute = new Hono<{
  Variables: {
    auth: {
      clerkId: string;
      email: string | null;
    };
  };
}>()

  // ── Description Writer ──────────────────────────────────────────
  .post("/enhance-description", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const data = enhanceSchema.parse(await c.req.json());

      const item = await prisma.menuItem.findUnique({
        where: { id: data.menuItemId },
        include: {
          section: true,
          restaurant: {
            include: {
              owner: true,
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
          },
        },
      });

      if (!item || item.restaurant.owner.clerkId !== auth.clerkId) {
        throw new ApiError("Menu item not found", 404);
      }

      const entitlements = getRestaurantEntitlements(item.restaurant);
      const limit = await checkAiLimit(
        item.restaurantId,
        "description_enhance",
        entitlements.aiDescriptionLimit
      );

      if (!limit.allowed) {
        throw new ApiError(
          `Description enhancement limit reached (${limit.used}/${entitlements.aiDescriptionLimit} this month). Upgrade for more.`,
          403
        );
      }

      const result = await enhanceSingleDescription(
        {
          id: item.id,
          name: item.name,
          description: item.description,
          price: item.price.toString(),
          sectionName: item.section.name,
        },
        {
          name: item.restaurant.name,
          cuisineType: item.restaurant.cuisineType,
          location: item.restaurant.location,
        },
        data.tone
      );

      await logAiUsage(
        item.restaurantId,
        "description_enhance",
        result.tokensIn,
        result.tokensOut
      );

      // Store as suggestion
      await prisma.menuItem.update({
        where: { id: item.id },
        data: {
          aiDescriptionStatus: "suggested",
          originalDescription: item.description,
        },
      });

      const usage = await getAiUsageSummary(item.restaurantId, "description_enhance");

      return c.json({
        suggestion: result.description,
        originalDescription: item.description,
        usage: {
          used: usage.used,
          limit: entitlements.aiDescriptionLimit,
        },
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })

  .post("/enhance-descriptions-bulk", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const data = bulkEnhanceSchema.parse(await c.req.json());
      const restaurant = await getOwnedRestaurant(data.restaurantId, auth.clerkId);
      const entitlements = getRestaurantEntitlements(restaurant);

      if (!entitlements.bulkDescriptionEnabled) {
        throw new ApiError("Bulk description enhancement requires Pro plan.", 403);
      }

      const sections = await prisma.menuSection.findMany({
        where: { restaurantId: restaurant.id },
        orderBy: { displayOrder: "asc" },
        include: {
          items: { orderBy: { displayOrder: "asc" } },
        },
      });

      const items = sections.flatMap((s) =>
        s.items.map((i) => ({
          id: i.id,
          name: i.name,
          description: i.description,
          price: i.price.toString(),
          sectionName: s.name,
        }))
      );

      const result = await enhanceBulkDescriptions(
        items,
        {
          name: restaurant.name,
          cuisineType: restaurant.cuisineType,
          location: restaurant.location,
        },
        data.mode,
        data.tone
      );

      if (result.tokensIn > 0) {
        await logAiUsage(
          restaurant.id,
          "description_enhance",
          result.tokensIn,
          result.tokensOut
        );
      }

      // Mark items as having suggestions
      const itemIds = Object.keys(result.suggestions);
      if (itemIds.length) {
        // Store original descriptions
        const existingItems = await prisma.menuItem.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, description: true },
        });

        for (const existing of existingItems) {
          await prisma.menuItem.update({
            where: { id: existing.id },
            data: {
              aiDescriptionStatus: "suggested",
              originalDescription: existing.description,
            },
          });
        }
      }

      return c.json({
        suggestions: result.suggestions,
        count: Object.keys(result.suggestions).length,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })

  .post("/suggest-promotion-content", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const data = promotionContentSchema.parse(await c.req.json());
      const restaurant = await getOwnedRestaurant(data.restaurantId, auth.clerkId);
      const entitlements = getRestaurantEntitlements(restaurant);

      const limit = await checkAiLimit(
        restaurant.id,
        "description_enhance",
        entitlements.aiDescriptionLimit
      );

      if (!limit.allowed) {
        throw new ApiError(
          `Description enhancement limit reached (${limit.used}/${entitlements.aiDescriptionLimit} this month). Upgrade for more.`,
          403
        );
      }

      const sections = await prisma.menuSection.findMany({
        where: { restaurantId: restaurant.id },
        include: {
          items: {
            where: {
              id: {
                in: data.itemIds,
              },
            },
            orderBy: { displayOrder: "asc" },
          },
        },
        orderBy: { displayOrder: "asc" },
      });

      const items = sections.flatMap((section) =>
        section.items.map((item) => ({
          id: item.id,
          name: item.name,
          description: item.description,
          price: item.price.toString(),
          sectionName: section.name,
        }))
      );

      if (items.length !== new Set(data.itemIds).size) {
        throw new ApiError("One or more selected dishes were not found", 404);
      }

      const result = await suggestPromotionContent(
        {
          type: data.type,
          title: data.title,
          subtitle: data.subtitle,
          description: data.description,
          badgeLabel: data.badgeLabel,
          terms: data.terms,
          promoPrice: data.promoPrice,
          startsAt: data.startsAt,
          endsAt: data.endsAt,
          items,
        },
        {
          name: restaurant.name,
          cuisineType: restaurant.cuisineType,
          location: restaurant.location,
        },
        data.tone
      );

      await logAiUsage(
        restaurant.id,
        "description_enhance",
        result.tokensIn,
        result.tokensOut
      );

      const usage = await getAiUsageSummary(restaurant.id, "description_enhance");

      return c.json({
        suggestion: result.content,
        usage: {
          used: usage.used,
          limit: entitlements.aiDescriptionLimit,
        },
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })

  .post("/accept-descriptions", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const data = acceptDescriptionsSchema.parse(await c.req.json());

      for (const action of data.actions) {
        const item = await prisma.menuItem.findUnique({
          where: { id: action.menuItemId },
          include: {
            restaurant: { include: { owner: true } },
          },
        });

        if (!item || item.restaurant.owner.clerkId !== auth.clerkId) {
          continue;
        }

        if (action.action === "accept") {
          await prisma.menuItem.update({
            where: { id: item.id },
            data: {
              description: action.description ?? item.description,
              aiDescriptionStatus: "accepted",
            },
          });
        } else {
          // Reject: revert to original
          await prisma.menuItem.update({
            where: { id: item.id },
            data: {
              description: item.originalDescription ?? item.description,
              aiDescriptionStatus: null,
              originalDescription: null,
            },
          });
        }
      }

      return c.json({ ok: true });
    } catch (error) {
      return errorResponse(c, error);
    }
  })

  // ── Dietary Tags ────────────────────────────────────────────────
  .post("/suggest-tags", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const data = suggestTagsSchema.parse(await c.req.json());
      const restaurant = await getOwnedRestaurant(data.restaurantId, auth.clerkId);
      const entitlements = getRestaurantEntitlements(restaurant);

      const limit = await checkAiLimit(
        restaurant.id,
        "tag_analysis",
        entitlements.aiTagAnalysisLimit
      );

      if (!limit.allowed) {
        throw new ApiError(
          `Tag analysis limit reached (${limit.used}/${entitlements.aiTagAnalysisLimit} this month). Upgrade for more.`,
          403
        );
      }

      const sections = await prisma.menuSection.findMany({
        where: { restaurantId: restaurant.id },
        orderBy: { displayOrder: "asc" },
        include: {
          items: { orderBy: { displayOrder: "asc" } },
        },
      });

      const items = sections.flatMap((s) =>
        s.items.map((i) => ({
          id: i.id,
          name: i.name,
          description: i.description,
          sectionName: s.name,
        }))
      );

      const result = await suggestDietaryTags(
        {
          name: restaurant.name,
          cuisineType: restaurant.cuisineType,
        },
        items
      );

      await logAiUsage(
        restaurant.id,
        "tag_analysis",
        result.tokensIn,
        result.tokensOut
      );

      return c.json({
        suggestions: result.suggestions,
        usage: {
          used: limit.used + 1,
          limit: entitlements.aiTagAnalysisLimit,
        },
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })

  .post("/confirm-tags-bulk", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const data = confirmTagsBulkSchema.parse(await c.req.json());

      for (const action of data.actions) {
        const item = await prisma.menuItem.findUnique({
          where: { id: action.menuItemId },
          include: {
            restaurant: { include: { owner: true } },
          },
        });

        if (!item || item.restaurant.owner.clerkId !== auth.clerkId) {
          continue;
        }

        if (action.action === "confirm") {
          await prisma.menuItemDietaryTag.upsert({
            where: {
              menuItemId_tagId: {
                menuItemId: action.menuItemId,
                tagId: action.tagId,
              },
            },
            create: {
              menuItemId: action.menuItemId,
              tagId: action.tagId,
              source: "ai_confirmed",
            },
            update: {
              source: "ai_confirmed",
            },
          });
        } else {
          await prisma.menuItemDietaryTag.deleteMany({
            where: {
              menuItemId: action.menuItemId,
              tagId: action.tagId,
            },
          });
        }
      }

      return c.json({ ok: true });
    } catch (error) {
      return errorResponse(c, error);
    }
  })

  .post("/apply-fixes", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const data = applyMenuFixesSchema.parse(await c.req.json());
      await getOwnedRestaurant(data.restaurantId, auth.clerkId);

      const staged = await buildStagedMenuFixes(data.restaurantId, data.fixes);
      if (data.mode === "apply" && staged.preparedFixes.length > 0) {
        await applyPreparedMenuFixes(data.restaurantId, staged.preparedFixes);
      }

      return c.json({
        mode: data.mode,
        selectedCount: data.fixes.length,
        stagedCount: staged.stagedFixes.length,
        appliedCount: data.mode === "apply" ? staged.preparedFixes.length : 0,
        stagedFixes: staged.stagedFixes,
        warnings: staged.warnings,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })

  // ── Menu Analysis ───────────────────────────────────────────────
  .post("/analyze-menu", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const data = analyzeMenuSchema.parse(await c.req.json());
      const restaurant = await getOwnedRestaurant(data.restaurantId, auth.clerkId);
      const entitlements = getRestaurantEntitlements(restaurant);

      const limit = await checkAiLimit(
        restaurant.id,
        "menu_analysis",
        entitlements.analysisLimit
      );

      if (!limit.allowed) {
        throw new ApiError(
          `Menu analysis limit reached (${limit.used}/${entitlements.analysisLimit} this month). Upgrade for more.`,
          403
        );
      }

      const result = await analyzeMenu(
        {
          id: restaurant.id,
          name: restaurant.name,
          cuisineType: restaurant.cuisineType,
          location: restaurant.location,
        },
        entitlements.menuAnalysisLevel
      );

      if (!result.cached) {
        await logAiUsage(
          restaurant.id,
          "menu_analysis",
          result.tokensIn,
          result.tokensOut
        );
        await maybeSendMenuHealthDropNotification({
          restaurantId: restaurant.id,
          restaurantName: restaurant.name,
          recipientEmail: auth.email ?? restaurant.owner.email,
        });
      }

      return c.json({
        analysis: result.result,
        cached: result.cached,
        usage: {
          used: result.cached ? limit.used : limit.used + 1,
          limit: entitlements.analysisLimit,
        },
        level: entitlements.menuAnalysisLevel,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })

  .get("/analyze-menu/:restaurantId", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const restaurantId = c.req.param("restaurantId");
      const restaurant = await getOwnedRestaurant(restaurantId, auth.clerkId);
      const entitlements = getRestaurantEntitlements(restaurant);
      const menuHash = await computeMenuHash(restaurant.id);

      const cached = await prisma.menuAnalysis.findFirst({
        where: {
          restaurantId: restaurant.id,
          analysisType: "full",
          menuHash,
        },
        orderBy: { createdAt: "desc" },
      });

      if (!cached) {
        return c.json({ analysis: null, level: entitlements.menuAnalysisLevel });
      }

      return c.json({
        analysis: normalizeMenuAnalysisResult(cached.result),
        cached: true,
        createdAt: cached.createdAt,
        level: entitlements.menuAnalysisLevel,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .get("/image-enhancement-usage/:restaurantId", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const restaurantId = c.req.param("restaurantId");
      const restaurant = await getOwnedRestaurant(restaurantId, auth.clerkId);
      const entitlements = getRestaurantEntitlements(restaurant);
      const usage = await getAiUsageSummary(restaurant.id, "image_enhancement");
      const limit = entitlements.imageEnhancementLimit;

      return c.json({
        allowed: limit === null ? true : usage.used < limit,
        usage: {
          used: usage.used,
          limit,
          remaining: limit === null ? null : Math.max(limit - usage.used, 0),
        },
        capabilities: {
          importOwnPhotos: entitlements.sourcePhotoImportEnabled,
          reviewImportedPhotos: entitlements.sourcePhotoReviewEnabled,
          batchEnhancement: entitlements.batchImageEnhancementEnabled,
          advancedStyling: entitlements.advancedPhotoStylingEnabled,
        },
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

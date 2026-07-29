/**
 * Enrich "Bao & Bowl" demo: queue image generation + assign dietary tags.
 *
 * Usage:  npx tsx src/scripts/enrich-demo-bao-bowl.ts
 */

import { prisma } from "@/lib/prisma";
import { enqueueMenuItemImage } from "@/queue/image-generation";

const ITEM_TAGS: Record<string, string[]> = {
  "Braised Pork Belly Bao":         ["contains_nuts"],
  "Crispy Chicken Bao":             ["dairy_free", "nut_free", "contains_eggs"],
  "Glazed Mushroom Bao":            ["vegan", "nut_free"],
  "Tempura Prawn Bao":              ["dairy_free", "nut_free", "contains_shellfish", "contains_eggs"],
  "Teriyaki Chicken Bowl":          ["gluten_free", "dairy_free", "nut_free"],
  "Korean BBQ Beef Bowl":           ["gluten_free", "dairy_free", "nut_free", "contains_eggs", "spicy"],
  "Tofu Katsu Curry Bowl":          ["vegan", "nut_free", "mild"],
  "Salmon Poke Bowl":               ["dairy_free", "nut_free"],
  "Tonkotsu Ramen":                 ["dairy_free", "nut_free", "contains_eggs"],
  "Pad Thai":                       ["gluten_free", "dairy_free", "contains_shellfish", "contains_nuts", "contains_eggs"],
  "Dan Dan Noodles":                ["spicy", "dairy_free", "contains_nuts"],
  "Veggie Yakisoba":                ["vegan", "nut_free"],
  "Pork & Chive Gyoza (6 pcs)":     ["dairy_free", "nut_free"],
  "Vegetable Gyoza (6 pcs)":        ["vegan", "nut_free", "dairy_free"],
  "Edamame":                        ["vegan", "gluten_free", "nut_free", "dairy_free"],
  "Chicken Karaage":                ["gluten_free", "dairy_free", "nut_free", "contains_eggs"],
  "Miso Soup":                      ["vegan", "gluten_free", "nut_free", "dairy_free"],
  "Sweet Potato Fries with Sriracha Mayo": ["gluten_free", "dairy_free", "nut_free", "contains_eggs"],
  "Matcha Soft Serve":              ["vegetarian", "nut_free"],
  "Mochi Ice Cream (3 pcs)":        ["vegetarian", "gluten_free", "nut_free"],
  "Banana Tempura with Black Sesame Ice Cream": ["vegetarian", "nut_free", "contains_eggs"],
  "Yuzu Lemonade":                  ["gluten_free", "nut_free", "dairy_free"],
  "Thai Iced Tea":                  ["vegetarian", "gluten_free", "nut_free"],
  "Japanese Ramune Soda":           ["vegan", "gluten_free", "nut_free", "dairy_free"],
  "Jasmine Green Tea":              ["vegan", "gluten_free", "nut_free", "dairy_free"],
};

async function main() {
  const restaurant = await prisma.restaurant.findUnique({
    where: { slug: "bao-bowl" },
    include: {
      menuSections: {
        orderBy: { displayOrder: "asc" },
        include: {
          items: {
            orderBy: { displayOrder: "asc" },
            include: { images: true },
          },
        },
      },
    },
  });

  if (!restaurant) {
    console.error("Bao & Bowl not found. Run seed-demo-bao-bowl.ts first.");
    return;
  }

  const allItems = restaurant.menuSections.flatMap((s) => s.items);
  console.log(`Found ${allItems.length} items for ${restaurant.name}\n`);

  // ── 1. Queue image generation ─────────────────────────────
  console.log("=== Image Generation ===\n");

  let queued = 0;
  for (const item of allItems) {
    if (item.images.length > 0 && item.images[0].imageStatus !== "failed") {
      console.log(`  [skip] ${item.name} (already has image: ${item.images[0].imageStatus})`);
      continue;
    }

    const image = item.images[0]?.imageStatus === "failed"
      ? item.images[0]
      : await prisma.menuItemImage.create({
          data: {
            menuItemId: item.id,
            slot: 0,
            isPrimary: true,
            imageStatus: "none",
          },
        });

    await enqueueMenuItemImage({
      menuItemId: item.id,
      imageId: image.id,
      priority: 10,
      allowFallback: true,
    });

    console.log(`  [queued] ${item.name}`);
    queued++;
  }

  console.log(`\n  ${queued} images queued.\n`);

  // ── 2. Assign dietary tags ────────────────────────────────
  console.log("=== Dietary Tags ===\n");

  const allTags = await prisma.dietaryTag.findMany();
  const tagMap = new Map(allTags.map((t) => [t.key, t]));

  if (allTags.length === 0) {
    console.error("  No dietary tags found. Run: npx tsx prisma/seed-dietary-tags.ts");
    return;
  }

  let tagged = 0;
  for (const item of allItems) {
    const tagKeys = ITEM_TAGS[item.name];
    if (!tagKeys || tagKeys.length === 0) {
      console.log(`  [skip] ${item.name}`);
      continue;
    }

    for (const key of tagKeys) {
      const tag = tagMap.get(key);
      if (!tag) {
        console.warn(`  [warn] Tag "${key}" not found`);
        continue;
      }

      await prisma.menuItemDietaryTag.upsert({
        where: {
          menuItemId_tagId: { menuItemId: item.id, tagId: tag.id },
        },
        update: { source: "manual" },
        create: {
          menuItemId: item.id,
          tagId: tag.id,
          source: "manual",
        },
      });
    }

    console.log(`  [tagged] ${item.name}: ${tagKeys.join(", ")}`);
    tagged++;
  }

  console.log(`\n  ${tagged} items tagged.`);
  console.log(`\nDone! Check https://getbustan.com/bao-bowl`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

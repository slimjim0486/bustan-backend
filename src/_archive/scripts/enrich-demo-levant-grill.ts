/**
 * Enrich "Levant Grill" demo: queue image generation + assign dietary tags.
 *
 * Usage:  npx tsx src/scripts/enrich-demo-levant-grill.ts
 */

import { prisma } from "@/lib/prisma";
import { enqueueMenuItemImage } from "@/queue/image-generation";

const ITEM_TAGS: Record<string, string[]> = {
  "Classic Hummus":               ["vegan", "gluten_free", "nut_free"],
  "Baba Ganoush":                 ["vegan", "gluten_free"],
  "Fattoush Salad":               ["vegan"],
  "Tabbouleh":                    ["vegan"],
  "Grilled Halloumi":             ["vegetarian", "gluten_free"],
  "Labneh with Za'atar":          ["vegetarian", "gluten_free", "nut_free"],
  "Falafel Plate":                ["vegan", "dairy_free"],
  "Lamb Sambousek":               ["contains_nuts"],
  "Cheese Rakakat":               ["vegetarian"],
  "Hummus with Lamb Shawarma":    ["contains_nuts", "gluten_free"],
  "Chicken Wings with Garlic Sauce": ["gluten_free", "dairy_free", "contains_eggs"],
  "Mixed Grill Platter":          ["contains_eggs"],
  "Shish Tawook":                 ["contains_eggs"],
  "Lamb Kofta":                   ["dairy_free", "gluten_free"],
  "Lamb Chops":                   ["gluten_free", "dairy_free", "nut_free"],
  "Chicken Shawarma Plate":       ["contains_eggs"],
  "Lamb Shawarma Plate":          ["dairy_free", "nut_free"],
  "Chicken Shawarma Wrap":        ["dairy_free", "contains_eggs"],
  "Falafel Wrap":                 ["vegan"],
  "Lamb Kofta Wrap":              ["dairy_free"],
  "Lamb Ouzi":                    ["gluten_free", "dairy_free", "contains_nuts"],
  "Chicken Musakhan":             ["dairy_free", "contains_nuts"],
  "Grilled Sea Bass":             ["gluten_free", "dairy_free", "nut_free"],
  "Kunafa":                       ["vegetarian"],
  "Baklava Assortment":           ["vegetarian", "contains_nuts"],
  "Mhalabiyeh":                   ["vegetarian", "gluten_free", "contains_nuts"],
  "Fresh Lemonade with Mint":     ["vegan", "gluten_free", "nut_free"],
  "Ayran":                        ["vegetarian", "gluten_free", "nut_free"],
  "Arabic Coffee":                ["vegan", "gluten_free", "nut_free"],
  "Jallab":                       ["vegan", "gluten_free", "contains_nuts"],
};

async function main() {
  const restaurant = await prisma.restaurant.findUnique({
    where: { slug: "levant-grill" },
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
    console.error("Levant Grill not found. Run seed-demo-levant-grill.ts first.");
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
  console.log(`\nDone! Check https://getbustan.com/levant-grill`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

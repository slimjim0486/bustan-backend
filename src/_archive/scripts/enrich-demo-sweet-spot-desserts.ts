/**
 * Enrich "Sweet Spot Desserts" demo: queue image generation + assign dietary tags.
 *
 * Usage:  npx tsx src/scripts/enrich-demo-sweet-spot-desserts.ts
 */

import { prisma } from "@/lib/prisma";
import { enqueueMenuItemImage } from "@/queue/image-generation";

const ITEM_TAGS: Record<string, string[]> = {
  "Pistachio Kunafa Cheesecake":     ["vegetarian", "contains_nuts", "contains_eggs"],
  "Belgian Chocolate Fondant":       ["vegetarian", "gluten_free", "contains_nuts", "contains_eggs"],
  "Red Velvet Cake":                 ["vegetarian", "contains_eggs"],
  "Lotus Biscoff Cheesecake":        ["vegetarian", "contains_eggs"],
  "Mango Passion Fruit Mousse":      ["vegetarian", "gluten_free", "contains_eggs"],
  "Classic Butter Croissant":        ["vegetarian", "contains_eggs", "nut_free"],
  "Pain au Chocolat":                ["vegetarian", "contains_eggs"],
  "Pistachio Croissant":             ["vegetarian", "contains_nuts", "contains_eggs"],
  "Almond Croissant":                ["vegetarian", "contains_nuts", "contains_eggs"],
  "Danish Pastry":                   ["vegetarian", "contains_eggs", "nut_free"],
  "Saffron Crème Brûlée":           ["vegetarian", "gluten_free", "nut_free", "contains_eggs"],
  "Tiramisu":                        ["vegetarian", "contains_eggs", "nut_free"],
  "Rose & Raspberry Panna Cotta":    ["gluten_free", "nut_free"],
  "Tahini Chocolate Brownie":        ["vegetarian", "contains_eggs"],
  "Brown Butter Chocolate Chip Cookie": ["vegetarian", "contains_eggs", "nut_free"],
  "Pistachio & White Chocolate Cookie": ["vegetarian", "contains_nuts", "contains_eggs"],
  "Salted Caramel Stuffed Cookie":   ["vegetarian", "contains_eggs", "nut_free"],
  "French Macaron Box (6 pcs)":      ["gluten_free", "contains_nuts", "contains_eggs"],
  "Ashta Ice Cream with Kunafa Crumble": ["vegetarian", "contains_nuts", "contains_eggs"],
  "Mango Sorbet":                    ["vegan", "gluten_free", "nut_free", "dairy_free"],
  "Affogato":                        ["vegetarian", "gluten_free", "nut_free"],
  "Spanish Latte":                   ["vegetarian", "gluten_free", "nut_free"],
  "Matcha Latte":                    ["vegetarian", "gluten_free", "nut_free"],
  "Hot Chocolate":                   ["vegetarian", "gluten_free", "nut_free"],
  "Turkish Coffee":                  ["vegan", "gluten_free"],
  "Iced Pistachio Latte":            ["vegetarian", "gluten_free", "contains_nuts"],
  "Fresh Strawberry Lemonade":       ["vegan", "gluten_free", "nut_free", "dairy_free"],
};

async function main() {
  const restaurant = await prisma.restaurant.findUnique({
    where: { slug: "sweet-spot-desserts" },
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
    console.error("Sweet Spot Desserts not found. Run seed-demo-sweet-spot-desserts.ts first.");
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
  console.log(`\nDone! Check https://getbustan.com/sweet-spot-desserts`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

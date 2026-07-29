/**
 * Enrich "Vicolo" demo: queue image generation + assign dietary tags.
 *
 * Usage:  npx tsx src/scripts/enrich-demo-vicolo.ts
 */

import { prisma } from "@/lib/prisma";
import { enqueueMenuItemImage } from "@/queue/image-generation";

const ITEM_TAGS: Record<string, string[]> = {
  "Bruschetta Pomodoro":    ["vegan"],
  "Burrata e Prosciutto":   ["gluten_free"],
  "Beef Carpaccio":         ["gluten_free"],
  "Arancini":               ["vegetarian"],
  "Caprese Salad":          ["vegetarian", "gluten_free", "nut_free", "mild"],
  "Cacio e Pepe":           ["vegetarian"],
  "Pappardelle al Ragu":    ["spicy"],
  "Truffle Risotto":        ["vegetarian", "gluten_free"],
  "Spaghetti alle Vongole": ["dairy_free", "contains_shellfish"],
  "Lasagna della Nonna":    [],
  "Osso Buco":              ["gluten_free"],
  "Branzino al Forno":      ["gluten_free", "dairy_free", "nut_free", "mild"],
  "Chicken Milanese":       ["contains_eggs"],
  "Vitello alla Griglia":   ["gluten_free", "dairy_free"],
  "Tiramisu":               ["vegetarian"],
  "Panna Cotta":            ["gluten_free", "nut_free", "mild"],
  "Cannoli Siciliani":      ["vegetarian", "contains_nuts"],
  "Espresso Doppio":        ["vegan", "gluten_free", "nut_free"],
  "Limoncello Spritz":      ["vegan", "gluten_free", "nut_free"],
  "Affogato":               ["vegetarian", "contains_nuts"],
};

async function main() {
  const restaurant = await prisma.restaurant.findUnique({
    where: { slug: "vicolo" },
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
    console.error("Vicolo not found. Run seed-demo-vicolo.ts first.");
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
  console.log(`\nDone! Check https://getbustan.com/vicolo`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

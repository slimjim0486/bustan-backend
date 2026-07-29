/**
 * Enrich "Zafran House" demo: queue image generation + assign dietary tags.
 *
 * Usage:  npx tsx src/scripts/enrich-demo-zafran-house.ts
 */

import { prisma } from "@/lib/prisma";
import { enqueueMenuItemImage } from "@/queue/image-generation";

// ── Dietary tag assignments (from the AI notes we wrote) ──────

const ITEM_TAGS: Record<string, string[]> = {
  "Lamb Samosa":          ["halal", "spicy"],
  "Chicken Malai Tikka":  ["halal", "gluten_free", "mild"],
  "Seekh Kebab":          ["halal", "gluten_free", "spicy"],
  "Vegetable Pakora":     ["vegan", "nut_free"],
  "Dahi Puri Chaat":      ["vegetarian"],
  "Paneer Tikka":         ["vegetarian", "gluten_free"],
  "Butter Chicken":       ["halal", "gluten_free", "contains_nuts", "mild"],
  "Lamb Biryani":         ["halal", "gluten_free", "spicy"],
  "Palak Paneer":         ["vegetarian", "gluten_free", "mild"],
  "Karahi Gosht":         ["halal", "gluten_free", "dairy_free", "spicy"],
  "Chicken Nihari":       ["halal", "gluten_free", "dairy_free", "nut_free", "spicy"],
  "Tandoori Salmon":      ["gluten_free", "mild"],
  "Dal Makhani":          ["vegetarian", "gluten_free", "nut_free", "mild"],
  "Garlic Naan":          ["vegetarian"],
  "Cheese Naan":          ["vegetarian"],
  "Tandoori Roti":        ["vegan", "dairy_free"],
  "Gulab Jamun":          ["vegetarian"],
  "Ras Malai":            ["vegetarian", "gluten_free", "contains_nuts"],
  "Mango Lassi":          ["vegetarian", "gluten_free", "nut_free", "mild"],
  "Masala Chai":          ["vegetarian", "gluten_free", "nut_free"],
};

async function main() {
  const restaurant = await prisma.restaurant.findUnique({
    where: { slug: "zafran-house" },
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
    console.error("Zafran House not found. Run seed-demo-zafran-house.ts first.");
    return;
  }

  const allItems = restaurant.menuSections.flatMap((s) => s.items);
  console.log(`Found ${allItems.length} items for ${restaurant.name}\n`);

  // ── 1. Queue image generation ─────────────────────────────
  console.log("=== Image Generation ===\n");

  let queued = 0;
  for (const item of allItems) {
    // Skip if already has images
    if (item.images.length > 0 && item.images[0].imageStatus !== "failed") {
      console.log(`  [skip] ${item.name} (already has image: ${item.images[0].imageStatus})`);
      continue;
    }

    // Create MenuItemImage record at slot 0
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

    // Queue the job (priority 10 = Pro plan)
    await enqueueMenuItemImage({
      menuItemId: item.id,
      imageId: image.id,
      priority: 10,
      allowFallback: true,
    });

    console.log(`  [queued] ${item.name}`);
    queued++;
  }

  console.log(`\n  ${queued} images queued. The Railway worker will process them.\n`);

  // ── 2. Assign dietary tags ────────────────────────────────
  console.log("=== Dietary Tags ===\n");

  // Fetch all available tags
  const allTags = await prisma.dietaryTag.findMany();
  const tagMap = new Map(allTags.map((t) => [t.key, t]));

  if (allTags.length === 0) {
    console.error("  No dietary tags found. Run: npx tsx prisma/seed-dietary-tags.ts");
    return;
  }

  console.log(`  ${allTags.length} tags available in system`);

  let tagged = 0;
  for (const item of allItems) {
    const tagKeys = ITEM_TAGS[item.name];
    if (!tagKeys) {
      console.log(`  [skip] ${item.name} (no tags defined)`);
      continue;
    }

    for (const key of tagKeys) {
      const tag = tagMap.get(key);
      if (!tag) {
        console.warn(`  [warn] Tag "${key}" not found in DB`);
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

  console.log(`\n  ${tagged} items tagged.\n`);
  console.log(`Done! Check https://getbustan.com/zafran-house`);
  console.log("Images will appear as the Railway worker processes the queue.");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

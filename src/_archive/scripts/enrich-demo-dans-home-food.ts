/**
 * Enrich "Dan's Home Food" demo: queue image generation for all menu items.
 *
 * Usage:  npx tsx src/scripts/enrich-demo-dans-home-food.ts
 */

import { prisma } from "@/lib/prisma";
import { enqueueMenuItemImage } from "@/queue/image-generation";

async function main() {
  const restaurant = await prisma.restaurant.findUnique({
    where: { slug: "dans-home-food" },
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
    console.error("Dan's Home Food not found. Run seed-demo-dans-home-food.ts first.");
    return;
  }

  const allItems = restaurant.menuSections.flatMap((s) => s.items);
  console.log(`Found ${allItems.length} items for ${restaurant.name}\n`);

  // Queue image generation for all items
  console.log("=== Image Generation Queue ===\n");

  let queued = 0;
  let skipped = 0;

  for (const item of allItems) {
    // Skip items that already have a non-failed image
    if (item.images.length > 0 && item.images[0].imageStatus !== "failed") {
      console.log(`  [skip] ${item.name} (already has image: ${item.images[0].imageStatus})`);
      skipped++;
      continue;
    }

    // Reuse failed image record or create new one
    const image =
      item.images[0]?.imageStatus === "failed"
        ? item.images[0]
        : await prisma.menuItemImage.create({
            data: {
              menuItemId: item.id,
              slot: 0,
              isPrimary: true,
              imageStatus: "none",
              originType: "bustan_ai",
              derivationType: "synthetic_generation",
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

  console.log(`\n--- Summary ---`);
  console.log(`  Total items: ${allItems.length}`);
  console.log(`  Queued for generation: ${queued}`);
  console.log(`  Skipped (already have images): ${skipped}`);
  console.log(`\nThe backend worker will process these jobs automatically.`);
  console.log(`Check progress at: https://getbustan.com/dans-home-food`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

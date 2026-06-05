/**
 * Idempotent seed for the Sous Chef eval restaurant. Run:
 *   npm run eval:sous-chef:seed
 * Prints EVAL_RESTAURANT_ID to export before running evals.
 */
import { prisma } from "../../src/lib/prisma";

const MENU: Array<{ section: string; items: Array<{ name: string; price: number; description?: string }> }> = [
  {
    section: "Grills",
    items: [
      { name: "Chicken Machboos", price: 45, description: "Fragrant spiced rice with slow-cooked chicken." },
      { name: "Lamb Mandi", price: 68 },
      { name: "Mixed Grill Platter", price: 89 },
    ],
  },
  {
    section: "Mezze",
    items: [
      { name: "Hummus", price: 18 },
      { name: "Moutabal", price: 20 },
      { name: "Fattoush", price: 22 },
      { name: "Halloumi Skewers", price: 28 },
    ],
  },
  {
    section: "Drinks",
    items: [
      { name: "Fresh Lemon Mint", price: 15 },
      { name: "Karak Chai", price: 8 },
    ],
  },
  {
    section: "Desserts",
    items: [
      { name: "Umm Ali", price: 25 },
      { name: "Kunafa", price: 30 },
    ],
  },
];

async function main() {
  const owner = await prisma.user.upsert({
    where: { clerkId: "eval-sous-chef-owner" },
    update: {},
    create: {
      clerkId: "eval-sous-chef-owner",
      email: "sous-chef-eval@getbustan.com",
      fullName: "Sous Chef Eval Owner",
    },
  });

  const existing = await prisma.restaurant.findUnique({ where: { slug: "sous-chef-eval" } });
  const restaurant =
    existing ??
    (await prisma.restaurant.create({
      data: {
        slug: "sous-chef-eval",
        name: "Bustan Eval Kitchen",
        cuisineType: "Emirati",
        location: "Dubai",
        isPublished: true,
        isDemo: true,
        sousChefRoutingEnabled: true,
        ownerId: owner.id,
      },
    }));

  // Deterministic menu: wipe and recreate.
  await prisma.menuSection.deleteMany({ where: { restaurantId: restaurant.id } });
  for (const [sectionIndex, section] of MENU.entries()) {
    await prisma.menuSection.create({
      data: {
        restaurantId: restaurant.id,
        name: section.section,
        displayOrder: sectionIndex,
        items: {
          create: section.items.map((item, itemIndex) => ({
            restaurantId: restaurant.id,
            name: item.name,
            description: item.description ?? null,
            price: item.price,
            displayOrder: itemIndex,
          })),
        },
      },
    });
  }

  console.log(`Seeded. export EVAL_RESTAURANT_ID=${restaurant.id}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

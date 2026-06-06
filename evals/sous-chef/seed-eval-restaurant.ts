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

  // --- Phase 2 fixtures (idempotent: delete dependents then recreate) ---

  // MessageLog / Campaign reference customers (onDelete: SetNull on customerId),
  // but we wipe them first anyway so the eval restaurant has a clean CRM slate.
  await prisma.messageLog.deleteMany({ where: { restaurantId: restaurant.id } });
  await prisma.campaign.deleteMany({ where: { restaurantId: restaurant.id } });
  // CustomerConsent cascades from Customer; delete customers last.
  await prisma.customer.deleteMany({ where: { restaurantId: restaurant.id } });

  // Opted-in customer with a consent paper trail. lastOrderAt 60 days ago so the
  // inactive_45 segment matches; orderCount 2 makes it a repeat customer.
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  const optInAt = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  await prisma.customer.create({
    data: {
      restaurantId: restaurant.id,
      normalizedPhone: "+971500000001",
      phoneNumber: "+971500000001",
      displayName: "Eval Inactive Customer",
      marketingOptIn: true,
      marketingOptInAt: optInAt,
      lastOrderAt: sixtyDaysAgo,
      orderCount: 2,
      consents: {
        create: {
          restaurantId: restaurant.id,
          status: "opt_in",
          channel: "whatsapp",
          source: "eval-seed",
          createdAt: optInAt,
        },
      },
    },
  });

  // Approved marketing template for winback campaigns.
  await prisma.whatsAppTemplate.deleteMany({
    where: { restaurantId: restaurant.id, name: "inactive_30", language: "en" },
  });
  await prisma.whatsAppTemplate.create({
    data: {
      restaurantId: restaurant.id,
      name: "inactive_30",
      label: "Win-back (inactive 30 days)",
      category: "MARKETING",
      language: "en",
      status: "approved",
      body: "Hi {{1}}, we miss you at Bustan Eval Kitchen! Come back for {{2}} on your next order.",
      variables: ["customer_name", "offer"],
    },
  });

  // Standing active "Machboos Monday" promotion on Chicken Machboos.
  const machboos = await prisma.menuItem.findFirst({
    where: { restaurantId: restaurant.id, name: "Chicken Machboos" },
  });
  await prisma.promotion.deleteMany({
    where: { restaurantId: restaurant.id, title: "Machboos Monday" },
  });
  await prisma.promotion.create({
    data: {
      restaurantId: restaurant.id,
      type: "discounted_item",
      title: "Machboos Monday",
      promoPrice: 40,
      isActive: true,
      isFeatured: true,
      displayOrder: 0,
      ...(machboos
        ? { items: { create: { menuItemId: machboos.id, role: "included", displayOrder: 0 } } }
        : {}),
    },
  });

  console.log(`Seeded. export EVAL_RESTAURANT_ID=${restaurant.id}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

/**
 * Seed a login-backed sales demo restaurant.
 *
 * This is different from the public demo restaurant scripts: it requires a real
 * Clerk user email so the owner can log into production and see a realistic
 * Manager's Desk, reports, customers, and pending work.
 *
 * Usage:
 *   SALES_DEMO_EMAIL=saleem@example.com npm run demo:sales:seed
 *   npm run demo:sales:seed -- --email=saleem@example.com --slug=bustan-sales-demo --autonomy=on
 *
 * Production:
 *   railway run --service backend npm run demo:sales:seed -- --email=saleem@example.com
 */

import { createClerkClient } from "@clerk/backend";
import { DraftActionSource, DraftActionStatus, Prisma } from "@prisma/client";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";

const DEFAULT_SLUG = "bustan-sales-demo";

const RESTAURANT = {
  name: "Vicolo Demo",
  description:
    "A polished Italian restaurant demo for showing how Bustan keeps menus, reports, customers, and weekly actions moving from one manager desk.",
  cuisineType: "Italian",
  themeKey: "saffron" as const,
  location: "DIFC, Dubai",
  address: "Gate Village 3, DIFC, Dubai, UAE",
  phone: "+971 4 555 0456",
  whatsappNumber: "+971 50 555 0456",
  logoUrl: "https://images.getbustan.com/demo-restaurants/vicolo/logo.jpg",
  coverImageUrl: "https://images.getbustan.com/demo-restaurants/vicolo/cover.jpg",
};

const SECTIONS = [
  {
    name: "Antipasti",
    items: [
      {
        name: "Burrata e Prosciutto",
        description: "Fresh burrata with 24-month prosciutto di Parma, rocket, and truffle honey",
        price: 42,
        aiNotes:
          "Contains dairy and pork. Gluten-free. Our most popular antipasto; burrata is flown in from Puglia twice a week.",
      },
      {
        name: "Arancini",
        description: "Crispy saffron risotto balls filled with mozzarella, served with marinara",
        price: 28,
        aiNotes:
          "Vegetarian. Contains gluten and dairy. Served as 3 pieces. Very popular with kids and as a sharing starter.",
      },
    ],
  },
  {
    name: "Pasta & Risotto",
    items: [
      {
        name: "Cacio e Pepe",
        description: "Tonnarelli pasta with Pecorino Romano and cracked black pepper",
        price: 46,
        aiNotes:
          "Vegetarian. Contains gluten and dairy. Chef signature; no cream, just pasta water and cheese emulsion.",
      },
      {
        name: "Pappardelle al Ragu",
        description: "Hand-rolled ribbon pasta with slow-cooked Tuscan beef and pork ragu",
        price: 52,
        aiNotes:
          "Contains gluten, dairy, beef, and pork. Slow-cooked for 6 hours. Best-selling pasta and a comfort-food anchor.",
      },
      {
        name: "Truffle Risotto",
        description: "Carnaroli rice with porcini mushrooms, mascarpone, and shaved black truffle",
        price: 62,
        aiNotes:
          "Vegetarian and gluten-free. Contains dairy. Premium dish; preserved truffle in summer months.",
      },
    ],
  },
  {
    name: "Dolci",
    items: [
      {
        name: "Tiramisu",
        description: "Classic mascarpone cream with espresso-soaked ladyfingers and cocoa",
        price: 32,
        aiNotes:
          "Contains gluten, dairy, eggs, caffeine, and Marsala. Most popular dessert by far.",
      },
      {
        name: "Panna Cotta",
        description: "Vanilla bean panna cotta with seasonal berry compote",
        price: 28,
        aiNotes:
          "Gluten-free and nut-free. Contains dairy and gelatin. Best lighter dessert after a large meal.",
      },
    ],
  },
];

const CUSTOMERS = [
  {
    displayName: "Mariam Al Nuaimi",
    phoneNumber: "+971501110001",
    totalSpend: "416.00",
    orderCount: 5,
    daysSinceOrder: 8,
    preferredLanguage: "en",
  },
  {
    displayName: "Omar Haddad",
    phoneNumber: "+971501110002",
    totalSpend: "284.00",
    orderCount: 3,
    daysSinceOrder: 36,
    preferredLanguage: "ar",
  },
  {
    displayName: "Priya Menon",
    phoneNumber: "+971501110003",
    totalSpend: "638.00",
    orderCount: 7,
    daysSinceOrder: 14,
    preferredLanguage: "en",
  },
];

function parseArgs(argv: string[]) {
  const args = {
    email: process.env.SALES_DEMO_EMAIL ?? "",
    slug: process.env.SALES_DEMO_SLUG ?? DEFAULT_SLUG,
    autonomy: false,
  };
  for (const arg of argv) {
    if (arg.startsWith("--email=")) args.email = arg.slice("--email=".length);
    if (arg.startsWith("--slug=")) args.slug = arg.slice("--slug=".length);
    if (arg === "--autonomy=on") args.autonomy = true;
    if (arg === "--autonomy=off") args.autonomy = false;
  }
  return args;
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function dateDaysAgo(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function dateDaysFromNow(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function lastMondayUtc(): Date {
  const d = new Date();
  const day = d.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diff - 7);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function normalizePhone(phone: string): string {
  return `+${phone.replace(/\D/g, "")}`;
}

async function loadClerkUser(email: string) {
  if (!env.CLERK_SECRET_KEY) {
    throw new Error("CLERK_SECRET_KEY is not set. Cannot look up the demo owner in Clerk.");
  }
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  const result = await clerk.users.getUserList({ emailAddress: [email], limit: 1 });
  const clerkUser = result.data[0];
  if (!clerkUser) {
    throw new Error(`No Clerk user found for ${email}. Create the user in this Clerk tenant first.`);
  }
  const fullName =
    [clerkUser.firstName, clerkUser.lastName]
      .filter((part): part is string => Boolean(part))
      .join(" ") || "Sales Demo Owner";
  return { id: clerkUser.id, email, fullName };
}

async function clearDemoRestaurant(restaurantId: string) {
  await prisma.ownerChatMessage.deleteMany({ where: { restaurantId } });
  await prisma.ownerWhisper.deleteMany({ where: { restaurantId } });
  await prisma.weeklyReport.deleteMany({ where: { restaurantId } });
  await prisma.proactiveNudge.deleteMany({ where: { restaurantId } });
  await prisma.draftAction.deleteMany({ where: { restaurantId } });
  await prisma.customerConsent.deleteMany({ where: { restaurantId } });
  await prisma.customer.deleteMany({ where: { restaurantId } });
  await prisma.menuItem.deleteMany({ where: { restaurantId } });
  await prisma.menuSection.deleteMany({ where: { restaurantId } });
}

async function seedMenu(restaurantId: string) {
  const itemsByName = new Map<string, { id: string; sectionName: string; description: string }>();

  for (const [sectionIndex, section] of SECTIONS.entries()) {
    const createdSection = await prisma.menuSection.create({
      data: {
        restaurantId,
        name: section.name,
        displayOrder: sectionIndex,
      },
    });

    for (const [itemIndex, item] of section.items.entries()) {
      const createdItem = await prisma.menuItem.create({
        data: {
          restaurantId,
          sectionId: createdSection.id,
          name: item.name,
          description: item.description,
          price: item.price,
          currency: "AED",
          aiNotes: item.aiNotes,
          isAvailable: true,
          displayOrder: itemIndex,
        },
      });
      itemsByName.set(item.name, {
        id: createdItem.id,
        sectionName: section.name,
        description: item.description,
      });
    }
  }

  return itemsByName;
}

async function seedCustomers(restaurantId: string) {
  for (const customer of CUSTOMERS) {
    const created = await prisma.customer.create({
      data: {
        restaurantId,
        normalizedPhone: normalizePhone(customer.phoneNumber),
        phoneNumber: customer.phoneNumber,
        displayName: customer.displayName,
        marketingOptIn: true,
        marketingOptInAt: dateDaysAgo(customer.daysSinceOrder + 20),
        lastOrderAt: dateDaysAgo(customer.daysSinceOrder),
        orderCount: customer.orderCount,
        totalSpend: customer.totalSpend,
        currency: "AED",
        preferredLanguage: customer.preferredLanguage,
      },
    });

    await prisma.customerConsent.create({
      data: {
        restaurantId,
        customerId: created.id,
        status: "opt_in",
        channel: "whatsapp",
        source: "sales_demo_seed",
      },
    });
  }
}

async function seedReports(restaurantId: string) {
  const whisper = await prisma.ownerWhisper.create({
    data: {
      restaurantId,
      forDate: dateDaysAgo(1),
      content:
        "**Yesterday:** AED 1,240 tracked revenue, with pasta driving most attention.\n\n**Watch:** Pappardelle is pulling views but not enough repeat clicks.\n\n**Next:** Push a weekend pasta special to recent WhatsApp customers.",
      metricsJson: asJson({
        revenueAed: 1240,
        orders: 18,
        topItems: ["Pappardelle al Ragu", "Cacio e Pepe", "Tiramisu"],
        customersReached: 126,
      }),
      status: "unread",
      costUsd: 0,
    },
  });

  await prisma.ownerChatMessage.create({
    data: {
      restaurantId,
      role: "assistant",
      content: whisper.content,
      source: "whisper",
      whisperId: whisper.id,
      createdAt: dateDaysAgo(1),
    },
  });

  const weekly = await prisma.weeklyReport.create({
    data: {
      restaurantId,
      weekStart: lastMondayUtc(),
      narrative:
        "A good week: revenue rose and the pasta section carried the room. The gap is customer follow-up - several high-value guests have not ordered again in 30+ days.",
      metricsJson: asJson({
        tiles: [
          { key: "revenue", label: "Revenue", value: 8240, deltaPct: 18, direction: "up" },
          { key: "orders", label: "Orders", value: 96, deltaPct: 11, direction: "up" },
          { key: "scans", label: "Scans", value: 412, deltaPct: 24, direction: "up" },
          { key: "whatsapp", label: "WhatsApp", value: 37, deltaPct: -6, direction: "down" },
        ],
      }),
      actionsJson: asJson([
        {
          label: "Draft a pasta weekend special",
          seedPrompt: "Draft a weekend WhatsApp campaign for our pasta best-sellers.",
          kind: "promo",
        },
        {
          label: "Improve the ragu description",
          seedPrompt: "Rewrite the Pappardelle al Ragu menu description to make it more craveable.",
          kind: "menu",
        },
      ]),
      status: "unread",
      costUsd: 0,
    },
  });

  await prisma.ownerChatMessage.create({
    data: {
      restaurantId,
      role: "assistant",
      content: weekly.narrative,
      source: "weekly_report",
      weeklyReportId: weekly.id,
      createdAt: dateDaysAgo(2),
    },
  });

  const nudge = await prisma.proactiveNudge.create({
    data: {
      restaurantId,
      momentId: "uae_national_day",
      momentYear: 2026,
      narrative:
        "UAE National Day is far enough out to plan a tasteful limited-time menu and a WhatsApp preview for regulars.",
      actionsJson: asJson([
        {
          label: "Plan the National Day menu",
          seedPrompt: "Create a UAE National Day limited-time menu idea for Vicolo.",
          kind: "menu",
        },
        {
          label: "Draft the preview campaign",
          seedPrompt: "Draft a WhatsApp preview campaign for a UAE National Day menu.",
          kind: "promo",
        },
      ]),
      status: "unread",
      costUsd: 0,
    },
  });

  await prisma.ownerChatMessage.create({
    data: {
      restaurantId,
      role: "assistant",
      content: nudge.narrative,
      source: "event_nudge",
      nudgeId: nudge.id,
      createdAt: dateDaysAgo(3),
    },
  });
}

async function seedDrafts(
  restaurantId: string,
  ownerUserId: string,
  itemsByName: Map<string, { id: string; sectionName: string; description: string }>
) {
  const pappardelle = itemsByName.get("Pappardelle al Ragu");
  if (!pappardelle) throw new Error("Expected Pappardelle al Ragu demo item");

  await prisma.draftAction.create({
    data: {
      restaurantId,
      ownerUserId,
      actionType: "menu_description",
      source: DraftActionSource.chat,
      status: DraftActionStatus.pending,
      channel: "dashboard_chat",
      autonomyTier: 2,
      title: "Rewrite Pappardelle al Ragu",
      subtitle: "Make the best-selling pasta sound more premium before the weekend.",
      iconKey: "menu",
      affectedSurface: "/dashboard/menu",
      menuItemId: pappardelle.id,
      payload: asJson({
        menuItemId: pappardelle.id,
        description:
          "Hand-rolled pappardelle folded through a six-hour Tuscan beef and pork ragu, finished with Parmigiano.",
      }),
      preview: asJson({
        itemName: "Pappardelle al Ragu",
        sectionName: pappardelle.sectionName,
        before: pappardelle.description,
        after:
          "Hand-rolled pappardelle folded through a six-hour Tuscan beef and pork ragu, finished with Parmigiano.",
      }),
      expiresAt: dateDaysFromNow(14),
    },
  });

  await prisma.draftAction.create({
    data: {
      restaurantId,
      ownerUserId,
      actionType: "restaurant_profile_update",
      source: DraftActionSource.chat,
      status: DraftActionStatus.shipped,
      channel: "dashboard_chat",
      autonomyTier: 2,
      autoExecuted: true,
      title: "Updated the restaurant intro",
      subtitle: "Bustan tightened the public page copy for the demo.",
      iconKey: "sparkles",
      affectedSurface: "/dashboard/appearance",
      payload: asJson({ field: "description" }),
      preview: asJson({
        changes: [
          {
            field: "Description",
            from: "Italian restaurant in DIFC.",
            to: RESTAURANT.description,
          },
        ],
      }),
      decisionAt: dateDaysAgo(1),
      decidedBy: ownerUserId,
      shippedAt: dateDaysAgo(1),
      shipResult: asJson({ demo: true }),
      expiresAt: dateDaysFromNow(14),
      createdAt: dateDaysAgo(1),
    },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.email) {
    throw new Error("Provide --email=<owner email> or SALES_DEMO_EMAIL.");
  }

  console.log(`Seeding sales demo for ${args.email} (${args.slug})...\n`);

  const clerkUser = await loadClerkUser(args.email);
  const owner = await prisma.user.upsert({
    where: { clerkId: clerkUser.id },
    update: {
      email: clerkUser.email,
      fullName: clerkUser.fullName,
    },
    create: {
      clerkId: clerkUser.id,
      email: clerkUser.email,
      fullName: clerkUser.fullName,
      role: "restaurant_owner",
    },
  });

  const existing = await prisma.restaurant.findUnique({
    where: { slug: args.slug },
    select: { id: true, ownerId: true },
  });
  if (existing && existing.ownerId !== owner.id) {
    throw new Error(
      `Restaurant slug "${args.slug}" belongs to another owner (${existing.ownerId}). Aborting.`
    );
  }

  let restaurant = existing
    ? await prisma.restaurant.update({
        where: { id: existing.id },
        data: {
          ...RESTAURANT,
          slug: args.slug,
          isPublished: true,
          isDemo: true,
          subscriptionStatus: "active",
          agentAutonomyOptIn: args.autonomy,
          autonomyResumedAt: args.autonomy ? new Date() : null,
          ownerId: owner.id,
        },
      })
    : await prisma.restaurant.create({
        data: {
          ...RESTAURANT,
          slug: args.slug,
          isPublished: true,
          isDemo: true,
          subscriptionStatus: "active",
          agentAutonomyOptIn: args.autonomy,
          autonomyResumedAt: args.autonomy ? new Date() : null,
          ownerId: owner.id,
        },
      });

  await clearDemoRestaurant(restaurant.id);

  await prisma.subscription.upsert({
    where: { restaurantId: restaurant.id },
    update: {
      plan: "fulltime",
      status: "active",
      currentPeriodEnd: new Date("2099-12-31T23:59:59.000Z"),
    },
    create: {
      restaurantId: restaurant.id,
      plan: "fulltime",
      status: "active",
      currentPeriodEnd: new Date("2099-12-31T23:59:59.000Z"),
    },
  });

  const itemsByName = await seedMenu(restaurant.id);
  await seedCustomers(restaurant.id);
  await seedReports(restaurant.id);
  await seedDrafts(restaurant.id, owner.id, itemsByName);

  restaurant = await prisma.restaurant.findUniqueOrThrow({ where: { id: restaurant.id } });

  console.log("Done.\n");
  console.log(`Owner email:     ${owner.email}`);
  console.log(`Restaurant id:   ${restaurant.id}`);
  console.log(`Public URL:      https://getbustan.com/${restaurant.slug}`);
  console.log(`Dashboard URL:   https://getbustan.com/dashboard`);
  console.log(`Plan:            Full-time`);
  console.log(`Autonomy opt-in: ${restaurant.agentAutonomyOptIn ? "on" : "off"}`);
}

main()
  .catch((err) => {
    console.error("Sales demo seed failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

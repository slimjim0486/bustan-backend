/**
 * Seed a salon booking demo onto an existing owner's tenant.
 *
 * Unlike seed-sales-demo.ts (which manages its own dedicated demo restaurant
 * under a fixed slug), this script finds the restaurant already owned by a
 * real Clerk-authenticated account and UPDATES it in place with realistic
 * salon booking data — services, customers, bookings across every status, a
 * pending payout, and an unread weekly report — so the booking dashboard
 * (Manager's Desk, perch/headline, weekly report) renders with live-looking
 * numbers. It never creates a second tenant.
 *
 * Usage:
 *   BOOKING_DEMO_EMAIL=saleem@example.com npm run demo:booking:seed
 *   npm run demo:booking:seed -- --email=saleem@example.com
 *   npm run demo:booking:seed -- --email=saleem@example.com --slug=maison-lumiere-salon
 *     (--slug is only needed if the owner has more than one restaurant)
 *
 * Production:
 *   railway run --service backend npm run demo:booking:seed -- --email=saleem@example.com
 *
 * Idempotent: re-running clears this tenant's bookings, payout records,
 * services/categories, and every prior demo-seeded weekly report before
 * reseeding. It also resets the owner-chat agent so it never contradicts the
 * salon data: all OwnerChatMemory rows, all OwnerChatMessage thread history,
 * all OwnerWhisper/ProactiveNudge report moments, and any still-pending or
 * still-scheduled DraftAction rows (rejected in place, not deleted) from a
 * prior tenant era. Customers are upserted by phone — not cleared — so
 * repeat runs don't duplicate the customer list.
 */

import { createClerkClient } from "@clerk/backend";
import type { BookingSource, BookingStatus } from "@prisma/client";
import { DraftActionStatus, Prisma } from "@prisma/client";
import { FEE_COUNTED_STATUSES } from "@/lib/booking-metrics";
import { env } from "@/lib/env";
import { addDays, startOfTodayGst, startOfWeekGst } from "@/lib/gst-time";
import { computeBookingWeeklyTiles, type WeeklyAction } from "@/lib/owner-chat-prompts";
import { prisma } from "@/lib/prisma";
import { normalizeUaePhone } from "@/lib/uae-phone";
import { lastCompletedWeekStartIso } from "@/queue/weekly-report";

const RESTAURANT_UPDATE = {
  name: "Maison Lumière Salon",
  businessType: "SALON" as const,
  newCustomerFeeAed: 50,
  depositAed: 50,
  bookingPolicies: {
    noShowPolicy: "Deposit is kept if you miss your appointment without 24h notice.",
    slotGranularityMinutes: 30,
  },
};

interface CategorySpec {
  name: string;
  services: { name: string; priceAed: number; durationMinutes: number }[];
}

const SERVICE_CATEGORIES: CategorySpec[] = [
  {
    name: "Hair",
    services: [
      { name: "Blow-dry", priceAed: 120, durationMinutes: 45 },
      { name: "Cut & style", priceAed: 180, durationMinutes: 60 },
      { name: "Full colour", priceAed: 450, durationMinutes: 120 },
      { name: "Balayage", priceAed: 650, durationMinutes: 150 },
    ],
  },
  {
    name: "Nails & Beauty",
    services: [
      { name: "Gel manicure", priceAed: 140, durationMinutes: 60 },
      { name: "Classic pedicure", priceAed: 120, durationMinutes: 45 },
      { name: "Lash lift", priceAed: 200, durationMinutes: 60 },
      { name: "Brow shaping", priceAed: 80, durationMinutes: 30 },
    ],
  },
];

const CUSTOMERS: { displayName: string; preferredLanguage: "ar" | "en" }[] = [
  { displayName: "Fatima Al Suwaidi", preferredLanguage: "ar" },
  { displayName: "Sarah Thompson", preferredLanguage: "en" },
  { displayName: "Mariam Al Blooshi", preferredLanguage: "ar" },
  { displayName: "Lena Kowalski", preferredLanguage: "en" },
  { displayName: "Noora Al Mazrouei", preferredLanguage: "ar" },
  { displayName: "Aisha Rahman", preferredLanguage: "en" },
  { displayName: "Layla Haddad", preferredLanguage: "ar" },
  { displayName: "Priya Sharma", preferredLanguage: "en" },
  { displayName: "Hessa Al Falasi", preferredLanguage: "ar" },
  { displayName: "Emma Wilson", preferredLanguage: "en" },
  { displayName: "Reem Al Marzouqi", preferredLanguage: "ar" },
  { displayName: "Yasmin Osman", preferredLanguage: "ar" },
  { displayName: "Alina Petrova", preferredLanguage: "en" },
  { displayName: "Salama Al Kaabi", preferredLanguage: "ar" },
  { displayName: "Grace Mensah", preferredLanguage: "en" },
  { displayName: "Dana Al Nuaimi", preferredLanguage: "ar" },
  { displayName: "Camille Dubois", preferredLanguage: "en" },
  { displayName: "Shaikha Al Ameri", preferredLanguage: "ar" },
];

interface BookingSpec {
  customerIndex: number;
  serviceIndex: number;
  daysOffset: number; // relative to today, Dubai calendar day
  hour: number; // Dubai local hour, 24h
  status: BookingStatus;
  isNewCustomer: boolean;
  source: BookingSource;
}

function parseArgs(argv: string[]) {
  const args = {
    email: process.env.BOOKING_DEMO_EMAIL ?? "",
    slug: process.env.BOOKING_DEMO_SLUG ?? "",
  };
  for (const arg of argv) {
    if (arg.startsWith("--email=")) args.email = arg.slice("--email=".length);
    if (arg.startsWith("--slug=")) args.slug = arg.slice("--slug=".length);
  }
  return args;
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** Dubai-local wall clock time for `daysOffset` days from today, as a UTC Date. */
function gstSlot(daysOffset: number, hour: number, minute = 0): Date {
  const dayStart = addDays(startOfTodayGst(), daysOffset);
  return new Date(dayStart.getTime() + (hour * 60 + minute) * 60 * 1000);
}

function localPhone(n: number): string {
  return `05012345${String(n).padStart(2, "0")}`;
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
      .join(" ") || "Booking Demo Owner";
  return { id: clerkUser.id, email, fullName };
}

async function resolveTargetRestaurant(ownerId: string, slug: string) {
  const restaurants = await prisma.restaurant.findMany({
    where: { ownerId },
    select: { id: true, slug: true },
  });

  if (slug) {
    const match = restaurants.find((r) => r.slug === slug);
    if (!match) {
      throw new Error(
        `Owner has no restaurant with slug "${slug}". Available: ${restaurants.map((r) => r.slug).join(", ") || "none"}`
      );
    }
    return match;
  }

  if (restaurants.length === 0) {
    throw new Error(
      "Owner has no restaurant yet. This script updates an existing tenant only — sign up and create one first, then re-run."
    );
  }
  if (restaurants.length > 1) {
    throw new Error(
      `Owner has ${restaurants.length} restaurants; pass --slug=<slug> to pick one. Available: ${restaurants
        .map((r) => r.slug)
        .join(", ")}`
    );
  }
  return restaurants[0];
}

/** Deletes this tenant's booking-domain rows AND resets its owner-chat agent
 *  so the demo never contradicts itself with restaurant-era context.
 *  Bookings are deleted before services/categories to respect the FK
 *  Restrict on Booking.service/Booking.customer. Customers are intentionally
 *  NOT cleared here — they're upserted by phone in seedCustomers().
 *
 *  Agent reset (all restaurant-scoped, run before reseeding):
 *  - OwnerChatMessage: ALL rows deleted first (no FK from OwnerChatMemory/
 *    DraftAction back to it — draftId/whisperId/etc. are the *dependent*
 *    side), so it's safe before the weekly report/message are recreated.
 *  - OwnerChatMemory: ALL rows deleted (stale facts/preferences about the
 *    old restaurant).
 *  - OwnerWhisper / ProactiveNudge / WeeklyReport: ALL rows deleted (not
 *    just the target week) so no restaurant-era report moments resurface.
 *  - DraftAction: NOT deleted (FK-referenced from ship history / activity
 *    feed reads) — instead, any row still in "pending" or "scheduled"
 *    status is neutralized to "rejected" via updateMany so stale pending
 *    actions (e.g. an old "Sabt Pack" proposal) stop cluttering inbox
 *    badges. Terminal-status rows (shipped/approved/rejected/expired/
 *    failed) are left untouched as historical record. */
async function clearBookingDemo(restaurantId: string) {
  await prisma.ownerChatMessage.deleteMany({ where: { restaurantId } });
  await prisma.ownerChatMemory.deleteMany({ where: { restaurantId } });
  await prisma.ownerWhisper.deleteMany({ where: { restaurantId } });
  await prisma.proactiveNudge.deleteMany({ where: { restaurantId } });
  await prisma.weeklyReport.deleteMany({ where: { restaurantId } });

  await prisma.draftAction.updateMany({
    where: {
      restaurantId,
      status: { in: [DraftActionStatus.pending, DraftActionStatus.scheduled] },
    },
    data: {
      status: DraftActionStatus.rejected,
      decisionAt: new Date(),
      decidedBy: null,
      rejectionReason: "Cleared by booking-demo seed reset",
      shipAt: null,
    },
  });

  await prisma.booking.deleteMany({ where: { restaurantId } });
  await prisma.payoutRecord.deleteMany({ where: { restaurantId } });
  await prisma.service.deleteMany({ where: { restaurantId } });
  await prisma.serviceCategory.deleteMany({ where: { restaurantId } });
}

async function seedCustomers(restaurantId: string) {
  const customers: { id: string; displayName: string }[] = [];
  for (const [index, customer] of CUSTOMERS.entries()) {
    const rawPhone = localPhone(index + 1);
    const normalizedPhone = normalizeUaePhone(rawPhone);
    if (!normalizedPhone) {
      throw new Error(`Bad demo phone at index ${index}: ${rawPhone}`);
    }
    const created = await prisma.customer.upsert({
      where: { restaurantId_normalizedPhone: { restaurantId, normalizedPhone } },
      update: {
        displayName: customer.displayName,
        preferredLanguage: customer.preferredLanguage,
      },
      create: {
        restaurantId,
        normalizedPhone,
        phoneNumber: rawPhone,
        displayName: customer.displayName,
        preferredLanguage: customer.preferredLanguage,
        marketingOptIn: true,
        marketingOptInAt: new Date(),
      },
    });
    customers.push({ id: created.id, displayName: created.displayName });
  }
  return customers;
}

async function seedServices(restaurantId: string) {
  const services: { id: string; name: string; durationMinutes: number }[] = [];
  for (const [categoryIndex, category] of SERVICE_CATEGORIES.entries()) {
    const createdCategory = await prisma.serviceCategory.create({
      data: { restaurantId, name: category.name, sortOrder: categoryIndex },
    });

    for (const [serviceIndex, service] of category.services.entries()) {
      const created = await prisma.service.create({
        data: {
          restaurantId,
          categoryId: createdCategory.id,
          name: service.name,
          priceAed: service.priceAed,
          durationMinutes: service.durationMinutes,
          sortOrder: serviceIndex,
        },
      });
      services.push({
        id: created.id,
        name: created.name,
        durationMinutes: created.durationMinutes,
      });
    }
  }
  return services;
}

/** Builds the exact 31-booking distribution required by the booking-demo
 *  brief: 12 COMPLETED, 4 NO_SHOW, 8 CONFIRMED (3 of them today, Dubai),
 *  3 INQUIRY, 2 DEPOSIT_SENT, 1 CANCELLED, 1 EXPIRED. */
function buildBookingSpecs(customerCount: number, serviceCount: number): BookingSpec[] {
  const specs: BookingSpec[] = [];

  const completedDaysAgo = [1, 2, 4, 5, 7, 9, 10, 12, 14, 16, 18, 21];
  const completedIsNew = [true, false, false, true, false, false, true, false, false, true, false, true];
  const sourceCycle: BookingSource[] = ["WHATSAPP", "AD", "REACTIVATION"];
  completedDaysAgo.forEach((daysAgo, i) => {
    specs.push({
      customerIndex: i % customerCount,
      serviceIndex: i % serviceCount,
      daysOffset: -daysAgo,
      hour: 10 + (i % 8),
      status: "COMPLETED",
      isNewCustomer: completedIsNew[i],
      source: sourceCycle[i % sourceCycle.length],
    });
  });

  const noShowDaysAgo = [3, 7, 12, 18];
  const noShowIsNew = [true, true, false, false];
  noShowDaysAgo.forEach((daysAgo, i) => {
    specs.push({
      customerIndex: (i + 12) % customerCount,
      serviceIndex: (i + 12) % serviceCount,
      daysOffset: -daysAgo,
      hour: 11 + i,
      status: "NO_SHOW",
      isNewCustomer: noShowIsNew[i],
      source: "WHATSAPP",
    });
  });

  // Today (x3) + the next 5 days — satisfies the "at least 3 today" requirement.
  const confirmedOffsets = [0, 0, 0, 1, 2, 3, 4, 5];
  const confirmedIsNew = [true, false, true, false, true, false, true, false];
  confirmedOffsets.forEach((daysOffset, i) => {
    specs.push({
      customerIndex: (i + 16) % customerCount,
      serviceIndex: (i + 16) % serviceCount,
      daysOffset,
      hour: 10 + i,
      status: "CONFIRMED",
      isNewCustomer: confirmedIsNew[i],
      source: i % 2 === 0 ? "WHATSAPP" : "AD",
    });
  });

  const inquiryOffsets = [2, 4, 6];
  inquiryOffsets.forEach((daysOffset, i) => {
    specs.push({
      customerIndex: (i + 24) % customerCount,
      serviceIndex: (i + 24) % serviceCount,
      daysOffset,
      hour: 13 + i,
      status: "INQUIRY",
      isNewCustomer: i % 2 === 0,
      source: "WHATSAPP",
    });
  });

  const depositOffsets = [3, 5];
  depositOffsets.forEach((daysOffset, i) => {
    specs.push({
      customerIndex: (i + 27) % customerCount,
      serviceIndex: (i + 27) % serviceCount,
      daysOffset,
      hour: 15 + i,
      status: "DEPOSIT_SENT",
      isNewCustomer: i === 0,
      source: "WHATSAPP",
    });
  });

  specs.push({
    customerIndex: 29 % customerCount,
    serviceIndex: 29 % serviceCount,
    daysOffset: -6,
    hour: 14,
    status: "CANCELLED",
    isNewCustomer: false,
    source: "WHATSAPP",
  });

  specs.push({
    customerIndex: 30 % customerCount,
    serviceIndex: 30 % serviceCount,
    daysOffset: -9,
    hour: 16,
    status: "EXPIRED",
    isNewCustomer: false,
    source: "WHATSAPP",
  });

  return specs;
}

async function seedBookings(
  restaurantId: string,
  customers: { id: string }[],
  services: { id: string; durationMinutes: number }[]
) {
  const specs = buildBookingSpecs(customers.length, services.length);

  for (const spec of specs) {
    const customer = customers[spec.customerIndex];
    const service = services[spec.serviceIndex];
    const slotAt = gstSlot(spec.daysOffset, spec.hour);

    const isFeeCounted = FEE_COUNTED_STATUSES.includes(spec.status);
    const billable = isFeeCounted && spec.isNewCustomer;
    const hasDeposit = isFeeCounted || spec.status === "DEPOSIT_SENT";

    let confirmedAt: Date | null = null;
    let resolvedAt: Date | null = null;
    if (spec.status === "CONFIRMED") {
      // Confirmed yesterday morning — always in the past, always before slotAt.
      confirmedAt = gstSlot(-1, 9);
    } else if (spec.status === "COMPLETED" || spec.status === "NO_SHOW") {
      confirmedAt = new Date(slotAt.getTime() - 2 * 24 * 60 * 60 * 1000);
      resolvedAt = new Date(slotAt.getTime() + service.durationMinutes * 60 * 1000);
    }

    await prisma.booking.create({
      data: {
        restaurantId,
        customerId: customer.id,
        serviceId: service.id,
        slotAt,
        status: spec.status,
        isNewCustomer: spec.isNewCustomer,
        feeAed: billable ? 50 : 0,
        depositAed: hasDeposit ? 50 : 0,
        source: spec.source,
        confirmedAt,
        resolvedAt,
      },
    });
  }
}

async function seedPayout(restaurantId: string) {
  const thisWeekStart = startOfWeekGst();
  const lastWeekStart = addDays(thisWeekStart, -7);
  const lastWeekEnd = new Date(thisWeekStart.getTime() - 1); // end of last Sunday, Dubai

  await prisma.payoutRecord.create({
    data: {
      restaurantId,
      periodStart: lastWeekStart,
      periodEnd: lastWeekEnd,
      depositsCollectedAed: 450,
      feesKeptAed: 250,
      amountDueAed: 200,
      status: "PENDING",
    },
  });
}

async function seedWeeklyReport(restaurantId: string, weekStartDate: Date) {
  const tiles = computeBookingWeeklyTiles({
    newCustomers: { thisWeek: 5, lastWeek: 3 },
    bookings: { thisWeek: 14, lastWeek: 11 },
    feesAed: { thisWeek: 250, lastWeek: 150 },
    noShowRatePct: { thisWeek: 12, lastWeek: 20 },
  });

  const narrative =
    "This week brought 14 bookings and 5 new customers through the door, a solid step up from last week. " +
    "Fees earned climbed to AED 250 as more first-time guests confirmed appointments. " +
    "No-shows eased to 12%, down from 20% the week before, so the tighter deposit reminders are paying off. " +
    "Keep an eye on the inbox — a few guests are waiting on a reply before they'll commit to a slot.";

  const actions: WeeklyAction[] = [
    {
      label: "Fill next week's quiet slots",
      seedPrompt: "Draft a WhatsApp campaign to fill our quietest booking slots next week.",
      kind: "bookings",
    },
    {
      label: "Clear the WhatsApp inbox",
      seedPrompt: "Show me the customers waiting on a WhatsApp reply so I can follow up.",
      kind: "inbox",
    },
  ];

  const weekly = await prisma.weeklyReport.create({
    data: {
      restaurantId,
      weekStart: weekStartDate,
      narrative,
      metricsJson: asJson({ tiles }),
      actionsJson: asJson(actions),
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
    },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.email) {
    throw new Error("Provide --email=<owner email> or BOOKING_DEMO_EMAIL.");
  }

  console.log(`Seeding salon booking demo for ${args.email}...\n`);

  const clerkUser = await loadClerkUser(args.email);
  const owner = await prisma.user.upsert({
    where: { clerkId: clerkUser.id },
    update: { email: clerkUser.email, fullName: clerkUser.fullName },
    create: {
      clerkId: clerkUser.id,
      email: clerkUser.email,
      fullName: clerkUser.fullName,
      role: "restaurant_owner",
    },
  });

  const target = await resolveTargetRestaurant(owner.id, args.slug);

  const restaurant = await prisma.restaurant.update({
    where: { id: target.id },
    data: {
      name: RESTAURANT_UPDATE.name,
      businessType: RESTAURANT_UPDATE.businessType,
      newCustomerFeeAed: RESTAURANT_UPDATE.newCustomerFeeAed,
      depositAed: RESTAURANT_UPDATE.depositAed,
      bookingPolicies: asJson(RESTAURANT_UPDATE.bookingPolicies),
    },
  });

  const weekStartIso = lastCompletedWeekStartIso(Date.now());
  const weekStartDate = new Date(weekStartIso);

  await clearBookingDemo(restaurant.id);

  const customers = await seedCustomers(restaurant.id);
  const services = await seedServices(restaurant.id);
  await seedBookings(restaurant.id, customers, services);
  await seedPayout(restaurant.id);
  await seedWeeklyReport(restaurant.id, weekStartDate);

  console.log("Done.\n");
  console.log(`Owner email:     ${owner.email}`);
  console.log(`Restaurant id:   ${restaurant.id}`);
  console.log(`Restaurant slug: ${restaurant.slug}`);
  console.log(`Public URL:      https://getbustan.com/${restaurant.slug}`);
  console.log(`Dashboard URL:   https://getbustan.com/dashboard`);
}

main()
  .catch((err) => {
    console.error("Booking demo seed failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

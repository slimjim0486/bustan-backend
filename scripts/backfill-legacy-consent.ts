// One-off backfill: gives a CustomerConsent paper-trail row to customers who
// were flagged `marketingOptIn = true` BEFORE the CustomerConsent table existed
// (or via import) and therefore have ZERO consent rows. Without a row the
// campaign send filter (marketing-eligibility.ts) correctly refuses to message
// them — which is the "preview says 1 qualifies, send says 0" bug.
//
// Safety:
//  - Only touches customers with `marketingOptIn = true` AND no consent rows at
//    all. Never writes over an existing trail (an existing opt_out must win).
//  - The synthetic row is honestly labelled `source: 'legacy_migration'` and
//    dated to the customer's existing `marketingOptInAt` (or `createdAt` if that
//    was never set), so it documents "opted in before we tracked consent rows"
//    rather than fabricating a fresh consent event.
//  - Idempotent: after a successful --apply the customer has a row, so a re-run
//    skips them.
//
// Usage:
//   npm run backfill:legacy-consent                     # dry-run, prints what would change
//   npm run backfill:legacy-consent -- --apply          # actually writes
//   npm run backfill:legacy-consent -- --apply --restaurant=<id-or-slug>

import "dotenv/config";

const args = process.argv.slice(2);
function flag(name: string): string | true | null {
  for (const arg of args) {
    if (arg === `--${name}`) return true;
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  }
  return null;
}

const apply = flag("apply") === true;
const restaurantArg = flag("restaurant");
const restaurantFilter = typeof restaurantArg === "string" ? restaurantArg : null;

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { needsLegacyConsentBackfill } = await import(
    "../src/lib/marketing-eligibility"
  );

  let restaurantId: string | null = null;
  if (restaurantFilter) {
    const restaurant = await prisma.restaurant.findFirst({
      where: { OR: [{ id: restaurantFilter }, { slug: restaurantFilter }] },
      select: { id: true, slug: true, name: true },
    });
    if (!restaurant) {
      console.error(`No restaurant matched "${restaurantFilter}".`);
      process.exit(1);
    }
    restaurantId = restaurant.id;
    console.log(`Scoped to restaurant: ${restaurant.name} (${restaurant.slug})`);
  }

  // Candidates: opted-in boolean, but zero consent rows of any kind.
  const candidates = await prisma.customer.findMany({
    where: {
      marketingOptIn: true,
      consents: { none: {} },
      ...(restaurantId ? { restaurantId } : {}),
    },
    select: {
      id: true,
      restaurantId: true,
      normalizedPhone: true,
      marketingOptInAt: true,
      createdAt: true,
      _count: { select: { consents: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(
    `\n${candidates.length} customer(s) flagged opted-in with no consent paper trail.`
  );
  if (candidates.length === 0) {
    console.log("Nothing to backfill. ✅");
    return;
  }

  let written = 0;
  let timestampsFilled = 0;

  for (const customer of candidates) {
    // Belt-and-braces: the query already guarantees this, but assert the
    // shared rule so the script and the runtime agree on what "needs backfill"
    // means.
    if (
      !needsLegacyConsentBackfill({
        marketingOptIn: true,
        consentCount: customer._count.consents,
      })
    ) {
      continue;
    }

    const consentDate = customer.marketingOptInAt ?? customer.createdAt;
    const needsTimestamp = customer.marketingOptInAt === null;

    if (apply) {
      await prisma.$transaction(async (tx) => {
        await tx.customerConsent.create({
          data: {
            restaurantId: customer.restaurantId,
            customerId: customer.id,
            status: "opt_in",
            channel: "whatsapp",
            source: "legacy_migration",
            createdAt: consentDate,
          },
        });
        if (needsTimestamp) {
          await tx.customer.update({
            where: { id: customer.id },
            data: { marketingOptInAt: consentDate },
          });
        }
      });
    }

    written += 1;
    if (needsTimestamp) timestampsFilled += 1;
  }

  const verb = apply ? "Backfilled" : "Would backfill";
  console.log(
    `\n${verb} ${written} consent row(s) (source=legacy_migration).` +
      `\n${apply ? "Filled" : "Would fill"} ${timestampsFilled} missing marketingOptInAt timestamp(s).`
  );
  if (!apply) {
    console.log("\nDry run — no writes. Re-run with --apply to commit.");
  } else {
    console.log("\nDone. ✅");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    const { prisma } = await import("../src/lib/prisma");
    await prisma.$disconnect();
  });

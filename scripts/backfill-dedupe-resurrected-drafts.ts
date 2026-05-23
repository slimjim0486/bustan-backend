// One-off backfill: dismisses pending event-stager / sabt-pack drafts that
// were resurrected by the daily cron AFTER the owner had already acted on the
// original. Pairs with the ensureSystemDraftForAdProject fix that stopped the
// resurrection going forward.
//
// Logic: for each (restaurantId, adProjectId, actionType) tuple, if there's
// a sibling draft in a "decided" state (approved/scheduled/shipped/rejected),
// the pending draft is a resurrection that should never have been created.
// Mark it `expired` (terminal, removes from inbox) rather than deleting so
// the audit trail survives.
//
// Usage:
//   npm run backfill:dedupe-drafts                # dry-run, prints what would change
//   npm run backfill:dedupe-drafts -- --apply     # actually writes
//   npm run backfill:dedupe-drafts -- --apply --restaurant=<id>

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
  const { DraftActionStatus } = await import("@prisma/client");

  // Find all pending drafts attached to an adProject — these are the
  // candidates. We'll then check each for a sibling in a decided state.
  const pending = await prisma.draftAction.findMany({
    where: {
      status: DraftActionStatus.pending,
      adProjectId: { not: null },
      ...(restaurantFilter ? { restaurantId: restaurantFilter } : {}),
    },
    select: {
      id: true,
      restaurantId: true,
      adProjectId: true,
      actionType: true,
      title: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(
    `[backfill] mode=${apply ? "APPLY" : "DRY_RUN"} ` +
      `restaurant=${restaurantFilter ?? "all"} pendingCandidates=${pending.length}`
  );

  const DECIDED_STATUSES = [
    DraftActionStatus.approved,
    DraftActionStatus.scheduled,
    DraftActionStatus.shipped,
    DraftActionStatus.rejected,
  ];

  let resolved = 0;
  for (const p of pending) {
    if (!p.adProjectId) continue;

    const decidedSibling = await prisma.draftAction.findFirst({
      where: {
        restaurantId: p.restaurantId,
        adProjectId: p.adProjectId,
        actionType: p.actionType,
        status: { in: DECIDED_STATUSES },
        id: { not: p.id },
      },
      select: { id: true, status: true, decisionAt: true },
    });

    if (!decidedSibling) continue; // No prior decision — leave the pending alone.

    console.log(
      `  ${apply ? "EXPIRE" : "WOULD"} ${p.id} (${p.title}) ` +
        `— sibling ${decidedSibling.id} already ${decidedSibling.status}`
    );

    if (apply) {
      await prisma.draftAction.update({
        where: { id: p.id },
        data: {
          status: DraftActionStatus.expired,
          decisionAt: new Date(),
        },
      });
    }
    resolved += 1;
  }

  console.log(
    `[backfill] done. expired=${resolved} ` +
      `total candidates=${pending.length} ${apply ? "" : "(dry run — re-run with --apply)"}`
  );
}

main()
  .catch((error) => {
    console.error("[backfill] failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { prisma } = await import("../src/lib/prisma");
    await prisma.$disconnect();
  });

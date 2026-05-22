// One-off backfill: sets primaryDishId on event-stager drafts that were
// created before the auto-pick fix landed (PR for the Summer Slump 2026
// "no featured dish" failure). The migration is idempotent — re-runs only
// touch projects that still have primaryDishId IS NULL.
//
// Usage:
//   npm run backfill:staged-draft-hero-dish               # dry-run, prints what would change
//   npm run backfill:staged-draft-hero-dish -- --apply    # actually writes
//   npm run backfill:staged-draft-hero-dish -- --apply --restaurant=<id>
//
// Scope: only projects with sourceMomentId IS NOT NULL (event-stager output)
// in status `draft` or `failed` with `primaryDishId IS NULL`. We don't touch
// `ready`/`exported`/`generating`/`archived` projects — those are either live
// or in-flight and the dish field, if it matters, has already been used.

import "dotenv/config";
import type { Prisma } from "@prisma/client";

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
  const { pickHeroDishForRestaurant } = await import(
    "../src/services/ad-studio-ai/hero-dish-picker"
  );

  const projects = await prisma.adProject.findMany({
    where: {
      sourceMomentId: { not: null },
      primaryDishId: null,
      status: { in: ["draft", "failed"] },
      ...(restaurantFilter ? { restaurantId: restaurantFilter } : {}),
    },
    select: {
      id: true,
      restaurantId: true,
      name: true,
      status: true,
      briefJson: true,
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(
    `[backfill] mode=${apply ? "APPLY" : "DRY_RUN"} ` +
      `restaurant=${restaurantFilter ?? "all"} candidates=${projects.length}`
  );

  let updated = 0;
  let skippedNoMenu = 0;

  for (const project of projects) {
    const picked = await pickHeroDishForRestaurant(project.restaurantId);
    if (!picked) {
      console.log(
        `  - SKIP ${project.id} (${project.name}) — restaurant ${project.restaurantId} has no menu items`
      );
      skippedNoMenu += 1;
      continue;
    }

    console.log(
      `  ${apply ? "WRITE" : "WOULD"} ${project.id} (${project.name}) ` +
        `status=${project.status} -> dish=${picked.id} "${picked.name}"`
    );

    if (apply) {
      const currentBrief =
        project.briefJson && typeof project.briefJson === "object" && !Array.isArray(project.briefJson)
          ? (project.briefJson as Record<string, unknown>)
          : {};
      const nextBrief = { ...currentBrief, primaryDishId: picked.id };

      await prisma.adProject.update({
        where: { id: project.id },
        data: {
          primaryDishId: picked.id,
          briefJson: nextBrief as Prisma.InputJsonValue,
        },
      });
      updated += 1;
    }
  }

  console.log(
    `[backfill] done. updated=${updated} skippedNoMenu=${skippedNoMenu} ` +
      `total=${projects.length} ${apply ? "" : "(dry run — re-run with --apply)"}`
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

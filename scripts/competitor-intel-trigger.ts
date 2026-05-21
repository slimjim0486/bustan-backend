// One-off Market Pulse runner for local dev + staging smoke tests.
//
// Usage:
//   npm run market-pulse:trigger -- --restaurant=<id>
//   npm run market-pulse:trigger -- --restaurant=<id> --week=2026-05-17
//   npm run market-pulse:trigger -- --restaurant=<id> --enqueue
//
// Modes:
//   default:     runs the orchestrator directly (no worker). Useful for
//                inspecting the result object inline. Still hits real Exa
//                + Apify if EXA_ENABLED=true.
//   --enqueue:   enqueues through the pg-boss worker so the run flows
//                through the same path as the Sunday cron — used to
//                smoke-test the worker plumbing end-to-end.
//
// Safety:
//   Honors EXA_ENABLED. If false (the default), the orchestrator returns
//   skipped_disabled and no spend is incurred. Set EXA_ENABLED=true in
//   .env before dogfooding.

import "dotenv/config";

const args = process.argv.slice(2);
function flag(name: string): string | true | null {
  for (const arg of args) {
    if (arg === `--${name}`) return true;
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  }
  return null;
}

const restaurantArg = flag("restaurant");
const restaurantId = typeof restaurantArg === "string" ? restaurantArg : null;
if (!restaurantId) {
  console.error(
    "Usage: npm run market-pulse:trigger -- --restaurant=<id> [--week=YYYY-MM-DD] [--enqueue]"
  );
  process.exit(1);
}

const weekArg = flag("week");
const weekBucket = typeof weekArg === "string" ? weekArg : undefined;
const enqueue = flag("enqueue") === true;

async function main() {
  console.log(
    `[market-pulse-trigger] restaurant=${restaurantId} week=${weekBucket ?? "current"} mode=${enqueue ? "enqueue" : "direct"}`
  );

  if (enqueue) {
    const { enqueueCompetitorIntelForRestaurant } = await import(
      "../src/queue/competitor-intel"
    );
    await enqueueCompetitorIntelForRestaurant(restaurantId!, weekBucket);
    console.log(
      `[market-pulse-trigger] enqueued — tail worker logs for "[market-pulse] ${restaurantId}"`
    );
    return;
  }

  const { runCompetitorIntelForRestaurant } = await import(
    "../src/services/competitor-intel"
  );

  const result = await runCompetitorIntelForRestaurant({
    restaurantId: restaurantId!,
    weekBucket,
    source: "manual",
  });

  console.log("[market-pulse-trigger] result:");
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error("[market-pulse-trigger] failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { prisma } = await import("../src/lib/prisma");
    await prisma.$disconnect();
  });

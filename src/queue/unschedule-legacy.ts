// One-shot cleanup for pg-boss cron schedules that no longer exist in code.
//
// All time-based jobs were removed on 2026-09-06 (Sabt Pack, meta-sync,
// whispers, weekly reports, day summaries, retention sweeps, etc.). The
// schedule rows were deleted directly in prod the same day, but pg-boss
// persists schedules in the DB, so an older build restarting before this one
// deploys could re-create them. This sweep runs on boot and is idempotent
// (unschedule of a missing name is a no-op). Safe to delete after one deploy.

import { getBoss } from "@/queue/boss";

const LEGACY_SCHEDULE_NAMES = [
  "sabt-pack-fanout",
  "ad-studio-meta-sync-fanout",
  "booking-day-summary-fanout",
  "competitor-intel-fanout",
  "coworker-daily-brief-fanout",
  "event-stager-fanout",
  "gsc-sync",
  "order-intent-expiry-sweep",
  "owner-chat-memory-fanout",
  "owner-whisper-fanout",
  "weekly-report-fanout",
  "whatsapp-retention-sweep",
] as const;

export async function unscheduleLegacyCrons() {
  const queue = await getBoss();
  for (const name of LEGACY_SCHEDULE_NAMES) {
    await queue.unschedule(name);
  }
  console.log(
    `[cron-cleanup] ensured ${LEGACY_SCHEDULE_NAMES.length} legacy schedules are removed`
  );
}

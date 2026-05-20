-- Event-driven auto-staging for Ad Studio. Pre-stages a draft AdProject for
-- every calendar moment in a restaurant's prep window so the owner wakes up
-- to a ready brief instead of having to remember Ramadan/Eid/National Day.
--
-- Additive only. Reuses ad_projects to inherit the existing project flows
-- (review, generate creatives, publish). New rows are tagged via source_moment_*
-- fields. Idempotency: unique (restaurant_id, source_moment_id, source_moment_year).

-- AlterTable: tag AdProject rows that were auto-staged from a calendar moment.
ALTER TABLE "ad_projects"
  ADD COLUMN "source_moment_id" TEXT,
  ADD COLUMN "source_moment_year" INTEGER,
  ADD COLUMN "source_moment_starts_on" DATE,
  ADD COLUMN "source_moment_staged_at" TIMESTAMP(3);

-- AlterTable: master toggle on Restaurant. Default true so Pro/Portfolio
-- restaurants get event-driven drafts automatically without owner config.
-- Owners can opt out from settings if they prefer to drive briefs manually.
ALTER TABLE "restaurants"
  ADD COLUMN "event_calendar_enabled" BOOLEAN NOT NULL DEFAULT true;

-- Idempotency key — a single moment occurrence (e.g., Ramadan 2026) can only
-- have one staged draft per restaurant. The cron is safe to re-run without
-- duplicating drafts.
CREATE UNIQUE INDEX "ad_projects_restaurant_source_moment_year_key"
  ON "ad_projects"("restaurant_id", "source_moment_id", "source_moment_year");

-- Index supports the calendar page query (find staged drafts for a restaurant
-- so we can pin a "Draft ready" chip next to each matching moment card).
CREATE INDEX "ad_projects_source_moment_idx"
  ON "ad_projects"("source_moment_id", "source_moment_year");

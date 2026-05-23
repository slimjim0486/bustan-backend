-- Event-calendar linkage for promotions. Mirrors the source_moment_* columns
-- already on ad_projects so a single calendar moment (Ramadan 2026, Eid 2026,
-- National Day 2026, etc.) can join across promos and ad projects.
--
-- Additive only. All columns are nullable: existing promos remain valid and
-- continue to work unchanged. Owners only opt into the linkage when Sous Chef
-- creates a promo from an event prompt (e.g., "make Mansaf an Eid special").
--
-- Unlike ad_projects, there is NO unique constraint on (restaurant, moment, year)
-- because a restaurant may run multiple distinct promos during the same event
-- (e.g., a family-set deal AND a single-item discount during Eid).

ALTER TABLE "promotions"
  ADD COLUMN "source_moment_id" TEXT,
  ADD COLUMN "source_moment_year" INTEGER,
  ADD COLUMN "source_moment_starts_on" DATE;

-- Supports calendar UI queries that surface all promos tied to a given moment
-- (e.g., "show every Eid 2026 promo across my portfolio").
CREATE INDEX "promotions_source_moment_idx"
  ON "promotions"("source_moment_id", "source_moment_year");

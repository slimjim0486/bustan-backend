-- CreateTable
CREATE TABLE "competitor_snapshots" (
    "id" TEXT NOT NULL,
    "restaurant_id" TEXT NOT NULL,
    "competitor_place_id" TEXT NOT NULL,
    "week_bucket" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "distance_meters" INTEGER,
    "cuisine" TEXT,
    "rating" DECIMAL(2,1),
    "review_count" INTEGER,
    "menu_items" JSONB,
    "promotions" JSONB,
    "press_mentions" JSONB,
    "web_reviews" JSONB,
    "collector_status" JSONB,
    "changes" JSONB,
    "exa_cost_usd" DECIMAL(8,4),
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competitor_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitor_intel_digests" (
    "id" TEXT NOT NULL,
    "restaurant_id" TEXT NOT NULL,
    "week_bucket" TEXT NOT NULL,
    "top_insight" TEXT,
    "recommended_action" JSONB,
    "competitors_count" INTEGER NOT NULL DEFAULT 0,
    "notified_at" TIMESTAMP(3),
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competitor_intel_digests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "competitor_snapshots_restaurant_id_week_bucket_idx" ON "competitor_snapshots"("restaurant_id", "week_bucket");

-- CreateIndex
CREATE INDEX "competitor_snapshots_competitor_place_id_week_bucket_idx" ON "competitor_snapshots"("competitor_place_id", "week_bucket");

-- CreateIndex
CREATE UNIQUE INDEX "competitor_snapshots_competitor_place_id_week_bucket_restau_key" ON "competitor_snapshots"("competitor_place_id", "week_bucket", "restaurant_id");

-- CreateIndex
CREATE INDEX "competitor_intel_digests_restaurant_id_generated_at_idx" ON "competitor_intel_digests"("restaurant_id", "generated_at");

-- CreateIndex
CREATE UNIQUE INDEX "competitor_intel_digests_restaurant_id_week_bucket_key" ON "competitor_intel_digests"("restaurant_id", "week_bucket");

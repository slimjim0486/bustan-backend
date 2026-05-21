-- CreateEnum
CREATE TYPE "DraftActionKind" AS ENUM ('single', 'bulk', 'bundle');

-- CreateEnum
CREATE TYPE "DraftActionStatus" AS ENUM ('pending', 'approved', 'scheduled', 'shipped', 'rejected', 'expired', 'failed');

-- CreateEnum
CREATE TYPE "DraftActionSource" AS ENUM ('chat', 'quick_prompt', 'event_stager', 'sabt_pack', 'gsc_sync', 'page_macro');

-- DropForeignKey
ALTER TABLE "ad_live_campaigns" DROP CONSTRAINT "ad_live_campaigns_meta_integration_id_fkey";

-- DropForeignKey
ALTER TABLE "ad_live_campaigns" DROP CONSTRAINT "ad_live_campaigns_project_id_fkey";

-- DropForeignKey
ALTER TABLE "ad_performance_snapshots" DROP CONSTRAINT "ad_performance_snapshots_live_campaign_id_fkey";

-- DropForeignKey
ALTER TABLE "gsc_snapshots" DROP CONSTRAINT "gsc_snapshots_restaurant_id_fkey";

-- DropForeignKey
ALTER TABLE "meta_ads_integrations" DROP CONSTRAINT "meta_ads_integrations_restaurant_id_fkey";

-- DropIndex
DROP INDEX "ad_live_campaigns_external_ad_ids_gin_idx";

-- AlterTable
ALTER TABLE "ad_live_campaigns" ALTER COLUMN "external_ad_set_ids" DROP DEFAULT,
ALTER COLUMN "external_ad_ids" DROP DEFAULT;

-- AlterTable
ALTER TABLE "meta_ads_integrations" ALTER COLUMN "scopes" DROP DEFAULT;

-- CreateTable
CREATE TABLE "draft_actions" (
    "id" TEXT NOT NULL,
    "restaurant_id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "parent_draft_id" TEXT,
    "kind" "DraftActionKind" NOT NULL DEFAULT 'single',
    "action_type" TEXT NOT NULL,
    "source" "DraftActionSource" NOT NULL,
    "status" "DraftActionStatus" NOT NULL DEFAULT 'pending',
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "icon_key" TEXT,
    "affected_surface" TEXT,
    "payload" JSONB NOT NULL,
    "preview" JSONB NOT NULL,
    "child_count" INTEGER NOT NULL DEFAULT 0,
    "estimated_impact" JSONB,
    "decision_at" TIMESTAMP(3),
    "decided_by" TEXT,
    "rejection_reason" TEXT,
    "ship_at" TIMESTAMP(3),
    "shipped_at" TIMESTAMP(3),
    "ship_result" JSONB,
    "ship_error" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ad_project_id" TEXT,
    "campaign_id" TEXT,
    "menu_item_id" TEXT,

    CONSTRAINT "draft_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "draft_actions_restaurant_id_status_created_at_idx" ON "draft_actions"("restaurant_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "draft_actions_restaurant_id_source_idx" ON "draft_actions"("restaurant_id", "source");

-- CreateIndex
CREATE INDEX "draft_actions_parent_draft_id_idx" ON "draft_actions"("parent_draft_id");

-- CreateIndex
CREATE INDEX "draft_actions_ship_at_idx" ON "draft_actions"("ship_at");

-- CreateIndex
CREATE INDEX "order_intents_restaurant_id_payment_session_id_idx" ON "order_intents"("restaurant_id", "payment_session_id");

-- AddForeignKey
ALTER TABLE "gsc_snapshots" ADD CONSTRAINT "gsc_snapshots_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_live_campaigns" ADD CONSTRAINT "ad_live_campaigns_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "ad_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_live_campaigns" ADD CONSTRAINT "ad_live_campaigns_meta_integration_id_fkey" FOREIGN KEY ("meta_integration_id") REFERENCES "meta_ads_integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_ads_integrations" ADD CONSTRAINT "meta_ads_integrations_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_performance_snapshots" ADD CONSTRAINT "ad_performance_snapshots_live_campaign_id_fkey" FOREIGN KEY ("live_campaign_id") REFERENCES "ad_live_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_actions" ADD CONSTRAINT "draft_actions_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_actions" ADD CONSTRAINT "draft_actions_parent_draft_id_fkey" FOREIGN KEY ("parent_draft_id") REFERENCES "draft_actions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "ad_projects_restaurant_source_moment_year_key" RENAME TO "ad_projects_restaurant_id_source_moment_id_source_moment_ye_key";

-- RenameIndex
ALTER INDEX "ad_projects_sabt_pack_status_week_idx" RENAME TO "ad_projects_sabt_pack_status_sabt_pack_week_start_date_idx";

-- RenameIndex
ALTER INDEX "ad_projects_source_moment_idx" RENAME TO "ad_projects_source_moment_id_source_moment_year_idx";

-- RenameIndex
ALTER INDEX "gsc_snapshots_restaurant_id_date_desc_idx" RENAME TO "gsc_snapshots_restaurant_id_date_idx";

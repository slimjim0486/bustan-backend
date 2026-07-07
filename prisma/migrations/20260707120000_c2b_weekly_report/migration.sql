-- AlterTable
ALTER TABLE "owner_chat_messages" ADD COLUMN     "draft_id" TEXT,
ADD COLUMN     "weekly_report_id" TEXT;

-- CreateTable
CREATE TABLE "weekly_reports" (
    "id" TEXT NOT NULL,
    "restaurant_id" TEXT NOT NULL,
    "week_start" DATE NOT NULL,
    "narrative" TEXT NOT NULL,
    "metrics_json" JSONB NOT NULL,
    "actions_json" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unread',
    "read_at" TIMESTAMP(3),
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "weekly_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "weekly_reports_restaurant_id_generated_at_idx" ON "weekly_reports"("restaurant_id", "generated_at");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_reports_restaurant_id_week_start_key" ON "weekly_reports"("restaurant_id", "week_start");

-- CreateIndex
CREATE INDEX "owner_chat_messages_weekly_report_id_idx" ON "owner_chat_messages"("weekly_report_id");

-- AddForeignKey
ALTER TABLE "owner_chat_messages" ADD CONSTRAINT "owner_chat_messages_weekly_report_id_fkey" FOREIGN KEY ("weekly_report_id") REFERENCES "weekly_reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_reports" ADD CONSTRAINT "weekly_reports_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


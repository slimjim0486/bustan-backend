ALTER TABLE "restaurants"
  ADD COLUMN "diner_auto_reply_enabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "whatsapp_conversations"
  ADD COLUMN "bot_paused_until" TIMESTAMP(3),
  ADD COLUMN "bot_paused_reason" TEXT,
  ADD COLUMN "bot_disabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "whatsapp_messages"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'diner';

UPDATE "whatsapp_messages"
SET "source" = CASE
  WHEN "direction" = 'inbound' THEN 'diner'
  WHEN "direction" = 'outbound' THEN 'system'
  ELSE 'system'
END;

CREATE TABLE "concierge_usage" (
  "id" TEXT NOT NULL,
  "restaurant_id" TEXT NOT NULL,
  "month" TEXT NOT NULL,
  "replies_sent" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "concierge_usage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "concierge_usage_restaurant_id_month_key"
  ON "concierge_usage"("restaurant_id", "month");

ALTER TABLE "concierge_usage"
  ADD CONSTRAINT "concierge_usage_restaurant_id_fkey"
  FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

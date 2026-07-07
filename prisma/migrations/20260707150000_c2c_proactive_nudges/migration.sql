CREATE TABLE "proactive_nudges" (
  "id" TEXT NOT NULL,
  "restaurant_id" TEXT NOT NULL,
  "moment_id" TEXT NOT NULL,
  "moment_year" INTEGER NOT NULL,
  "ad_project_id" TEXT,
  "narrative" TEXT NOT NULL,
  "actions_json" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'unread',
  "read_at" TIMESTAMP(3),
  "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,

  CONSTRAINT "proactive_nudges_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "owner_chat_messages"
  ADD COLUMN "nudge_id" TEXT;

CREATE UNIQUE INDEX "proactive_nudges_restaurant_id_moment_id_moment_year_key"
  ON "proactive_nudges"("restaurant_id", "moment_id", "moment_year");

CREATE INDEX "proactive_nudges_restaurant_id_generated_at_idx"
  ON "proactive_nudges"("restaurant_id", "generated_at");

CREATE INDEX "owner_chat_messages_nudge_id_idx"
  ON "owner_chat_messages"("nudge_id");

ALTER TABLE "proactive_nudges"
  ADD CONSTRAINT "proactive_nudges_restaurant_id_fkey"
  FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "owner_chat_messages"
  ADD CONSTRAINT "owner_chat_messages_nudge_id_fkey"
  FOREIGN KEY ("nudge_id") REFERENCES "proactive_nudges"("id") ON DELETE SET NULL ON UPDATE CASCADE;

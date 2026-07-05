ALTER TABLE "draft_actions" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'dashboard_chat';
ALTER TABLE "draft_actions" ADD COLUMN "autonomy_tier" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "draft_actions" ADD COLUMN "idempotency_key" TEXT;
CREATE UNIQUE INDEX "draft_actions_idempotency_key_key" ON "draft_actions"("idempotency_key");
CREATE INDEX "draft_actions_restaurant_id_channel_created_at_idx" ON "draft_actions"("restaurant_id", "channel", "created_at" DESC);

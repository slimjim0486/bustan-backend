ALTER TABLE "restaurants" ADD COLUMN "agent_autonomy_opt_in" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "restaurants" ADD COLUMN "autonomy_resumed_at" TIMESTAMP(3);
ALTER TABLE "draft_actions" ADD COLUMN "auto_executed" BOOLEAN NOT NULL DEFAULT false;

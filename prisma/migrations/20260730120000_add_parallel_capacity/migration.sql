-- Add per-tenant overlapping-booking capacity (owner decision 2026-07-30: default 2)
ALTER TABLE "restaurants" ADD COLUMN "parallel_capacity" INTEGER NOT NULL DEFAULT 2;

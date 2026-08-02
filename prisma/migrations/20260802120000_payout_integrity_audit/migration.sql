-- Revenue-integrity hardening for the per-booking payout ledger.
-- Constraints are introduced NOT VALID so deployment remains additive-safe
-- if legacy rows need repair. PostgreSQL still enforces them for new and
-- updated rows. Validate them after the production preflight returns zero
-- violations.

CREATE TYPE "PayoutEventType" AS ENUM (
  'BOOKING_CONFIRMED',
  'PAYOUT_SETTLED',
  'REFUND',
  'ADJUSTMENT'
);

ALTER TABLE "payout_records"
  ADD COLUMN "paid_by_clerk_id" TEXT,
  ADD COLUMN "settled_deposits_aed" INTEGER,
  ADD COLUMN "settled_fees_aed" INTEGER,
  ADD COLUMN "settled_amount_due_aed" INTEGER;

-- Preserve a truthful snapshot shape for settlements created before actor
-- attribution existed. The preflight must still investigate any legacy row
-- whose updated_at is later than paid_at before this migration is deployed.
UPDATE "payout_records"
SET
  "paid_by_clerk_id" = 'legacy:unknown',
  "settled_deposits_aed" = "deposits_collected_aed",
  "settled_fees_aed" = "fees_kept_aed",
  "settled_amount_due_aed" = "amount_due_aed"
WHERE "status" = 'PAID';

ALTER TABLE "bookings"
  ADD COLUMN "stripe_payment_intent_id" TEXT,
  ADD COLUMN "stripe_confirmed_event_id" TEXT;

CREATE UNIQUE INDEX "bookings_stripe_payment_intent_id_key"
  ON "bookings"("stripe_payment_intent_id");
CREATE UNIQUE INDEX "bookings_stripe_confirmed_event_id_key"
  ON "bookings"("stripe_confirmed_event_id");

ALTER TABLE "restaurants"
  ADD COLUMN "onboarding_sandbox_test_count" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "payout_events" (
  "id" TEXT NOT NULL,
  "payout_record_id" TEXT NOT NULL,
  "booking_id" TEXT,
  "type" "PayoutEventType" NOT NULL,
  "deposits_delta_aed" INTEGER NOT NULL DEFAULT 0,
  "fees_delta_aed" INTEGER NOT NULL DEFAULT 0,
  "amount_due_delta_aed" INTEGER NOT NULL DEFAULT 0,
  "actor_clerk_id" TEXT,
  "reference" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payout_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payout_events_booking_id_type_key"
  ON "payout_events"("booking_id", "type");
CREATE INDEX "payout_events_payout_record_id_created_at_idx"
  ON "payout_events"("payout_record_id", "created_at");
CREATE INDEX "payout_events_type_created_at_idx"
  ON "payout_events"("type", "created_at");

ALTER TABLE "payout_events"
  ADD CONSTRAINT "payout_events_payout_record_id_fkey"
  FOREIGN KEY ("payout_record_id") REFERENCES "payout_records"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "payout_events"
  ADD CONSTRAINT "payout_events_booking_id_fkey"
  FOREIGN KEY ("booking_id") REFERENCES "bookings"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_money_nonnegative"
  CHECK ("deposit_aed" >= 0 AND "fee_aed" >= 0) NOT VALID,
  ADD CONSTRAINT "bookings_deposit_covers_fee"
  CHECK ("deposit_aed" >= "fee_aed") NOT VALID;

ALTER TABLE "payout_records"
  ADD CONSTRAINT "payout_records_money_nonnegative"
  CHECK (
    "deposits_collected_aed" >= 0
    AND "fees_kept_aed" >= 0
    AND "amount_due_aed" >= 0
  ) NOT VALID,
  ADD CONSTRAINT "payout_records_arithmetic"
  CHECK ("amount_due_aed" = "deposits_collected_aed" - "fees_kept_aed") NOT VALID,
  ADD CONSTRAINT "payout_records_paid_snapshot_complete"
  CHECK (
    "status" = 'PENDING'
    OR (
      "paid_at" IS NOT NULL
      AND "paid_by_clerk_id" IS NOT NULL
      AND "reference" IS NOT NULL
      AND "settled_deposits_aed" = "deposits_collected_aed"
      AND "settled_fees_aed" = "fees_kept_aed"
      AND "settled_amount_due_aed" = "amount_due_aed"
    )
  ) NOT VALID;

-- Phase 2: additive booking-operator schema.
-- Restaurant remains the tenant anchor; all restaurant-era tables stay intact.

CREATE TYPE "BusinessType" AS ENUM ('RESTAURANT', 'SALON', 'HOME_SERVICES');
CREATE TYPE "BookingStatus" AS ENUM (
  'INQUIRY',
  'DEPOSIT_SENT',
  'CONFIRMED',
  'COMPLETED',
  'NO_SHOW',
  'CANCELLED',
  'EXPIRED'
);
CREATE TYPE "BookingSource" AS ENUM (
  'WHATSAPP',
  'AD',
  'SEO',
  'REACTIVATION',
  'MANUAL'
);
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'PAID');

ALTER TABLE "restaurants"
  ADD COLUMN "business_type" "BusinessType" NOT NULL DEFAULT 'RESTAURANT',
  ADD COLUMN "new_customer_fee_aed" INTEGER,
  ADD COLUMN "deposit_aed" INTEGER,
  ADD COLUMN "booking_policies" JSONB,
  ADD COLUMN "onboarding_step" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "onboarding_completed" JSONB;

ALTER TABLE "restaurants"
  ADD CONSTRAINT "restaurants_deposit_covers_fee"
  CHECK (
    "deposit_aed" IS NULL
    OR "new_customer_fee_aed" IS NULL
    OR "deposit_aed" >= "new_customer_fee_aed"
  );

CREATE TABLE "service_categories" (
  "id" TEXT NOT NULL,
  "restaurant_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "name_ar" TEXT,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "service_categories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "services" (
  "id" TEXT NOT NULL,
  "restaurant_id" TEXT NOT NULL,
  "category_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "name_ar" TEXT,
  "description" TEXT,
  "price_aed" INTEGER NOT NULL,
  "duration_minutes" INTEGER NOT NULL DEFAULT 60,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bookings" (
  "id" TEXT NOT NULL,
  "restaurant_id" TEXT NOT NULL,
  "customer_id" TEXT NOT NULL,
  "service_id" TEXT NOT NULL,
  "slot_at" TIMESTAMP(3) NOT NULL,
  "status" "BookingStatus" NOT NULL DEFAULT 'INQUIRY',
  "is_new_customer" BOOLEAN NOT NULL,
  "fee_aed" INTEGER NOT NULL DEFAULT 0,
  "deposit_aed" INTEGER NOT NULL DEFAULT 0,
  "stripe_session_id" TEXT,
  "conversation_id" TEXT,
  "source" "BookingSource" NOT NULL DEFAULT 'WHATSAPP',
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmed_at" TIMESTAMP(3),
  "resolved_at" TIMESTAMP(3),
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payout_records" (
  "id" TEXT NOT NULL,
  "restaurant_id" TEXT NOT NULL,
  "period_start" TIMESTAMP(3) NOT NULL,
  "period_end" TIMESTAMP(3) NOT NULL,
  "deposits_collected_aed" INTEGER NOT NULL DEFAULT 0,
  "fees_kept_aed" INTEGER NOT NULL DEFAULT 0,
  "amount_due_aed" INTEGER NOT NULL DEFAULT 0,
  "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
  "paid_at" TIMESTAMP(3),
  "reference" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payout_records_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "service_categories_restaurant_id_sort_order_idx"
  ON "service_categories"("restaurant_id", "sort_order");
CREATE INDEX "services_restaurant_id_is_active_sort_order_idx"
  ON "services"("restaurant_id", "is_active", "sort_order");
CREATE INDEX "services_category_id_sort_order_idx"
  ON "services"("category_id", "sort_order");
CREATE UNIQUE INDEX "bookings_stripe_session_id_key"
  ON "bookings"("stripe_session_id");
CREATE INDEX "bookings_restaurant_id_slot_at_idx"
  ON "bookings"("restaurant_id", "slot_at");
CREATE INDEX "bookings_restaurant_id_status_slot_at_idx"
  ON "bookings"("restaurant_id", "status", "slot_at");
CREATE INDEX "bookings_customer_id_created_at_idx"
  ON "bookings"("customer_id", "created_at");
CREATE INDEX "bookings_service_id_slot_at_idx"
  ON "bookings"("service_id", "slot_at");
CREATE INDEX "bookings_conversation_id_idx"
  ON "bookings"("conversation_id");
CREATE UNIQUE INDEX "payout_records_restaurant_id_period_start_period_end_key"
  ON "payout_records"("restaurant_id", "period_start", "period_end");
CREATE INDEX "payout_records_restaurant_id_status_period_end_idx"
  ON "payout_records"("restaurant_id", "status", "period_end");

ALTER TABLE "service_categories"
  ADD CONSTRAINT "service_categories_restaurant_id_fkey"
  FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "services"
  ADD CONSTRAINT "services_restaurant_id_fkey"
  FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "services"
  ADD CONSTRAINT "services_category_id_fkey"
  FOREIGN KEY ("category_id") REFERENCES "service_categories"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_restaurant_id_fkey"
  FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_service_id_fkey"
  FOREIGN KEY ("service_id") REFERENCES "services"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "whatsapp_conversations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payout_records"
  ADD CONSTRAINT "payout_records_restaurant_id_fkey"
  FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

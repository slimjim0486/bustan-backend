-- Coworker — Sous Chef delivered over WhatsApp on Bustan's own WABA.
-- See schema.prisma "COWORKER" section for the design notes.

-- Enums --------------------------------------------------------------

CREATE TYPE "CoworkerOwnerStatus" AS ENUM ('pilot', 'active', 'paused', 'opted_out');

CREATE TYPE "CoworkerTemplateStatus" AS ENUM (
  'draft',
  'pending',
  'approved',
  'rejected',
  'paused',
  'disabled'
);

CREATE TYPE "CoworkerMessageDirection" AS ENUM ('outbound', 'inbound');

CREATE TYPE "CoworkerMessageStatus" AS ENUM (
  'queued',
  'sent',
  'delivered',
  'read',
  'failed',
  'received'
);

-- coworker_owners ----------------------------------------------------

CREATE TABLE "coworker_owners" (
  "id" TEXT NOT NULL,
  "restaurant_id" TEXT NOT NULL,
  "owner_user_id" TEXT NOT NULL,
  "owner_phone_e164" TEXT NOT NULL,
  "locale" TEXT NOT NULL DEFAULT 'en',
  "timezone" TEXT NOT NULL DEFAULT 'Asia/Dubai',
  "daily_brief_at" TEXT NOT NULL DEFAULT '08:00',
  "status" "CoworkerOwnerStatus" NOT NULL DEFAULT 'pilot',
  "window_expires_at" TIMESTAMP(3),
  "opted_in_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paused_at" TIMESTAMP(3),
  "opted_out_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "coworker_owners_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "coworker_owners_restaurant_id_key"
  ON "coworker_owners" ("restaurant_id");

CREATE UNIQUE INDEX "coworker_owners_owner_phone_e164_key"
  ON "coworker_owners" ("owner_phone_e164");

CREATE INDEX "coworker_owners_status_daily_brief_at_idx"
  ON "coworker_owners" ("status", "daily_brief_at");

CREATE INDEX "coworker_owners_owner_user_id_idx"
  ON "coworker_owners" ("owner_user_id");

ALTER TABLE "coworker_owners"
  ADD CONSTRAINT "coworker_owners_restaurant_id_fkey"
  FOREIGN KEY ("restaurant_id") REFERENCES "restaurants" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "coworker_owners"
  ADD CONSTRAINT "coworker_owners_owner_user_id_fkey"
  FOREIGN KEY ("owner_user_id") REFERENCES "users" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- coworker_templates -------------------------------------------------

CREATE TABLE "coworker_templates" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "locale" TEXT NOT NULL DEFAULT 'en',
  "category" TEXT NOT NULL DEFAULT 'UTILITY',
  "status" "CoworkerTemplateStatus" NOT NULL DEFAULT 'draft',
  "body" TEXT NOT NULL,
  "variables" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "buttons" JSONB,
  "footer" TEXT,
  "meta_template_id" TEXT,
  "rejection_reason" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "superseded_at" TIMESTAMP(3),
  "last_synced_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "coworker_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "coworker_templates_name_locale_version_key"
  ON "coworker_templates" ("name", "locale", "version");

CREATE INDEX "coworker_templates_status_name_idx"
  ON "coworker_templates" ("status", "name");

-- coworker_messages --------------------------------------------------

CREATE TABLE "coworker_messages" (
  "id" TEXT NOT NULL,
  "coworker_owner_id" TEXT NOT NULL,
  "restaurant_id" TEXT NOT NULL,
  "direction" "CoworkerMessageDirection" NOT NULL,
  "status" "CoworkerMessageStatus" NOT NULL DEFAULT 'queued',
  "template_name" TEXT,
  "body" TEXT NOT NULL,
  "provider_message_id" TEXT,
  "button_payload" TEXT,
  "cost_usd" DECIMAL(10,6),
  "idempotency_key" TEXT,
  "error_code" TEXT,
  "error_message" TEXT,
  "dry_run" BOOLEAN NOT NULL DEFAULT false,
  "sent_at" TIMESTAMP(3),
  "delivered_at" TIMESTAMP(3),
  "read_at" TIMESTAMP(3),
  "failed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "coworker_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "coworker_messages_provider_message_id_key"
  ON "coworker_messages" ("provider_message_id");

CREATE UNIQUE INDEX "coworker_messages_idempotency_key_key"
  ON "coworker_messages" ("idempotency_key");

CREATE INDEX "coworker_messages_coworker_owner_id_created_at_idx"
  ON "coworker_messages" ("coworker_owner_id", "created_at");

CREATE INDEX "coworker_messages_restaurant_id_direction_created_at_idx"
  ON "coworker_messages" ("restaurant_id", "direction", "created_at");

CREATE INDEX "coworker_messages_status_created_at_idx"
  ON "coworker_messages" ("status", "created_at");

ALTER TABLE "coworker_messages"
  ADD CONSTRAINT "coworker_messages_coworker_owner_id_fkey"
  FOREIGN KEY ("coworker_owner_id") REFERENCES "coworker_owners" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "coworker_messages"
  ADD CONSTRAINT "coworker_messages_restaurant_id_fkey"
  FOREIGN KEY ("restaurant_id") REFERENCES "restaurants" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

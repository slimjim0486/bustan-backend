-- CreateEnum
CREATE TYPE "GbpReviewSource" AS ENUM ('google', 'talabat', 'zomato', 'tripadvisor');

-- CreateEnum
CREATE TYPE "GbpReviewStatus" AS ENUM ('unanswered', 'draft_pending', 'draft_approved', 'posted', 'ignored', 'has_owner_reply');

-- CreateTable
CREATE TABLE "gbp_reviews" (
    "id" TEXT NOT NULL,
    "restaurant_id" TEXT NOT NULL,
    "source" "GbpReviewSource" NOT NULL DEFAULT 'google',
    "external_id" TEXT NOT NULL,
    "reviewer_name" TEXT NOT NULL,
    "reviewer_photo_url" TEXT,
    "rating" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "published_at" TIMESTAMP(3),
    "language" TEXT,
    "owner_response" TEXT,
    "status" "GbpReviewStatus" NOT NULL DEFAULT 'unanswered',
    "draft_reply" TEXT,
    "drafted_at" TIMESTAMP(3),
    "approved_at" TIMESTAMP(3),
    "posted_at" TIMESTAMP(3),
    "ignored_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gbp_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gbp_reviews_restaurant_id_status_published_at_idx" ON "gbp_reviews"("restaurant_id", "status", "published_at" DESC);

-- CreateIndex
CREATE INDEX "gbp_reviews_restaurant_id_rating_idx" ON "gbp_reviews"("restaurant_id", "rating");

-- CreateIndex
CREATE UNIQUE INDEX "gbp_reviews_restaurant_id_external_id_key" ON "gbp_reviews"("restaurant_id", "external_id");

-- AddForeignKey
ALTER TABLE "gbp_reviews" ADD CONSTRAINT "gbp_reviews_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

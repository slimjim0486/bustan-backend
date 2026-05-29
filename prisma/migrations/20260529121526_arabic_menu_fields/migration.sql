-- AlterTable
ALTER TABLE "dietary_tags" ADD COLUMN     "label_ar" TEXT;

-- AlterTable
ALTER TABLE "menu_items" ADD COLUMN     "description_ar" TEXT,
ADD COLUMN     "name_ar" TEXT;

-- AlterTable
ALTER TABLE "menu_sections" ADD COLUMN     "name_ar" TEXT;

-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN     "arabic_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "description_ar" TEXT,
ADD COLUMN     "name_ar" TEXT;

-- RenameIndex
ALTER INDEX "promotions_source_moment_idx" RENAME TO "promotions_source_moment_id_source_moment_year_idx";


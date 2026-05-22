-- CreateTable
CREATE TABLE "analytics_imports" (
  "id" TEXT NOT NULL,
  "restaurant_id" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'imported',
  "original_file_name" TEXT,
  "original_file_url" TEXT,
  "content_type" TEXT,
  "row_count" INTEGER NOT NULL DEFAULT 0,
  "metric_count" INTEGER NOT NULL DEFAULT 0,
  "started_on" DATE,
  "ended_on" DATE,
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "analytics_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_import_metrics" (
  "id" TEXT NOT NULL,
  "import_id" TEXT NOT NULL,
  "restaurant_id" TEXT NOT NULL,
  "metric_date" DATE NOT NULL,
  "metric_type" TEXT NOT NULL,
  "value" DECIMAL(14,2) NOT NULL,
  "unit" TEXT NOT NULL DEFAULT 'count',
  "currency" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "analytics_import_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "analytics_imports_restaurant_id_created_at_idx" ON "analytics_imports"("restaurant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_import_metrics_import_id_metric_date_metric_type_key" ON "analytics_import_metrics"("import_id", "metric_date", "metric_type");

-- CreateIndex
CREATE INDEX "analytics_import_metrics_restaurant_id_metric_date_idx" ON "analytics_import_metrics"("restaurant_id", "metric_date");

-- CreateIndex
CREATE INDEX "analytics_import_metrics_restaurant_id_metric_type_idx" ON "analytics_import_metrics"("restaurant_id", "metric_type");

-- AddForeignKey
ALTER TABLE "analytics_imports" ADD CONSTRAINT "analytics_imports_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_import_metrics" ADD CONSTRAINT "analytics_import_metrics_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "analytics_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_import_metrics" ADD CONSTRAINT "analytics_import_metrics_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

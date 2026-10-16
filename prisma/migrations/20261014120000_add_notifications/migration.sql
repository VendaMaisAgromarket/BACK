-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('NEW_ORDER', 'ORDER_ACCEPTED', 'ORDER_REJECTED', 'DOWN_PAYMENT_RECEIVED', 'WEIGHT_REGISTERED', 'FINAL_PAYMENT_RECEIVED', 'ORDER_STATUS_CHANGED', 'PRODUCT_HARVEST_REMINDER');

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "sale_id" TEXT,
    "product_id" TEXT,
    "data" JSONB,
    "dedupe_key" TEXT,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Notification_dedupe_key_key" ON "Notification"("dedupe_key");

-- CreateIndex
CREATE INDEX "Notification_user_id_created_at_idx" ON "Notification"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "Notification_user_id_read_at_idx" ON "Notification"("user_id", "read_at");

-- CreateIndex
CREATE INDEX "Notification_sale_id_idx" ON "Notification"("sale_id");

-- CreateIndex
CREATE INDEX "Notification_product_id_idx" ON "Notification"("product_id");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "SaleData"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;


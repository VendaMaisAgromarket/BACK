-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "asaas_checkout_id" TEXT,
ADD COLUMN     "asaas_customer_id" TEXT,
ADD COLUMN     "asaas_payment_id" TEXT,
ADD COLUMN     "billingType" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "asaas_customer_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Payment_asaas_payment_id_key" ON "Payment"("asaas_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "User_asaas_customer_id_key" ON "User"("asaas_customer_id");

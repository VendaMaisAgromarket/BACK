-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "email_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "email_sent_at" TIMESTAMP(3);

-- Notificações anteriores a esta migration não devem disparar e-mail retroativo.
UPDATE "Notification" SET "email_sent_at" = "created_at";

-- CreateIndex
CREATE INDEX "Notification_email_sent_at_created_at_idx" ON "Notification"("email_sent_at", "created_at");

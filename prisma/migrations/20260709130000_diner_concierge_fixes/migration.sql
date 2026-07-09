ALTER TABLE "whatsapp_messages" ADD COLUMN "idempotency_key" TEXT;

CREATE UNIQUE INDEX "whatsapp_messages_idempotency_key_key" ON "whatsapp_messages"("idempotency_key");

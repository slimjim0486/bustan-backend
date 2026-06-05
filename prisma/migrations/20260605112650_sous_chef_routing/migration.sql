-- AlterTable
ALTER TABLE "owner_chat_messages" ADD COLUMN     "model" TEXT;

-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN     "sous_chef_routing_enabled" BOOLEAN NOT NULL DEFAULT false;

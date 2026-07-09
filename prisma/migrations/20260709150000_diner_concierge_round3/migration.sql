-- Round 3: monotonic message ordering + batch anchor for the diner concierge.
-- createdAt cannot order a conversation (webhook timestamps are second-truncated,
-- outbound rows use DB now()), so the answered-watermark moves to an insertion
-- sequence. Existing rows are backfilled in created_at order (id tiebreak) so
-- historical conversations still sort correctly.
ALTER TABLE "whatsapp_messages" ADD COLUMN "seq" BIGINT;

WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn
  FROM "whatsapp_messages"
)
UPDATE "whatsapp_messages" m
SET "seq" = ordered.rn
FROM ordered
WHERE m.id = ordered.id;

CREATE SEQUENCE "whatsapp_messages_seq_seq" OWNED BY "whatsapp_messages"."seq";
SELECT setval(
  'whatsapp_messages_seq_seq',
  COALESCE((SELECT MAX("seq") FROM "whatsapp_messages"), 0) + 1,
  false
);
ALTER TABLE "whatsapp_messages" ALTER COLUMN "seq" SET DEFAULT nextval('whatsapp_messages_seq_seq');
ALTER TABLE "whatsapp_messages" ALTER COLUMN "seq" SET NOT NULL;
CREATE UNIQUE INDEX "whatsapp_messages_seq_key" ON "whatsapp_messages"("seq");

-- Bot claim rows only: highest diner-message seq this reply answers.
ALTER TABLE "whatsapp_messages" ADD COLUMN "answers_up_to_seq" BIGINT;

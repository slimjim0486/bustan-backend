import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveUnansweredBatch } from "@/queue/diner-concierge";

function msg(input: {
  id: string;
  direction: "inbound" | "outbound";
  source: string;
  createdAt: string;
  body?: string | null;
  type?: string;
}) {
  return {
    type: "text",
    body: input.body ?? "hello",
    ...input,
    createdAt: new Date(input.createdAt),
  };
}

test("deriveUnansweredBatch returns diner messages newer than last bot or owner answer", () => {
  const batch = deriveUnansweredBatch([
    msg({ id: "m5", direction: "inbound", source: "diner", createdAt: "2026-07-09T10:00:04Z" }),
    msg({ id: "m4", direction: "inbound", source: "diner", createdAt: "2026-07-09T10:00:03Z" }),
    msg({ id: "m3", direction: "outbound", source: "owner", createdAt: "2026-07-09T10:00:02Z" }),
    msg({ id: "m2", direction: "inbound", source: "diner", createdAt: "2026-07-09T10:00:01Z" }),
    msg({ id: "m1", direction: "outbound", source: "bot", createdAt: "2026-07-09T10:00:00Z" }),
  ]);

  assert.deepEqual(
    batch.map((message) => message.id),
    ["m4", "m5"]
  );
});

test("deriveUnansweredBatch treats owner replies as answering the batch", () => {
  const batch = deriveUnansweredBatch([
    msg({ id: "m3", direction: "outbound", source: "owner", createdAt: "2026-07-09T10:00:02Z" }),
    msg({ id: "m2", direction: "inbound", source: "diner", createdAt: "2026-07-09T10:00:01Z" }),
    msg({ id: "m1", direction: "outbound", source: "bot", createdAt: "2026-07-09T10:00:00Z" }),
  ]);

  assert.deepEqual(batch, []);
});

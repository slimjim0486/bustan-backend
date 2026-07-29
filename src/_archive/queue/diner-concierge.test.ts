import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveUnansweredBatch,
  messageBodyForConcierge,
  type StoredConciergeMessage,
} from "@/queue/diner-concierge";

let autoSeq = 0n;

function msg(input: {
  id: string;
  direction: "inbound" | "outbound";
  source: string;
  seq?: bigint;
  status?: string;
  body?: string | null;
  type?: string;
  answersUpToSeq?: bigint | null;
}): StoredConciergeMessage {
  autoSeq += 1n;
  return {
    type: "text",
    status: "received",
    body: "hello",
    answersUpToSeq: null,
    seq: input.seq ?? autoSeq,
    createdAt: new Date("2026-07-09T10:00:00Z"),
    ...input,
  };
}

test("deriveUnansweredBatch returns diner messages above the answered watermark", () => {
  const batch = deriveUnansweredBatch([
    msg({ id: "m1", direction: "outbound", source: "bot", seq: 1n, status: "sent" }),
    msg({ id: "m2", direction: "inbound", source: "diner", seq: 2n }),
    msg({ id: "m3", direction: "outbound", source: "owner", seq: 3n }),
    msg({ id: "m4", direction: "inbound", source: "diner", seq: 4n }),
    msg({ id: "m5", direction: "inbound", source: "diner", seq: 5n }),
  ]);

  assert.deepEqual(
    batch.map((message) => message.id),
    ["m4", "m5"]
  );
});

test("deriveUnansweredBatch treats owner replies as answering everything before them", () => {
  const batch = deriveUnansweredBatch([
    msg({ id: "m1", direction: "outbound", source: "bot", seq: 1n, status: "sent" }),
    msg({ id: "m2", direction: "inbound", source: "diner", seq: 2n }),
    msg({ id: "m3", direction: "outbound", source: "owner", seq: 3n }),
  ]);

  assert.deepEqual(batch, []);
});

test("a message arriving while the bot composes stays unanswered (anchor beats createdAt)", () => {
  // m6 (seq 6) was persisted while the bot composed its reply to m5; the
  // claim row (seq 7) anchors at answersUpToSeq=5, NOT its own seq, so m6
  // remains owed even though the claim row is newer.
  const batch = deriveUnansweredBatch([
    msg({ id: "m5", direction: "inbound", source: "diner", seq: 5n }),
    msg({ id: "m6", direction: "inbound", source: "diner", seq: 6n }),
    msg({
      id: "claim",
      direction: "outbound",
      source: "bot",
      seq: 7n,
      status: "sent",
      answersUpToSeq: 5n,
    }),
  ]);

  assert.deepEqual(
    batch.map((message) => message.id),
    ["m6"]
  );
});

test("failed (orphaned) claims stop anchoring so their batch reopens", () => {
  const batch = deriveUnansweredBatch([
    msg({ id: "m5", direction: "inbound", source: "diner", seq: 5n }),
    msg({
      id: "orphan",
      direction: "outbound",
      source: "bot",
      seq: 6n,
      status: "failed",
      answersUpToSeq: 5n,
    }),
  ]);

  assert.deepEqual(
    batch.map((message) => message.id),
    ["m5"]
  );
});

test("failed owner sends do not answer diner messages", () => {
  const batch = deriveUnansweredBatch([
    msg({ id: "m1", direction: "inbound", source: "diner", seq: 1n }),
    msg({ id: "owner-fail", direction: "outbound", source: "owner", seq: 2n, status: "failed" }),
  ]);

  assert.deepEqual(
    batch.map((message) => message.id),
    ["m1"]
  );
});

test("legacy bot rows without answersUpToSeq anchor at their own seq", () => {
  const batch = deriveUnansweredBatch([
    msg({ id: "m1", direction: "inbound", source: "diner", seq: 1n }),
    msg({ id: "old-bot", direction: "outbound", source: "bot", seq: 2n, status: "sent" }),
  ]);

  assert.deepEqual(batch, []);
});

test("system outbound rows (order templates) do not answer diner questions", () => {
  const batch = deriveUnansweredBatch([
    msg({ id: "m1", direction: "inbound", source: "diner", seq: 1n }),
    msg({ id: "tpl", direction: "outbound", source: "system", seq: 2n }),
  ]);

  assert.deepEqual(
    batch.map((message) => message.id),
    ["m1"]
  );
});

test("messageBodyForConcierge rejects synthetic placeholder bodies regardless of stored type", () => {
  assert.equal(messageBodyForConcierge({ body: "[location message]" }), null);
  assert.equal(messageBodyForConcierge({ body: "[image message]" }), null);
  assert.equal(messageBodyForConcierge({ body: "[message]" }), null);
  assert.equal(messageBodyForConcierge({ body: "  " }), null);
  assert.equal(messageBodyForConcierge({ body: null }), null);
  assert.equal(messageBodyForConcierge({ body: "is the burger halal?" }), "is the burger halal?");
  // A media caption is real diner text.
  assert.equal(messageBodyForConcierge({ body: "here is my location pin, deliver here" }), "here is my location pin, deliver here");
});

import assert from "node:assert/strict";
import test from "node:test";
import { estimateAiUsageCost } from "@/lib/ai-usage";

test("owner_chat is priced at haiku rates", () => {
  // 1M in + 1M out: haiku = 1.0 + 5.0 USD
  assert.ok(Math.abs(estimateAiUsageCost("owner_chat", 1_000_000, 1_000_000) - 6.0) < 1e-9);
});

test("owner_chat_planner is priced at sonnet rates", () => {
  // 1M in + 1M out: sonnet = 3 + 15 USD
  assert.ok(
    Math.abs(estimateAiUsageCost("owner_chat_planner", 1_000_000, 1_000_000) - 18) < 1e-9
  );
});

test("cache tokens are priced at 1.25x write / 0.1x read of the input rate", () => {
  // haiku input = $1/MTok → 1M cache-write = 1.25, 1M cache-read = 0.10
  const cost = estimateAiUsageCost("owner_chat", 0, 0, 0, {
    cacheWriteTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
  });
  assert.ok(Math.abs(cost - 1.35) < 1e-9);
});

test("cache pricing defaults to zero when omitted", () => {
  assert.ok(Math.abs(estimateAiUsageCost("owner_chat", 1_000_000, 0) - 1.0) < 1e-9);
});

import assert from "node:assert/strict";
import test from "node:test";

test("arabicMenuEnabled is false on starter, true on pro and portfolio", async () => {
  const { getPlanEntitlements } = await import("./entitlements.js");

  assert.equal(getPlanEntitlements("starter").arabicMenuEnabled, false);
  assert.equal(getPlanEntitlements("pro").arabicMenuEnabled, true);
  assert.equal(getPlanEntitlements("portfolio").arabicMenuEnabled, true);
});

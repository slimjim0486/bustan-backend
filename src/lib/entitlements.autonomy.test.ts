import assert from "node:assert/strict";
import test from "node:test";

test("existing plans are draft_only with standing instructions off (no behavior change)", async () => {
  const { getPlanEntitlements } = await import("./entitlements.js");

  for (const plan of ["starter", "pro", "portfolio"] as const) {
    assert.equal(getPlanEntitlements(plan).agentAutonomy, "draft_only");
    assert.equal(getPlanEntitlements(plan).standingInstructionsEnabled, false);
  }
});

import assert from "node:assert/strict";
import test from "node:test";

test("starter/pro remain draft_only with standing instructions off (no behavior change)", async () => {
  const { getPlanEntitlements } = await import("./entitlements.js");

  // Note: portfolio was upgraded to Full-time-level autonomy in a later task
  // (Head-of-group entitlements upgrade) and is intentionally excluded here.
  for (const plan of ["starter", "pro"] as const) {
    assert.equal(getPlanEntitlements(plan).agentAutonomy, "draft_only");
    assert.equal(getPlanEntitlements(plan).standingInstructionsEnabled, false);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { getToolTier, assertToolAllowed, TOOL_TIERS } from "@/services/agent/autonomy-tiers";

test("read/analysis tools are tier 0", () => {
  assert.equal(getToolTier("run_menu_analysis"), 0);
  assert.equal(getToolTier("get_bustan_info"), 0);
});

test("owner-asked availability toggle is tier 1 (act + notify)", () => {
  assert.equal(getToolTier("toggle_availability"), 1);
});

test("customer-facing sends and price/publish are tier 2 (propose + approve)", () => {
  assert.equal(getToolTier("send_whatsapp_campaign"), 2);
  assert.equal(getToolTier("create_promotion"), 2);
  assert.equal(getToolTier("update_promotion"), 2); // price edits require approval
  assert.equal(getToolTier("create_ad_campaign"), 2);
  assert.equal(getToolTier("publish_menu"), 2);
});

test("every Phase 2 write tool is at least tier 2", () => {
  for (const name of ["update_promotion", "send_whatsapp_campaign", "create_ad_campaign", "generate_dish_images", "delete_menu_items"]) {
    assert.ok(getToolTier(name) >= 1, `${name} must be tiered`);
  }
});

test("destructive delete is tier 2, refusable ops are tier 3", () => {
  assert.equal(getToolTier("delete_menu_items"), 2);
  assert.equal(getToolTier("delete_restaurant"), 3);
});

test("assertToolAllowed throws for tier 3", () => {
  assert.throws(() => assertToolAllowed("delete_restaurant"), /not permitted/i);
});

test("assertToolAllowed throws for unknown tools (fail closed)", () => {
  assert.throws(() => assertToolAllowed("some_unregistered_tool"), /unknown/i);
});

test("every registered tool name resolves to a valid tier", () => {
  for (const [name, tier] of Object.entries(TOOL_TIERS)) {
    assert.ok([0, 1, 2, 3].includes(tier), `${name} has invalid tier ${tier}`);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { OWNER_TOOLS, PHASE2_TOOL_NAMES, getOwnerTools } from "@/services/owner-chat-tools";

test("phase-2 tools are excluded unless routing is enabled", () => {
  const base = getOwnerTools(false);
  const full = getOwnerTools(true);
  assert.equal(full.length, OWNER_TOOLS.length);
  assert.equal(base.length, OWNER_TOOLS.length - PHASE2_TOOL_NAMES.size);
  for (const tool of base) {
    assert.ok(!PHASE2_TOOL_NAMES.has(tool.name));
  }
});

test("getOwnerTools returns stable references (prompt-cache safety)", () => {
  assert.equal(getOwnerTools(true), getOwnerTools(true));
  assert.equal(getOwnerTools(false), getOwnerTools(false));
});

test("booking tools are registered alongside the snapshot tool", () => {
  const names = getOwnerTools(false).map((tool) => tool.name);
  assert.deepEqual(names, [
    "get_business_snapshot",
    "get_today_bookings",
    "get_week_new_customers",
    "get_no_show_rate",
    "get_top_services",
    "get_quiet_slots",
  ]);
});

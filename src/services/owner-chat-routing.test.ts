import assert from "node:assert/strict";
import test from "node:test";
import {
  BREADTH_ESCALATION_THRESHOLD,
  ESCALATE_TOOL,
  HAIKU_CAPS,
  PLANNER_CAPS,
  STICKINESS_WINDOW_MS,
  WRITE_TOOL_NAMES,
  findEscalationTrigger,
  shouldStartOnPlanner,
} from "@/services/owner-chat-routing";

test("write tool in batch triggers write_tool escalation", () => {
  assert.equal(findEscalationTrigger(["get_analytics", "create_promotion"], 0), "write_tool");
});

test("escalate_to_planner triggers handoff and outranks write_tool", () => {
  assert.equal(findEscalationTrigger([ESCALATE_TOOL, "create_promotion"], 0), "handoff");
});

test("third accumulated tool call triggers breadth escalation", () => {
  assert.equal(findEscalationTrigger(["get_analytics"], 2), "breadth");
  assert.equal(findEscalationTrigger(["get_analytics", "get_menu_overview", "get_crm_summary"], 0), "breadth");
});

test("one or two read calls do not escalate", () => {
  assert.equal(findEscalationTrigger(["get_analytics"], 0), null);
  assert.equal(findEscalationTrigger(["get_menu_overview"], 1), null);
});

test("all 14 write tools are registered", () => {
  assert.equal(WRITE_TOOL_NAMES.size, 14);
  assert.ok(WRITE_TOOL_NAMES.has("create_promotion"));
  assert.ok(WRITE_TOOL_NAMES.has("update_promotion"));
  assert.ok(WRITE_TOOL_NAMES.has("plan_marketing_week"));
  assert.ok(!WRITE_TOOL_NAMES.has("get_analytics"));
});

test("stickiness: recent sonnet turn starts on planner", () => {
  const now = new Date("2026-06-05T10:00:00Z");
  const recent = new Date(now.getTime() - (STICKINESS_WINDOW_MS - 1_000));
  assert.equal(shouldStartOnPlanner({ model: "claude-sonnet-4-6", createdAt: recent }, now), true);
});

test("stickiness: stale or haiku or missing turns start on default", () => {
  const now = new Date("2026-06-05T10:00:00Z");
  const stale = new Date(now.getTime() - (STICKINESS_WINDOW_MS + 1_000));
  assert.equal(shouldStartOnPlanner({ model: "claude-sonnet-4-6", createdAt: stale }, now), false);
  assert.equal(shouldStartOnPlanner({ model: "claude-haiku-4-5-20251001", createdAt: now }, now), false);
  assert.equal(shouldStartOnPlanner({ model: null, createdAt: now }, now), false);
  assert.equal(shouldStartOnPlanner(null, now), false);
});

test("caps match the approved spec", () => {
  assert.deepEqual(HAIKU_CAPS, { maxIterations: 8, maxTokens: 1024 });
  assert.deepEqual(PLANNER_CAPS, { maxIterations: 24, maxTokens: 4096 });
  assert.equal(BREADTH_ESCALATION_THRESHOLD, 3);
});

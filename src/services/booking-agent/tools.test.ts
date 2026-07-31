import assert from "node:assert/strict";
import test from "node:test";
import { BOOKING_AGENT_TOOLS } from "@/services/booking-agent/tools";

function toolNamed(name: string) {
  const tool = BOOKING_AGENT_TOOLS.find((t) => t.name === name);
  assert.ok(tool, `missing tool: ${name}`);
  return tool!;
}

function requiredOf(name: string): string[] {
  const schema = toolNamed(name).input_schema as { required?: string[] };
  return schema.required ?? [];
}

test("the booking agent exposes exactly five tools, in order", () => {
  assert.deepEqual(
    BOOKING_AGENT_TOOLS.map((tool) => tool.name),
    [
      "get_services",
      "get_policies",
      "check_availability",
      "create_booking",
      "escalate_to_owner",
    ]
  );
});

test("BOOKING_AGENT_TOOLS is a stable module-level reference (prompt-cache safety)", async () => {
  const again = (await import("./tools.js")).BOOKING_AGENT_TOOLS;
  assert.equal(again, BOOKING_AGENT_TOOLS);
});

test("create_booking requires the service and the exact slot", () => {
  const required = requiredOf("create_booking");
  assert.ok(required.includes("serviceId"));
  assert.ok(required.includes("slotAtIso"));
});

test("check_availability requires a serviceId", () => {
  assert.ok(requiredOf("check_availability").includes("serviceId"));
});

test("escalate_to_owner requires a reason", () => {
  assert.ok(requiredOf("escalate_to_owner").includes("reason"));
});

test("every tool declares an object schema and a description", () => {
  for (const tool of BOOKING_AGENT_TOOLS) {
    assert.equal(
      (tool.input_schema as { type?: string }).type,
      "object",
      `${tool.name} schema is not an object`
    );
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} description`);
  }
});

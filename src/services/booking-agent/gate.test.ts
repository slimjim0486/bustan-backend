import assert from "node:assert/strict";
import test from "node:test";
import { shouldDispatchBookingAgent } from "./gate.js";

const now = new Date("2026-07-31T10:00:00.000Z");

/** A row that satisfies every gate condition — the one true row in the table. */
function baseline(): Parameters<typeof shouldDispatchBookingAgent>[0] {
  return {
    businessType: "SALON",
    agentAutonomyOptIn: true,
    botDisabled: false,
    botPausedUntil: null,
    messageType: "text",
    duplicate: false,
    consentCommand: null,
    now,
  };
}

test("shouldDispatchBookingAgent: table test, one row per condition flipping false", () => {
  const cases: Array<{ label: string; overrides: Partial<ReturnType<typeof baseline>>; expected: boolean }> = [
    { label: "all conditions satisfied (SALON)", overrides: {}, expected: true },
    { label: "all conditions satisfied (HOME_SERVICES)", overrides: { businessType: "HOME_SERVICES" }, expected: true },
    { label: "wrong businessType (RESTAURANT)", overrides: { businessType: "RESTAURANT" }, expected: false },
    { label: "autonomy opt-in off", overrides: { agentAutonomyOptIn: false }, expected: false },
    { label: "bot disabled", overrides: { botDisabled: true }, expected: false },
    {
      label: "bot paused in the future",
      overrides: { botPausedUntil: new Date("2026-07-31T11:00:00.000Z") },
      expected: false,
    },
    {
      label: "bot pause already expired (in the past) — should NOT block",
      overrides: { botPausedUntil: new Date("2026-07-31T09:00:00.000Z") },
      expected: true,
    },
    { label: "non-text message type", overrides: { messageType: "image" }, expected: false },
    { label: "duplicate inbound", overrides: { duplicate: true }, expected: false },
    { label: "consent command present", overrides: { consentCommand: "opt_out" }, expected: false },
  ];

  for (const { label, overrides, expected } of cases) {
    const input = { ...baseline(), ...overrides };
    assert.equal(shouldDispatchBookingAgent(input), expected, label);
  }
});

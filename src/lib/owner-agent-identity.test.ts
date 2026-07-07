import assert from "node:assert/strict";
import test from "node:test";
import { OWNER_AGENT } from "./owner-agent-identity";
import { BUSTAN_KB } from "./bustan-kb";

test("owner-agent deterministic copy identifies as Bustan", () => {
  const copy = [
    OWNER_AGENT.name,
    OWNER_AGENT.role,
    OWNER_AGENT.injectionRefusal,
    OWNER_AGENT.notConfigured,
    OWNER_AGENT.unavailable,
  ].join("\n");

  assert.match(copy, /\bBustan\b/);
  assert.doesNotMatch(copy, /Sous Chef|Owner Chat|Coworker/i);
});

test("owner-facing KB describes the agent as Bustan", () => {
  const ownerKb = [BUSTAN_KB.ai_features.summary, BUSTAN_KB.portfolio.summary].join("\n");

  assert.match(ownerKb, /\bBustan\b/);
  assert.doesNotMatch(ownerKb, /Sous Chef|Owner Chat|Coworker/i);
});

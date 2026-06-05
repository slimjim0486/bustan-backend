import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SOUS_CHEF_MODEL,
  DEFAULT_SOUS_CHEF_PLANNER_MODEL,
  getSousChefModelCandidates,
  getSousChefPlannerCandidates,
  withPromptCaching,
} from "@/services/anthropic-models";

test("planner candidates lead with the planner model", () => {
  const candidates = getSousChefPlannerCandidates();
  assert.equal(candidates[0], DEFAULT_SOUS_CHEF_PLANNER_MODEL);
});

test("planner candidates fall back through the default-tier chain", () => {
  const candidates = getSousChefPlannerCandidates();
  for (const model of getSousChefModelCandidates()) {
    assert.ok(candidates.includes(model), `missing fallback ${model}`);
  }
  assert.ok(candidates.includes(DEFAULT_SOUS_CHEF_MODEL));
});

test("planner candidates contain no duplicates", () => {
  const candidates = getSousChefPlannerCandidates();
  assert.equal(new Set(candidates).size, candidates.length);
});

test("withPromptCaching marks only the last tool definition", () => {
  const params = {
    max_tokens: 100,
    system: "prompt",
    tools: [
      { name: "a", input_schema: { type: "object" as const } },
      { name: "b", input_schema: { type: "object" as const } },
    ],
    messages: [],
  };
  const out = withPromptCaching(params as never) as typeof params & {
    tools: Array<{ cache_control?: { type: string } }>;
  };
  assert.equal(out.tools[0].cache_control, undefined);
  assert.deepEqual(out.tools[1].cache_control, { type: "ephemeral" });
});

test("withPromptCaching converts string system to a cached block", () => {
  const params = {
    max_tokens: 100,
    system: "prompt",
    tools: [{ name: "a", input_schema: { type: "object" as const } }],
    messages: [],
  };
  const out = withPromptCaching(params as never) as {
    system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
  };
  assert.equal(Array.isArray(out.system), true);
  assert.equal(out.system[0].text, "prompt");
  assert.deepEqual(out.system[0].cache_control, { type: "ephemeral" });
});

test("withPromptCaching is a no-op without tools", () => {
  const params = { max_tokens: 100, system: "prompt", messages: [] };
  assert.equal(withPromptCaching(params as never), params);
});

test("withPromptCaching does not mutate the input params", () => {
  const tools = [{ name: "a", input_schema: { type: "object" as const } }];
  const params = { max_tokens: 100, system: "prompt", tools, messages: [] };
  withPromptCaching(params as never);
  assert.equal((tools[0] as { cache_control?: unknown }).cache_control, undefined);
  assert.equal(typeof params.system, "string");
});

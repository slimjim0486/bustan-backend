import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SOUS_CHEF_MODEL,
  DEFAULT_SOUS_CHEF_PLANNER_MODEL,
  getSousChefModelCandidates,
  getSousChefPlannerCandidates,
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

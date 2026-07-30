import assert from "node:assert/strict";
import test from "node:test";
import { buildResolutionPayload, parseResolutionPayload } from "./booking-resolution";

test("resolution payload round-trips and rejects junk", () => {
  const p = buildResolutionPayload("ckxyz12345678901234567", "NO_SHOW");
  assert.deepEqual(parseResolutionPayload(p), { bookingId: "ckxyz12345678901234567", status: "NO_SHOW" });
  assert.equal(parseResolutionPayload("bkres:abc"), null);
  assert.equal(parseResolutionPayload("draft_approve:xyz"), null);
  assert.equal(parseResolutionPayload("bkres:id:MAYBE"), null);
});

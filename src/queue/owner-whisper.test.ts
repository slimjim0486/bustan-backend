import assert from "node:assert/strict";
import test from "node:test";
import { isDubaiMonday } from "@/queue/owner-whisper";

test("isDubaiMonday true for a Monday Dubai-morning UTC instant", () => {
  // 2026-07-06 03:00 UTC = 07:00 GST Monday.
  assert.equal(isDubaiMonday(Date.parse("2026-07-06T03:00:00Z")), true);
});

test("isDubaiMonday false on a Tuesday", () => {
  assert.equal(isDubaiMonday(Date.parse("2026-07-07T03:00:00Z")), false);
});

test("isDubaiMonday accounts for the +4 offset near midnight UTC", () => {
  // 2026-07-05 21:00 UTC = 2026-07-06 01:00 GST → already Monday in Dubai.
  assert.equal(isDubaiMonday(Date.parse("2026-07-05T21:00:00Z")), true);
});

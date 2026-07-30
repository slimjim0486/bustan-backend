import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://user:pass@localhost:5432/bustan_test";
process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
process.env.IP_HASH_PEPPER = "test-only-ip-hash-pepper-1234";

test("decideConfirmTransition: table test over all 7 booking statuses", async () => {
  const { decideConfirmTransition } = await import("./booking-confirm.js");

  const cases: Array<[string, "confirm" | "already_done" | "reject"]> = [
    ["INQUIRY", "confirm"],
    ["DEPOSIT_SENT", "confirm"],
    ["EXPIRED", "confirm"],
    ["CONFIRMED", "already_done"],
    ["COMPLETED", "already_done"],
    ["NO_SHOW", "already_done"],
    ["CANCELLED", "reject"],
  ];

  for (const [status, expected] of cases) {
    assert.equal(decideConfirmTransition(status), expected, `status=${status} should be ${expected}`);
  }
});

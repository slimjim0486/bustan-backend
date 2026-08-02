import assert from "node:assert/strict";
import test from "node:test";
import { bookingTransactionLockKeys } from "./booking-concurrency";

test("booking transaction locks are tenant-scoped, stable, and globally ordered", () => {
  const input = {
    restaurantId: "tenant_a",
    customerId: "customer_a",
    gstDayStart: new Date("2026-08-02T20:00:00.000Z"),
  };
  const first = bookingTransactionLockKeys(input);
  const second = bookingTransactionLockKeys(input);
  assert.deepEqual(first, second);
  assert.deepEqual(first, [...first].sort());
  assert.equal(first.length, 2);
  assert(first.every((key) => key.includes("tenant_a")));
});

test("different tenants, customers, or booking days do not share both locks", () => {
  const base = {
    restaurantId: "tenant_a",
    customerId: "customer_a",
    gstDayStart: new Date("2026-08-02T20:00:00.000Z"),
  };
  const keys = bookingTransactionLockKeys(base);
  assert.notDeepEqual(keys, bookingTransactionLockKeys({ ...base, restaurantId: "tenant_b" }));
  assert.notDeepEqual(keys, bookingTransactionLockKeys({ ...base, customerId: "customer_b" }));
  assert.notDeepEqual(
    keys,
    bookingTransactionLockKeys({ ...base, gstDayStart: new Date("2026-08-03T20:00:00.000Z") })
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeCustomerImportRows } from "./customer-import";

test("customer import deduplicates phones and lets explicit opt-out win regardless of row order", () => {
  const base = [
    { name: "Fatima", phone: "+971501234567", consent: true, normalizedPhone: "+971501234567", index: 0 },
    { name: "Fatima A", phone: "0501234567", consent: false, normalizedPhone: "+971501234567", index: 1 },
  ];
  assert.deepEqual(canonicalizeCustomerImportRows(base), [{ ...base[1], consent: false, index: 0 }]);
  assert.equal(canonicalizeCustomerImportRows([...base].reverse())[0]?.consent, false);
});

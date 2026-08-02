import assert from "node:assert/strict";
import test from "node:test";
import { agentReadinessFailures } from "./onboarding-readiness";

const ready = {
  businessType: "SALON",
  whatsappStatus: "connected",
  serviceCount: 2,
  operatingHours: { monday: { open: "09:00", close: "18:00" } },
  bookingPolicies: { noShowPolicy: "Deposits are retained for no-shows." },
  feeAed: 50,
  depositAed: 50,
  sandboxTestCount: 3,
};

test("agent go-live readiness fails closed on every required prerequisite", () => {
  assert.deepEqual(agentReadinessFailures(ready), []);
  assert(agentReadinessFailures({ ...ready, whatsappStatus: null }).includes("whatsapp_not_connected"));
  assert(agentReadinessFailures({ ...ready, serviceCount: 0 }).includes("no_active_services"));
  assert(agentReadinessFailures({ ...ready, sandboxTestCount: 2 }).includes("sandbox_tests_incomplete"));
  assert(agentReadinessFailures({ ...ready, depositAed: 40 }).includes("fee_or_deposit_invalid"));
});

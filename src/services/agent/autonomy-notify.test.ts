import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://user:pass@localhost:5432/bustan_test";
process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
process.env.IP_HASH_PEPPER = "test-only-ip-hash-pepper-1234";

test("shouldPingOwner: pings on high-impact, silent on reversible", async () => {
  const { shouldPingOwner } = await import("./autonomy-notify.js");
  assert.equal(shouldPingOwner(true), true);
  assert.equal(shouldPingOwner(false), false);
});

test("notifyOwnerAutoAction resolves without throwing (no-op v1)", async () => {
  const { notifyOwnerAutoAction } = await import("./autonomy-notify.js");
  await notifyOwnerAutoAction({ restaurantId: "r1", toolName: "send_whatsapp_campaign", draftId: "d1", highImpact: true });
  await notifyOwnerAutoAction({ restaurantId: "r1", toolName: "update_menu_item", draftId: "d2", highImpact: false });
});

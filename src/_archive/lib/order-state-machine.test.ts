import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://user:pass@localhost:5432/bustan_test";
process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
process.env.IP_HASH_PEPPER = "test-only-ip-hash-pepper-1234";

test("detectOrderAction returns null for irrelevant messages", async () => {
  const { detectOrderAction } = await import("./order-state-machine.js");
  assert.equal(detectOrderAction({ type: "text", text: { body: "hello world" } }), null);
  assert.equal(detectOrderAction({ type: "image" }), null);
  assert.equal(detectOrderAction({ type: "text", text: { body: "" } }), null);
});

test("detectOrderAction recognises bare 'accept' / 'reject' text", async () => {
  const { detectOrderAction } = await import("./order-state-machine.js");
  assert.deepEqual(detectOrderAction({ type: "text", text: { body: "Accept" } }), {
    action: { type: "accept" },
    orderNumber: null,
  });
  assert.deepEqual(detectOrderAction({ type: "text", text: { body: "REJECT" } }), {
    action: { type: "reject" },
    orderNumber: null,
  });
});

test("detectOrderAction extracts BST-XXXXX from text in any position", async () => {
  const { detectOrderAction } = await import("./order-state-machine.js");
  const fromLeading = detectOrderAction({ type: "text", text: { body: "BST-7K3X9ABC accept" } });
  const fromTrailing = detectOrderAction({ type: "text", text: { body: "accept BST-7K3X9ABC" } });
  assert.deepEqual(fromLeading, { action: { type: "accept" }, orderNumber: "BST-7K3X9ABC" });
  assert.deepEqual(fromTrailing, { action: { type: "accept" }, orderNumber: "BST-7K3X9ABC" });
});

test("detectOrderAction recognises numeric prep-time replies", async () => {
  const { detectOrderAction } = await import("./order-state-machine.js");
  assert.deepEqual(detectOrderAction({ type: "text", text: { body: "30" } }), {
    action: { type: "accept", prepMinutes: 30 },
    orderNumber: null,
  });
  assert.deepEqual(detectOrderAction({ type: "text", text: { body: "45 BST-7K3X9ABC" } }), {
    action: { type: "accept", prepMinutes: 45 },
    orderNumber: "BST-7K3X9ABC",
  });
});

test("detectOrderAction rejects out-of-range numeric replies", async () => {
  const { detectOrderAction } = await import("./order-state-machine.js");
  assert.equal(detectOrderAction({ type: "text", text: { body: "999" } }), null);
  assert.equal(detectOrderAction({ type: "text", text: { body: "0" } }), null);
});

test("detectOrderAction recognises button-reply payloads", async () => {
  const { detectOrderAction } = await import("./order-state-machine.js");
  const accept = detectOrderAction({ button: { text: "Accept" } });
  assert.deepEqual(accept, { action: { type: "accept" }, orderNumber: null });
  const need30 = detectOrderAction({ button: { text: "Need 30 min" } });
  assert.deepEqual(need30, { action: { type: "accept", prepMinutes: 30 }, orderNumber: null });
  const interactive = detectOrderAction({
    interactive: { button_reply: { title: "Reject", id: "BST-AAAAAAAA" } },
  });
  assert.deepEqual(interactive, {
    action: { type: "reject" },
    orderNumber: "BST-AAAAAAAA",
  });
});

test("detectOrderAction ignores invalid order-number alphabets (no 0/1/I/L/O/U)", async () => {
  const { detectOrderAction } = await import("./order-state-machine.js");
  // Note: parser regex restricts to Crockford alphabet — `0` and `1` won't
  // match, so the orderNumber field stays null even though the action does
  // get detected.
  const detected = detectOrderAction({
    type: "text",
    text: { body: "accept BST-0000IIII" },
  });
  assert.equal(detected?.orderNumber, null);
});

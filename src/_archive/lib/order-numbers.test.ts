import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://user:pass@localhost:5432/bustan_test";
process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
process.env.IP_HASH_PEPPER = "test-only-ip-hash-pepper-1234";

test("generateOrderNumber produces 8-char body in Crockford alphabet by default", async () => {
  const { generateOrderNumber } = await import("./order-numbers.js");
  for (let i = 0; i < 100; i++) {
    const n = generateOrderNumber();
    assert.match(n, /^BST-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
  }
});

test("generateOrderNumber is unique across 10K samples", async () => {
  const { generateOrderNumber } = await import("./order-numbers.js");
  const seen = new Set<string>();
  for (let i = 0; i < 10_000; i++) {
    seen.add(generateOrderNumber());
  }
  // 10K samples / 30^8 space = vanishingly small collision probability.
  // Allow up to 2 collisions to keep the test non-flaky.
  assert.ok(seen.size >= 9_998, `expected ≥9998 unique numbers, got ${seen.size}`);
});

test("deriveOrderUrlToken is deterministic for the same order number", async () => {
  const { deriveOrderUrlToken } = await import("./order-numbers.js");
  const a = deriveOrderUrlToken("BST-7K3X9ABC");
  const b = deriveOrderUrlToken("BST-7K3X9ABC");
  assert.equal(a, b);
  assert.equal(a.length, 16);
});

test("deriveOrderUrlToken differs across order numbers", async () => {
  const { deriveOrderUrlToken } = await import("./order-numbers.js");
  const a = deriveOrderUrlToken("BST-AAAAAAAA");
  const b = deriveOrderUrlToken("BST-BBBBBBBB");
  assert.notEqual(a, b);
});

test("verifyOrderUrlToken accepts the matching token and rejects others", async () => {
  const { deriveOrderUrlToken, verifyOrderUrlToken } = await import("./order-numbers.js");
  const orderNumber = "BST-7K3X9ABC";
  const token = deriveOrderUrlToken(orderNumber);
  assert.equal(verifyOrderUrlToken(orderNumber, token), true);
  assert.equal(verifyOrderUrlToken(orderNumber, "wrongtoken123456"), false);
  assert.equal(verifyOrderUrlToken(orderNumber, ""), false);
  // Tampered single character
  const tampered = token.slice(0, -1) + (token.slice(-1) === "A" ? "B" : "A");
  assert.equal(verifyOrderUrlToken(orderNumber, tampered), false);
});

test("verifyOrderUrlToken rejects tokens derived from a different order number", async () => {
  const { deriveOrderUrlToken, verifyOrderUrlToken } = await import("./order-numbers.js");
  const tokenForA = deriveOrderUrlToken("BST-AAAAAAAA");
  assert.equal(verifyOrderUrlToken("BST-BBBBBBBB", tokenForA), false);
});

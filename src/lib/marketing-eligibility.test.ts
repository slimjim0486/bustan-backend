import assert from "node:assert/strict";
import test from "node:test";

// Single source of truth for "is this customer a valid marketing-campaign
// recipient". The campaigns bug was two divergent definitions: the audience
// PREVIEW counted only the marketingOptIn boolean, while the SEND required a
// CustomerConsent paper-trail row. These tests pin one shared rule.

test("isMarketingEligible: true only with boolean + timestamp + latest consent opt_in", async () => {
  const { isMarketingEligible } = await import("./marketing-eligibility.js");
  assert.equal(
    isMarketingEligible({
      marketingOptIn: true,
      marketingOptInAt: new Date("2026-01-01T00:00:00Z"),
      latestConsentStatus: "opt_in",
    }),
    true
  );
});

test("isMarketingEligible: false when marketingOptIn boolean is false", async () => {
  const { isMarketingEligible } = await import("./marketing-eligibility.js");
  assert.equal(
    isMarketingEligible({
      marketingOptIn: false,
      marketingOptInAt: new Date("2026-01-01T00:00:00Z"),
      latestConsentStatus: "opt_in",
    }),
    false
  );
});

test("isMarketingEligible: false when no consent timestamp", async () => {
  const { isMarketingEligible } = await import("./marketing-eligibility.js");
  assert.equal(
    isMarketingEligible({
      marketingOptIn: true,
      marketingOptInAt: null,
      latestConsentStatus: "opt_in",
    }),
    false
  );
});

test("isMarketingEligible: false when latest consent is opt_out (precedence)", async () => {
  const { isMarketingEligible } = await import("./marketing-eligibility.js");
  assert.equal(
    isMarketingEligible({
      marketingOptIn: true,
      marketingOptInAt: new Date("2026-01-01T00:00:00Z"),
      latestConsentStatus: "opt_out",
    }),
    false
  );
});

test("isMarketingEligible: false when there is no consent row at all (the legacy bug)", async () => {
  const { isMarketingEligible } = await import("./marketing-eligibility.js");
  // marketingOptIn=true but zero CustomerConsent rows → the exact state that
  // made the preview say "1 qualifies" while the send found 0.
  assert.equal(
    isMarketingEligible({
      marketingOptIn: true,
      marketingOptInAt: new Date("2026-01-01T00:00:00Z"),
      latestConsentStatus: null,
    }),
    false
  );
});

test("needsLegacyConsentBackfill: true when opted-in boolean but zero consent rows", async () => {
  const { needsLegacyConsentBackfill } = await import("./marketing-eligibility.js");
  assert.equal(
    needsLegacyConsentBackfill({ marketingOptIn: true, consentCount: 0 }),
    true
  );
});

test("needsLegacyConsentBackfill: false when a consent paper-trail already exists", async () => {
  const { needsLegacyConsentBackfill } = await import("./marketing-eligibility.js");
  // Never fabricate a row over an existing trail — even an opt_out one.
  assert.equal(
    needsLegacyConsentBackfill({ marketingOptIn: true, consentCount: 1 }),
    false
  );
});

test("needsLegacyConsentBackfill: false when not opted in", async () => {
  const { needsLegacyConsentBackfill } = await import("./marketing-eligibility.js");
  assert.equal(
    needsLegacyConsentBackfill({ marketingOptIn: false, consentCount: 0 }),
    false
  );
});

test("marketingEligibleWhere: requires boolean, timestamp, and an opt_in consent row", async () => {
  const { marketingEligibleWhere } = await import("./marketing-eligibility.js");
  assert.deepEqual(marketingEligibleWhere("rest_123"), {
    restaurantId: "rest_123",
    marketingOptIn: true,
    marketingOptInAt: { not: null },
    consents: { some: { status: "opt_in" } },
  });
});

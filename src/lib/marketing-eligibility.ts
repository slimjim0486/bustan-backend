import type { Prisma } from "@prisma/client";

/**
 * Single source of truth for WhatsApp marketing-campaign eligibility.
 *
 * Background: campaigns must never send to customers without provable consent
 * (WhatsApp marketing policy + UAE PDPL). The original code expressed this rule
 * in two places that drifted apart — the audience PREVIEW counted only the
 * `marketingOptIn` boolean, while the SEND additionally required a
 * `CustomerConsent` paper-trail row. A customer opted in before the consent
 * table existed (or via import) therefore showed "1 qualifies" in the preview
 * but "0" on send. Everything eligibility-related now routes through this file.
 *
 * The rule: a customer is eligible iff
 *   1. `marketingOptIn` is true (current cached state), AND
 *   2. `marketingOptInAt` is set (a consent moment exists), AND
 *   3. their MOST RECENT consent record is `opt_in` (proof + opt-out precedence).
 */

export type ConsentStatus = "opt_in" | "opt_out";

export interface EligibilityInput {
  marketingOptIn: boolean;
  marketingOptInAt: Date | null;
  /** Status of the customer's most recent CustomerConsent row, or null if none. */
  latestConsentStatus: ConsentStatus | null;
}

export function isMarketingEligible(input: EligibilityInput): boolean {
  return (
    input.marketingOptIn === true &&
    input.marketingOptInAt !== null &&
    input.latestConsentStatus === "opt_in"
  );
}

/**
 * Prisma `where` for the eligible-audience candidate set. This is the broad
 * filter run in SQL; the precise "latest consent is opt_in" precedence check
 * (point 3 above) is then applied in memory via `isMarketingEligible`, because
 * Prisma cannot express "the most recent row in a one-to-many" in `where`.
 */
export function marketingEligibleWhere(
  restaurantId: string
): Prisma.CustomerWhereInput {
  return {
    restaurantId,
    marketingOptIn: true,
    marketingOptInAt: { not: null },
    consents: { some: { status: "opt_in" } },
  };
}

/**
 * Selection rule for the one-off legacy backfill: a customer needs a synthetic
 * opt_in consent row iff they are flagged opted-in but have NO consent rows at
 * all. We never write over an existing paper trail (an existing opt_out must
 * win), so the backfill only touches the pure pre-paper-trail / imported case.
 */
export function needsLegacyConsentBackfill(input: {
  marketingOptIn: boolean;
  consentCount: number;
}): boolean {
  return input.marketingOptIn === true && input.consentCount === 0;
}

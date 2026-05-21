// Creates the Sous Chef Inbox card that surfaces a Market Pulse digest.
//
// One draft per restaurant per weekBucket. If a draft for this week is
// already pending/approved/scheduled, we no-op — protects against the
// cron firing twice in the same week (manual re-runs, retry storms) and
// against the user already having seen and approved the alert.
//
// Action shape:
//   • source: market_pulse (new enum value)
//   • actionType: "competitor_alert"
//   • kind: single
//   • payload: { digestId, weekBucket, topInsight, recommendedAction }
//     — the chat UI reads this to render the card and the CTA button.
//   • preview: human-readable mirror of payload, used by Inbox listings
//     that don't need to deep-render.
//   • affectedSurface: deep link into Ad Studio with from=market-pulse
//     and the digest's intent baked in. Phase 3b will write a handler on
//     /dashboard/ad-studio that reads these params and pre-fills a new
//     project; until then the link just opens the Ad Studio list.
//
// Cron caller marks the digest's `notifiedAt` after this returns, so a
// later "did we already push this?" query has a single source of truth.

import { DraftActionKind, DraftActionSource, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createSystemDraft } from "@/services/draft-actions";
import type { MarketPulseDigest } from "./digest-synthesizer";

export interface MarketPulseDraftResult {
  status: "created" | "skipped_duplicate" | "skipped_no_movement";
  draftId?: string;
}

function buildAffectedSurface(digest: MarketPulseDigest): string {
  if (!digest.recommendedAction) return "/dashboard/ad-studio";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(digest.recommendedAction.ctaParams)) {
    params.set(key, String(value));
  }
  params.set("digestId", digest.digestId);
  // ctaRoute is "/dashboard/ad-studio/new" — landing on the new-project
  // wizard with prefill params, NOT the campaigns list, so the owner is
  // one click from a drafted campaign instead of two.
  return `${digest.recommendedAction.ctaRoute}?${params.toString()}`;
}

export async function ensureMarketPulseDraft(args: {
  restaurantId: string;
  digest: MarketPulseDigest;
}): Promise<MarketPulseDraftResult> {
  // No movement → nothing actionable to surface. The digest row still
  // exists so the dashboard widget can say "quiet week," but we don't
  // burn an Inbox slot on it.
  if (!args.digest.hasMovement) {
    return { status: "skipped_no_movement" };
  }

  // Idempotency: look for ANY existing draft for this exact digest, in
  // any status. Once we've surfaced an insight into the Inbox, we never
  // re-push it — even if the owner already approved/shipped/rejected it.
  // The owner explicitly handled the alert; resurfacing the same digestId
  // (e.g. from a manual orchestrator re-run mid-week) would feel like a
  // bug. Match on payload.digestId (which we write ourselves) rather than
  // weekBucket so a re-synthesized digest with the same id is still
  // recognized as "already pushed."
  const existing = await prisma.draftAction.findFirst({
    where: {
      restaurantId: args.restaurantId,
      source: DraftActionSource.market_pulse,
      actionType: "competitor_alert",
      payload: {
        path: ["digestId"],
        equals: args.digest.digestId,
      },
    },
    select: { id: true },
  });
  if (existing) {
    return { status: "skipped_duplicate", draftId: existing.id };
  }

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: args.restaurantId },
    select: { ownerId: true },
  });
  if (!restaurant) {
    // Restaurant deleted between snapshot run and draft creation. Nothing to do.
    return { status: "skipped_no_movement" };
  }

  const affectedSurface = buildAffectedSurface(args.digest);

  const draft = await createSystemDraft(args.restaurantId, restaurant.ownerId, {
    kind: DraftActionKind.single,
    actionType: "competitor_alert",
    source: DraftActionSource.market_pulse,
    title: args.digest.topInsight,
    subtitle: args.digest.recommendedAction?.label ?? "Open Ad Studio",
    iconKey: "competitors",
    affectedSurface,
    payload: {
      digestId: args.digest.digestId,
      weekBucket: args.digest.weekBucket,
      topInsight: args.digest.topInsight,
      recommendedAction: args.digest.recommendedAction,
      competitorsCount: args.digest.competitorsCount,
    } as unknown as Prisma.InputJsonValue,
    preview: {
      headline: args.digest.topInsight,
      ctaLabel: args.digest.recommendedAction?.label ?? null,
      competitorsCount: args.digest.competitorsCount,
      weekBucket: args.digest.weekBucket,
    } as unknown as Prisma.InputJsonValue,
  });

  // Stamp the digest so any later "was the owner notified?" query has a
  // direct answer without walking the DraftAction join.
  await prisma.competitorIntelDigest.update({
    where: { id: args.digest.digestId },
    data: { notifiedAt: new Date() },
  });

  return { status: "created", draftId: draft.id };
}

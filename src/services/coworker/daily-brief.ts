// Daily Brief — derives WhatsApp template variables from the WhisperSnapshot
// the existing owner-whisper job already produces. This service is the *only*
// place that decides which template (full vs lite) to send and what each
// variable resolves to, so the cron + admin "send now" endpoints share one
// truth.
//
// The router is intentionally simple:
//   - full: WhatsApp Ordering connected AND yesterday had any orders → use
//           order-derived metrics
//   - lite: everything else → review/menu-health framing
//
// We DO NOT silently fall back from full→lite mid-send; the choice is made
// once based on stable inputs so a pilot owner sees the same template every
// morning unless they actually change their setup.

import { Prisma } from "@prisma/client";
import {
  findTemplate,
  type CoworkerTemplateDefinition,
  type CoworkerTemplateLocale,
} from "@/lib/coworker/templates";
import { prisma } from "@/lib/prisma";
import type { WhisperSnapshot } from "@/lib/owner-chat-prompts";

export interface DailyBriefPlan {
  template: CoworkerTemplateDefinition;
  variables: string[];
  /** Human-readable preview (after variable substitution) used for admin UI
   *  and dry-run logs. */
  preview: string;
}

export interface DailyBriefInputs {
  restaurantId: string;
  ownerFirstName: string;
  restaurantName: string;
  locale: CoworkerTemplateLocale;
  snapshot: WhisperSnapshot;
  ordersV1Enabled: boolean;
  googleRating: number | null;
  googleReviewCount: number | null;
  itemsMissingImages: number;
  itemsMissingDescriptions: number;
}

const NBSP = " "; // used to keep "AED 0" visually intact in RTL flows

function formatNumber(value: number, locale: CoworkerTemplateLocale): string {
  // Both en and ar render best with western digits + thousands separators
  // (Arabic-Indic digits look beautiful but Meta's template approval bot
  // sometimes flags them as "different language"). Stick to western.
  if (!Number.isFinite(value)) return "0";
  return Math.round(value).toLocaleString("en-US");
}

function formatWowDelta(current: number, avg: number | null, locale: CoworkerTemplateLocale): string {
  if (avg === null || avg === 0) {
    return locale === "ar" ? "بدون مقارنة" : "no prior data";
  }
  const pct = Math.round(((current - avg) / avg) * 100);
  if (pct > 0) return `▲${pct}%`;
  if (pct < 0) return `▼${Math.abs(pct)}%`;
  return "—";
}

function buildAlertLine(snapshot: WhisperSnapshot, locale: CoworkerTemplateLocale): string {
  // Pick ONE highest-signal alert. Priority order:
  // 1) unread WA replies (24h SLA risk)
  // 2) revenue down vs same-weekday baseline
  // 3) menu health (missing images)
  // 4) silent "all good" line
  const ar = locale === "ar";

  if (snapshot.whatsapp.pendingReplies24h > 0) {
    return ar
      ? `${snapshot.whatsapp.pendingReplies24h} محادثة بدون رد منذ 24 ساعة`
      : `${snapshot.whatsapp.pendingReplies24h} WhatsApp conv${snapshot.whatsapp.pendingReplies24h === 1 ? "" : "s"} unanswered > 24h`;
  }
  if (
    snapshot.revenue.weekdayAvgAed !== null &&
    snapshot.revenue.weekdayAvgAed > 0 &&
    snapshot.revenue.yesterdayAed < snapshot.revenue.weekdayAvgAed * 0.7
  ) {
    const dropPct = Math.round(
      (1 - snapshot.revenue.yesterdayAed / snapshot.revenue.weekdayAvgAed) * 100
    );
    return ar
      ? `الإيرادات أقل ${dropPct}% من المعتاد لهذا اليوم`
      : `Revenue ${dropPct}% below your typical day`;
  }
  if (snapshot.menuHealth.itemsMissingImages > 0) {
    return ar
      ? `📷 ${snapshot.menuHealth.itemsMissingImages} أصناف بدون صور`
      : `📷 ${snapshot.menuHealth.itemsMissingImages} menu items missing photos`;
  }
  return ar ? "كل شيء على ما يرام 🌿" : "Nothing flagged today 🌿";
}

function buildWinbackLine(snapshot: WhisperSnapshot, locale: CoworkerTemplateLocale): string {
  // v1 has no churn detection persisted; we use top-liked as a positive nudge
  // when no other "win-back" signal is available. Once we wire a churn miner
  // this becomes "{{n}} VIPs haven't ordered in 28d".
  const ar = locale === "ar";
  if (snapshot.topLikedItem) {
    return ar
      ? `الأكثر إعجاباً هذا الأسبوع: ${snapshot.topLikedItem.name}`
      : `Most-liked this week: ${snapshot.topLikedItem.name}`;
  }
  return ar ? "اطلب أي شيء" : "Ask me anything";
}

function buildMenuHealthLine(input: DailyBriefInputs): string {
  const ar = input.locale === "ar";
  if (input.itemsMissingImages > 0) {
    return ar
      ? `📷 ${input.itemsMissingImages} أصناف بدون صور`
      : `📷 ${input.itemsMissingImages} menu items missing photos`;
  }
  if (input.itemsMissingDescriptions > 0) {
    return ar
      ? `📝 ${input.itemsMissingDescriptions} أصناف بدون وصف`
      : `📝 ${input.itemsMissingDescriptions} menu items missing descriptions`;
  }
  return ar ? "قائمتك تبدو رائعة 🌿" : "Your menu is looking sharp 🌿";
}

function buildNextStepLine(locale: CoworkerTemplateLocale): string {
  return locale === "ar"
    ? "اضغط التقرير الكامل لتعرف أهم تحسين هذا الأسبوع"
    : "Tap Full Report to see this week's biggest fix";
}

/** Decide which template to use AND fill its variables. Pure-ish: only
 *  reads its arguments; does not hit the DB. Returns null if locale has no
 *  matching template in the library (should never happen with v1 library
 *  which ships en+ar for both variants). */
export function planDailyBrief(input: DailyBriefInputs): DailyBriefPlan | null {
  const hasOrderData = input.ordersV1Enabled && input.snapshot.orders.count > 0;
  const variant = hasOrderData ? "coworker_daily_brief_full" : "coworker_daily_brief_lite";

  const template = findTemplate(variant, input.locale);
  if (!template) return null;

  let variables: string[];
  if (variant === "coworker_daily_brief_full") {
    const avgTicket =
      input.snapshot.orders.count > 0
        ? input.snapshot.revenue.yesterdayAed / input.snapshot.orders.count
        : 0;
    variables = [
      input.ownerFirstName,
      input.restaurantName,
      formatNumber(input.snapshot.revenue.yesterdayAed, input.locale),
      formatWowDelta(
        input.snapshot.revenue.yesterdayAed,
        input.snapshot.revenue.weekdayAvgAed,
        input.locale
      ),
      formatNumber(input.snapshot.orders.count, input.locale),
      formatNumber(avgTicket, input.locale),
      input.snapshot.topLikedItem?.name ?? (input.locale === "ar" ? "—" : "—"),
      buildAlertLine(input.snapshot, input.locale),
      formatNumber(input.snapshot.whatsapp.pendingReplies24h, input.locale),
      buildWinbackLine(input.snapshot, input.locale),
    ];
  } else {
    variables = [
      input.ownerFirstName,
      input.restaurantName,
      input.googleRating !== null ? input.googleRating.toFixed(1) : "—",
      input.googleReviewCount !== null ? formatNumber(input.googleReviewCount, input.locale) : "—",
      formatNumber(input.snapshot.scans.yesterday, input.locale),
      buildMenuHealthLine(input),
      buildNextStepLine(input.locale),
    ];
  }

  // Sanity: trim every variable to keep individual placeholders sane.
  // Meta caps individual template parameter values at 1024 chars; we
  // cap at 200 to keep the rendered preview readable in WhatsApp.
  variables = variables.map((v) => v.toString().slice(0, 200) || NBSP);

  const preview = variables.reduce(
    (body, value, index) =>
      body.replace(new RegExp(`\\{\\{${index + 1}\\}\\}`, "g"), value),
    template.body
  );

  return { template, variables, preview };
}

/** Loads the data the planner needs from the DB. Reuses the snapshot the
 *  existing owner-whisper job has already cached in OwnerWhisper.metricsJson
 *  when available — falls back to building from scratch if no whisper row
 *  exists yet (e.g. owner opted in mid-day before the whisper cron ran). */
export async function loadDailyBriefInputs(input: {
  restaurantId: string;
  locale: CoworkerTemplateLocale;
  forDate: string;
  ownerFirstName: string;
}): Promise<DailyBriefInputs | null> {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: input.restaurantId },
    select: {
      name: true,
      ordersV1Enabled: true,
      gbpConnection: { select: { averageRating: true, reviewCount: true } },
    },
  });
  if (!restaurant) return null;

  const whisper = await prisma.ownerWhisper.findUnique({
    where: { restaurantId_forDate: { restaurantId: input.restaurantId, forDate: new Date(input.forDate) } },
    select: { metricsJson: true },
  });

  if (!whisper) {
    // No snapshot yet for this date. Don't try to rebuild it here; let the
    // owner-whisper job produce one first. Returning null causes the caller
    // to skip (will retry tomorrow).
    return null;
  }

  const [itemsMissingImages, itemsMissingDescriptions] = await Promise.all([
    prisma.menuItem.count({
      where: { restaurantId: input.restaurantId, imageUrl: null },
    }),
    prisma.menuItem.count({
      where: {
        restaurantId: input.restaurantId,
        OR: [{ description: null }, { description: "" }],
      },
    }),
  ]);

  // OwnerWhisper.metricsJson is the exact WhisperSnapshot shape the whisper
  // builder emits — JSON-roundtripped, so we cast carefully.
  const snapshot = whisper.metricsJson as unknown as WhisperSnapshot;

  return {
    restaurantId: input.restaurantId,
    ownerFirstName: input.ownerFirstName,
    restaurantName: restaurant.name,
    locale: input.locale,
    snapshot,
    ordersV1Enabled: restaurant.ordersV1Enabled,
    googleRating: restaurant.gbpConnection?.averageRating
      ? Number((restaurant.gbpConnection.averageRating as Prisma.Decimal).toString())
      : null,
    googleReviewCount: restaurant.gbpConnection?.reviewCount ?? null,
    itemsMissingImages,
    itemsMissingDescriptions,
  };
}

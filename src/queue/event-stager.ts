// Event-driven Ad Studio auto-stager — daily 08:00-GST cron.
//
// Mirrors backend/src/queue/sabt-pack.ts in shape: a fanout job (cron-scheduled)
// that enumerates Pro/Portfolio restaurants with the event calendar enabled and
// enqueues a per-restaurant "stage moments" job. The per-restaurant worker:
//   1. Resolves the restaurant's country.
//   2. Plans which calendar moments fall inside their prep lead window.
//   3. For each moment, upserts a draft AdProject (idempotent via the unique
//      key on (restaurant_id, source_moment_id, source_moment_year)).
//   4. Sends a Resend email to the owner — one consolidated digest per run
//      listing all newly-staged drafts, so we never spam Eid + Mother's Day
//      + DSF as three separate emails on the same morning.
//
// Critical cost note: this worker only writes the project shell + brief. It
// does NOT call /generate (which spends tokens + image-gen credits). Owners
// click "Generate" from the email or calendar — keeps cost predictable while
// still making the calendar feel autonomous.

import PgBoss from "pg-boss";
import type { Prisma } from "@prisma/client";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { getBoss } from "@/queue/boss";
import { enqueueProactiveNudge } from "@/queue/proactive-nudge";
import { sendLifecycleEmail } from "@/services/email";
import { getRestaurantEntitlements } from "@/lib/entitlements";
import { campaignArchetypes } from "@/services/ad-studio/campaigns";
import { ensureSystemDraftForAdProject } from "@/services/draft-actions";
import { pickHeroDishForRestaurant } from "@/lib/archived-feature-guards";
import { DraftActionSource } from "@prisma/client";
import type { CalendarMoment, CountryCode } from "@/services/ad-studio/types";
import {
  buildBrandVoiceFromMoment,
  inferCountryFromLocation,
  pickCampaignTypeForMoment,
  pickGoalForMoment,
  planStagingsForCountry,
  type PlannedStaging,
} from "@/services/ad-studio/event-stager";

export const EVENT_STAGER_FANOUT_JOB = "event-stager-fanout";
export const EVENT_STAGER_RUN_JOB = "event-stager-run";

const RETRY_LIMIT = 1;
const FANOUT_RESTAURANT_CAP = 1000;

let fanoutQueueReady: Promise<void> | null = null;
let runQueueReady: Promise<void> | null = null;

async function ensureFanoutQueue() {
  if (!fanoutQueueReady) {
    fanoutQueueReady = getBoss()
      .then((queue) => queue.createQueue(EVENT_STAGER_FANOUT_JOB))
      .catch((error) => {
        fanoutQueueReady = null;
        throw error;
      });
  }
  await fanoutQueueReady;
}

async function ensureRunQueue() {
  if (!runQueueReady) {
    runQueueReady = getBoss()
      .then((queue) => queue.createQueue(EVENT_STAGER_RUN_JOB))
      .catch((error) => {
        runQueueReady = null;
        throw error;
      });
  }
  await runQueueReady;
}

export interface EventStagerRunJobData {
  restaurantId: string;
}

type RunWorkerJob = PgBoss.JobWithMetadata<EventStagerRunJobData>;

export async function startEventStagerWorker() {
  await ensureFanoutQueue();
  await ensureRunQueue();
  const queue = await getBoss();

  await queue.work<EventStagerRunJobData>(
    EVENT_STAGER_RUN_JOB,
    { batchSize: 4, includeMetadata: true } as PgBoss.WorkOptions,
    async (jobs) => {
      for (const job of jobs as unknown as RunWorkerJob[]) {
        try {
          await processRunJob(job.data.restaurantId);
        } catch (error) {
          console.warn(
            `[event-stager] run failed for ${job.data.restaurantId}:`,
            error
          );
          // One bad restaurant must not cascade across the batch.
        }
      }
    }
  );

  // Daily at 04:00 UTC = 08:00 GST. UAE is UTC+4 year-round, no DST.
  await queue.schedule(EVENT_STAGER_FANOUT_JOB, "0 4 * * *", undefined, {
    tz: "UTC",
  });
  await queue.work(EVENT_STAGER_FANOUT_JOB, async () => {
    await fanOutEventStagerJobs();
  });
}

/** Enumerate eligible restaurants and enqueue one per-restaurant run job each.
 *  Mirrors the entitlement filter in sabt-pack.ts so we only stage drafts for
 *  paid plans — auto-staging a draft for a trial-expired restaurant would
 *  fill their inbox with reminders they can't act on. */
async function fanOutEventStagerJobs() {
  const candidates = await prisma.restaurant.findMany({
    where: {
      eventCalendarEnabled: true,
      subscriptionStatus: { in: ["active", "trial"] },
      // Subscription branch: paid roles (matches the entitlement gate
      // checked again per-restaurant inside processRunJob).
      OR: [
        {
          subscription: {
            is: {
              plan: { in: ["pro", "fulltime", "portfolio"] },
              status: { in: ["active", "trial"] },
            },
          },
        },
        {
          operatorAccount: {
            is: { status: { in: ["active", "trial"] } },
          },
        },
      ],
    },
    select: { id: true },
    take: FANOUT_RESTAURANT_CAP,
  });

  await ensureRunQueue();
  const queue = await getBoss();

  let enqueued = 0;
  for (const r of candidates) {
    await queue.send(EVENT_STAGER_RUN_JOB, { restaurantId: r.id }, { retryLimit: RETRY_LIMIT });
    enqueued++;
  }

  console.log(`[event-stager] fanout enqueued=${enqueued}`);
  if (candidates.length === FANOUT_RESTAURANT_CAP) {
    console.warn(`[event-stager] fanout hit cap of ${FANOUT_RESTAURANT_CAP}`);
  }
}

interface StagedDraft {
  projectId: string;
  moment: CalendarMoment;
  fromDate: Date;
  prepDeadline: Date;
}

async function processRunJob(restaurantId: string) {
  // Belt-and-suspenders: re-check entitlement at run time. The fanout query
  // already filters but a plan can downgrade between fanout and run.
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    include: {
      subscription: true,
      operatorAccount: { include: { _count: { select: { brands: true } } } },
      owner: { select: { email: true, fullName: true } },
    },
  });
  if (!restaurant || !restaurant.eventCalendarEnabled) return;

  const entitlements = getRestaurantEntitlements(restaurant);
  if (!entitlements.adStudioEnabled) return;

  const country = inferCountryFromLocation(restaurant.location) as CountryCode;
  const plannedStagings = planStagingsForCountry({ country, now: new Date() });
  if (plannedStagings.length === 0) {
    return;
  }

  // Stage each planned moment. Dedupe is enforced by the unique key on
  // (restaurant_id, source_moment_id, source_moment_year) — if the row already
  // exists from yesterday's run, the create throws P2002 which we swallow.
  const newlyStaged: StagedDraft[] = [];
  for (const planned of plannedStagings) {
    const projectId = await stageMomentForRestaurant({
      restaurantId,
      restaurantCountry: country,
      planned,
    });
    if (projectId) {
      newlyStaged.push({
        projectId,
        moment: planned.moment,
        fromDate: planned.fromDate,
        prepDeadline: planned.prepDeadline,
      });
      try {
        await enqueueProactiveNudge({
          restaurantId,
          momentId: planned.moment.id,
          momentYear: planned.year,
          adProjectId: projectId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[event-stager] proactive nudge enqueue failed for ${projectId}: ${message}`);
      }
    }
  }

  // Mirror EVERY active staging into the Sous Chef Inbox — not just the ones
  // created on this run. A first-day mirror failure (DB blip, restart) would
  // otherwise leave the owner with an emailed-but-invisible draft forever:
  // tomorrow's run swallows the P2002 in stageMomentForRestaurant and skips
  // the mirror entirely. ensureSystemDraftForAdProject is idempotent — it
  // no-ops when a pending/approved DraftAction already exists.
  const plannedKeys = plannedStagings.map((p) => ({
    momentId: p.moment.id,
    year: p.year,
  }));
  const activeStagings = await prisma.adProject.findMany({
    where: {
      restaurantId,
      OR: plannedKeys.map(({ momentId, year }) => ({
        sourceMomentId: momentId,
        sourceMomentYear: year,
      })),
    },
    select: {
      id: true,
      sourceMomentId: true,
      sourceMomentYear: true,
    },
  });
  const plannedByKey = new Map(
    plannedStagings.map((p) => [`${p.moment.id}:${p.year}`, p])
  );
  for (const project of activeStagings) {
    if (!project.sourceMomentId || project.sourceMomentYear == null) continue;
    const planned = plannedByKey.get(
      `${project.sourceMomentId}:${project.sourceMomentYear}`
    );
    if (!planned) continue;

    const daysUntilDeadline = Math.max(
      0,
      Math.ceil((planned.prepDeadline.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
    );
    try {
      await ensureSystemDraftForAdProject(
        restaurantId,
        restaurant.ownerId,
        project.id,
        {
          actionType: "ad_project_review",
          source: DraftActionSource.event_stager,
          title: `${planned.moment.name} ${planned.year} campaign brief ready`,
          subtitle:
            daysUntilDeadline === 0
              ? "Prep deadline is today — open Ad Studio to generate"
              : `${daysUntilDeadline} day${daysUntilDeadline === 1 ? "" : "s"} until prep deadline`,
          iconKey: "ad",
          affectedSurface: `/dashboard/ad-studio/${project.id}`,
          payload: {
            adProjectId: project.id,
            momentId: planned.moment.id,
            momentYear: planned.year,
          },
          preview: {
            momentName: planned.moment.name,
            momentKind: planned.moment.kind,
            fromDate: planned.fromDate.toISOString(),
            prepDeadline: planned.prepDeadline.toISOString(),
            daysUntilDeadline,
          },
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[event-stager] inbox-draft mirror failed for ${project.id}: ${message}`
      );
    }
  }

  if (newlyStaged.length === 0) {
    // Nothing new to email about — everything in the prep window was already
    // staged on a prior day's run.
    return;
  }

  if (restaurant.owner?.email) {
    await sendEventStagedDigestEmail({
      ownerEmail: restaurant.owner.email,
      ownerName: restaurant.owner.fullName ?? null,
      restaurantName: restaurant.name,
      drafts: newlyStaged,
    });
  }

  console.log(
    `[event-stager] ${restaurantId} staged=${newlyStaged.length} (${newlyStaged
      .map((d) => d.moment.id)
      .join(", ")})`
  );
}

/** Idempotent stage. Returns the new projectId if a draft was created, or
 *  null if a draft already exists for this (restaurant, moment, year). */
/** Moments where a TikTok Photo Mode slideshow tends to outperform a paid
 *  static set. Food-focused, festive, and cultural moments are visual-led
 *  and reward the slow-scroll save mechanic; weather/delivery/shopping-
 *  festival moments are paid-spend pulses and stay static. */
function isSlideshowFriendlyMoment(moment: CalendarMoment): boolean {
  if (moment.id === "ramadan") return true;
  if (moment.id.startsWith("eid_")) return true;
  if (moment.kind === "food_focused") return true;
  if (moment.kind === "cultural_global") return true;
  if (moment.kind === "national_day") return true;
  return false;
}

/** Count this restaurant's photographed menu items. Mirrors the frontend
 *  format-picker gate so the event-stager only presets slideshow when the
 *  worker can actually compose 5 frames. */
async function countPhotographedDishes(restaurantId: string): Promise<number> {
  return prisma.menuItem.count({
    where: {
      restaurantId,
      isAvailable: true,
      OR: [{ imageStatus: "ready" }, { imageStatus: "generated" }],
    },
  });
}

const SLIDESHOW_MIN_PHOTOS = 5;

async function stageMomentForRestaurant(args: {
  restaurantId: string;
  restaurantCountry: CountryCode;
  planned: PlannedStaging;
}): Promise<string | null> {
  const { restaurantId, restaurantCountry, planned } = args;
  const { moment, year, fromDate, toDate } = planned;

  // Pass the occurrence + now so the mapping can route Eid in-event to the
  // brunch-hero archetype and Eid in-prep to pre_eid_lto / eid_al_adha_lamb_hero.
  const campaignType = pickCampaignTypeForMoment(moment, {
    occurrence: {
      from: fromDate.toISOString().slice(0, 10),
      to: toDate.toISOString().slice(0, 10),
    },
    now: new Date(),
  });
  // Defensive: confirm the picked type is actually in the KB. If KB drift
  // ever removes a type the worker references, fail gracefully (skip).
  const campaign = campaignArchetypes.find((c) => c.id === campaignType);
  if (!campaign) {
    console.warn(`[event-stager] campaign type ${campaignType} not in KB; skipping ${moment.id}`);
    return null;
  }

  // Country = restaurant's country if the moment covers it, else first listed.
  const country = moment.countries.includes(restaurantCountry)
    ? restaurantCountry
    : (moment.countries[0] as CountryCode);

  // Budget: campaign lean baseline × moment multiplier (if any), rounded to AED 50.
  const baseline = campaign.budgetTiers.lean.minAed;
  const multiplier = moment.budgetMultiplierVsBaseline ?? 1;
  const budgetAed = Math.max(500, Math.round((baseline * multiplier) / 50) * 50);
  const budgetTier: "lean" | "standard" | "aggressive" = multiplier >= 1.3 ? "standard" : "lean";

  // Platform mix: prefer the moment's channelMixHint, else campaign default.
  const platformsFromMoment = moment.channelMixHint
    ? Object.entries(moment.channelMixHint)
        .filter(([, v]) => typeof v === "number" && v > 0)
        .sort((a, b) => (b[1] as number) - (a[1] as number))
        .map(([k]) => k)
    : [];
  const fallbackPlatforms = Object.keys(campaign.platformMix);
  const targetPlatforms = (platformsFromMoment.length > 0 ? platformsFromMoment : fallbackPlatforms).slice(0, 4);

  // Preset slideshow format for visual-led moments when the restaurant has
  // enough photographed dishes for the worker to compose 5 frames. This
  // means the owner who clicks "Review & generate" on Eid / Ramadan / a
  // food festival lands on a draft that's already pointed at the right
  // creative format — no toggle hunting.
  let creativeFormat: "static_multi" | "slideshow_tiktok" = "static_multi";
  if (isSlideshowFriendlyMoment(moment)) {
    const photoCount = await countPhotographedDishes(restaurantId);
    if (photoCount >= SLIDESHOW_MIN_PHOTOS) {
      creativeFormat = "slideshow_tiktok";
    }
  }

  // Auto-pick a sensible default hero dish so the owner who clicks
  // "Generate" lands on a working brief instead of 6 failed variants. The
  // picker prefers owner-uploaded photos (free, real, on-brand) and falls
  // back to any available menu item — the owner can swap it from the draft
  // page before generation runs.
  const heroDish = await pickHeroDishForRestaurant(restaurantId);

  const briefJson: Prisma.InputJsonValue = {
    restaurantId,
    name: `${moment.name} ${year}`,
    campaignType,
    goal: pickGoalForMoment(moment),
    countries: [country],
    cuisines: ["all"],
    targetPlatforms,
    budgetTier,
    budgetAed,
    brandVoice: buildBrandVoiceFromMoment(moment),
    creativeFormat,
    autoStaged: true,
    sourceMomentId: moment.id,
    sourceMomentYear: year,
    primaryDishId: heroDish?.id ?? null,
  };

  try {
    const project = await prisma.adProject.create({
      data: {
        restaurantId,
        name: `${moment.name} ${year}`,
        campaignType,
        goal: pickGoalForMoment(moment),
        countries: [country],
        cuisines: ["all"],
        targetPlatforms,
        budgetTier,
        budgetAed,
        primaryDishId: heroDish?.id ?? null,
        brandVoice: buildBrandVoiceFromMoment(moment),
        status: "draft",
        briefJson,
        sourceMomentId: moment.id,
        sourceMomentYear: year,
        sourceMomentStartsOn: fromDate,
        sourceMomentStagedAt: new Date(),
      },
      select: { id: true },
    });
    return project.id;
  } catch (err) {
    // P2002 — unique constraint violation: a draft for this (restaurant, moment, year)
    // already exists. Idempotent: this is the "already staged from yesterday's run"
    // branch and is the expected steady state.
    if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2002") {
      return null;
    }
    throw err;
  }
}

// =============================================================================
// Email — consolidated digest
// =============================================================================

interface DigestEmailInput {
  ownerEmail: string;
  ownerName: string | null;
  restaurantName: string;
  drafts: StagedDraft[];
}

async function sendEventStagedDigestEmail(input: DigestEmailInput) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) {
    console.log(`[event-stager] email not configured; ${input.drafts.length} drafts banner-only`);
    return;
  }

  try {
    await sendLifecycleEmail({
      to: input.ownerEmail,
      subject:
        input.drafts.length === 1
          ? `Your ${input.drafts[0].moment.name} campaign brief is ready`
          : `${input.drafts.length} campaign briefs are ready for ${input.restaurantName}`,
      html: buildDigestEmailHtml(input),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[event-stager] email send failed for ${input.restaurantName}: ${message}`);
    // Don't bubble — the drafts are already staged, the banner is the fallback.
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function buildDigestEmailHtml(input: DigestEmailInput): string {
  const greeting = input.ownerName
    ? `Hi ${escapeHtml(input.ownerName.split(" ")[0] ?? input.ownerName)},`
    : "Hi there,";
  const baseUrl = env.FRONTEND_APP_URL.replace(/\/$/, "");
  const calendarUrl = `${baseUrl}/dashboard/ad-studio/calendar`;

  const draftBlocks = input.drafts
    .map((d) => {
      const reviewUrl = `${baseUrl}/dashboard/ad-studio/${d.projectId}`;
      return `
        <tr>
          <td style="padding: 14px 18px; background: #FFF8EC; border-radius: 14px;">
            <p style="margin: 0 0 4px; font-size: 15px; font-weight: 600; color: #201A17;">${escapeHtml(d.moment.name)}</p>
            <p style="margin: 0 0 10px; font-size: 13px; color: #5C4A2C;">
              Event runs from ${escapeHtml(fmtDate(d.fromDate))}. Lock the brief by <strong>${escapeHtml(fmtDate(d.prepDeadline))}</strong>.
            </p>
            <a href="${escapeHtml(reviewUrl)}" style="display: inline-block; background: #201A17; color: #FFFFFF; padding: 10px 20px; border-radius: 999px; text-decoration: none; font-weight: 600; font-size: 13px;">Review &amp; generate</a>
          </td>
        </tr>
        <tr><td style="height: 12px;"></td></tr>
      `;
    })
    .join("");

  const headline =
    input.drafts.length === 1
      ? `Your ${escapeHtml(input.drafts[0].moment.name)} campaign brief is ready`
      : `${input.drafts.length} campaign briefs ready for ${escapeHtml(input.restaurantName)}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${headline}</title>
</head>
<body style="margin: 0; padding: 0; background: #FFFDF9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #201A17;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: #FFFDF9; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 560px; background: #FFFFFF; border-radius: 24px; border: 1px solid #E5D7C0; overflow: hidden;">
          <tr>
            <td style="padding: 32px 32px 8px;">
              <p style="margin: 0 0 4px; font-size: 11px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: #8A6912;">Event calendar · Drafts ready</p>
              <h1 style="margin: 0 0 12px; font-size: 22px; line-height: 1.3; color: #201A17;">${headline}</h1>
              <p style="margin: 0 0 20px; font-size: 14px; line-height: 1.55; color: #5C5046;">
                ${greeting} we pre-drafted the campaign${input.drafts.length === 1 ? "" : "s"} below from your event calendar. Tap any one to review the brief, pick a hero dish, and generate creatives.
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${draftBlocks}</table>
              <p style="margin: 20px 0 0; font-size: 13px; color: #8A7C6E;">
                Want to see everything coming up? <a href="${escapeHtml(calendarUrl)}" style="color: #8A6912; text-decoration: underline;">Open the event calendar</a>.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 16px 32px 24px; border-top: 1px solid #F2E7D8;">
              <p style="margin: 0; font-size: 12px; color: #A99A87;">From Bustan — automatic event drafting so you never miss a moment.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Manual trigger — used by the admin endpoint + tests. */
export async function enqueueEventStagerForRestaurant(restaurantId: string) {
  await ensureRunQueue();
  const queue = await getBoss();
  await queue.send(EVENT_STAGER_RUN_JOB, { restaurantId }, { retryLimit: RETRY_LIMIT });
}

/** Synchronous run — used by the admin endpoint for testing without going through pg-boss. */
export async function runEventStagerForRestaurantNow(restaurantId: string) {
  await processRunJob(restaurantId);
}

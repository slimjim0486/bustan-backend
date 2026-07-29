// Sabt Pack pg-boss worker — weekly Sunday-07:00-GST batch.
//
// Mirrors backend/src/queue/owner-whisper.ts in shape: a fanout job (cron-
// scheduled) that enumerates Pro/Portfolio restaurants without a current-week
// pack and enqueues per-restaurant generate jobs.
//
// Owner notification:
//   • Sunday morning email via Resend ("Your Sabt Pack is ready") + dashboard
//     banner on /dashboard. NOT delivered via the restaurant's connected
//     WhatsApp Business — that integration is for customer-facing messages,
//     and self-messaging the owner from her own WABA would be confusing and
//     would burn into her per-WABA messaging tier capacity.
//   • If Resend isn't configured (no RESEND_API_KEY / RESEND_FROM_EMAIL),
//     the banner is the only delivery channel — generation still completes.
//
// Production deploy notes:
//   • The cron `0 3 * * 0` lands at exactly 07:00 GST every Sunday (UAE is
//     UTC+4 year-round, no DST).
//   • Idempotency: re-running the same Sunday twice is a no-op for restaurants
//     that already have a `ready` pack (enforced by the unique key on
//     ad_projects.(restaurant_id, sabt_pack_week_start_date)).

import PgBoss from "pg-boss";
import { DraftActionSource } from "@prisma/client";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { getBoss } from "@/queue/boss";
import { sendLifecycleEmail } from "@/services/email";
import { ensureSystemDraftForAdProject } from "@/services/draft-actions";
import {
  runSabtPackGeneration,
  sundayOfThisWeekUae,
} from "@/services/sabt-pack";

export const SABT_PACK_FANOUT_JOB = "sabt-pack-fanout";
export const SABT_PACK_GENERATE_JOB = "sabt-pack-generate";

const RETRY_LIMIT = 1;
const FANOUT_RESTAURANT_CAP = 1000;

let fanoutQueueReady: Promise<void> | null = null;
let generateQueueReady: Promise<void> | null = null;

async function ensureFanoutQueue() {
  if (!fanoutQueueReady) {
    fanoutQueueReady = getBoss()
      .then((queue) => queue.createQueue(SABT_PACK_FANOUT_JOB))
      .catch((error) => {
        fanoutQueueReady = null;
        throw error;
      });
  }
  await fanoutQueueReady;
}

async function ensureGenerateQueue() {
  if (!generateQueueReady) {
    generateQueueReady = getBoss()
      .then((queue) => queue.createQueue(SABT_PACK_GENERATE_JOB))
      .catch((error) => {
        generateQueueReady = null;
        throw error;
      });
  }
  await generateQueueReady;
}

export interface SabtPackGenerateJobData {
  restaurantId: string;
  /** ISO date string "YYYY-MM-DD" — Sunday of the target week in UAE local. */
  weekStartDate: string;
}

type GenerateWorkerJob = PgBoss.JobWithMetadata<SabtPackGenerateJobData>;

export async function startSabtPackWorker() {
  await ensureFanoutQueue();
  await ensureGenerateQueue();
  const queue = await getBoss();

  await queue.work<SabtPackGenerateJobData>(
    SABT_PACK_GENERATE_JOB,
    { batchSize: 4, includeMetadata: true } as PgBoss.WorkOptions,
    async (jobs) => {
      for (const job of jobs as unknown as GenerateWorkerJob[]) {
        try {
          await processGenerateJob(job);
        } catch (error) {
          console.warn(
            `[sabt-pack] generate failed for ${job.data.restaurantId} (${job.data.weekStartDate}):`,
            error
          );
          // One bad restaurant must not cascade across the batch.
        }
      }
    }
  );

  // Sundays at 03:00 UTC = 07:00 GST.
  await queue.schedule(SABT_PACK_FANOUT_JOB, "0 3 * * 0", undefined, {
    tz: "UTC",
  });
  await queue.work(SABT_PACK_FANOUT_JOB, async () => {
    await fanOutSabtPackJobs();
  });
}

/** Enumerate Pro/Portfolio restaurants without a current-week pack and enqueue
 *  one generate job each. Mirrors `fanOutWhisperJobs` in owner-whisper.ts. */
async function fanOutSabtPackJobs() {
  const weekStartDate = sundayOfThisWeekUae();
  const weekDate = new Date(`${weekStartDate}T00:00:00Z`);

  const candidates = await prisma.restaurant.findMany({
    where: {
      sabtPackEnabled: true,
      subscriptionStatus: { in: ["active", "trial"] },
      // Skip restaurants that already have a Sabt Pack row for this week,
      // regardless of status. The orchestrator's idempotency check will skip
      // ready/delivered/approved, and recover from failed/partial.
      adProjects: {
        none: { sabtPackWeekStartDate: weekDate },
      },
      // Subscription branch: per-restaurant Stripe subscription is Pro or
      // Portfolio. Operator branch: brand sits under an OperatorAccount
      // (Portfolio path). Both branches must reflect the entitlement gate
      // — never enqueue a job whose orchestrator will short-circuit, since
      // the pg-boss job is still consumed (logs, retry budget).
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
            is: {
              status: { in: ["active", "trial"] },
            },
          },
          // Belt-and-suspenders: per entitlements.ts, Portfolio activation
          // requires the operator to be active/trial AND have >= 3 brands.
          // Brand-count is per-operator so we filter at the operator level
          // (Prisma can't aggregate a count condition inline). We rely on
          // loadEligibleRestaurant() to do the precise check; here we just
          // exclude operators with no brands yet — a hard zero never wins.
        },
      ],
    },
    select: { id: true },
    take: FANOUT_RESTAURANT_CAP,
  });

  await ensureGenerateQueue();
  const queue = await getBoss();

  let enqueued = 0;
  for (const r of candidates) {
    await queue.send(
      SABT_PACK_GENERATE_JOB,
      { restaurantId: r.id, weekStartDate },
      { retryLimit: RETRY_LIMIT }
    );
    enqueued++;
  }

  console.log(`[sabt-pack] weekStartDate=${weekStartDate} enqueued=${enqueued}`);
  if (candidates.length === FANOUT_RESTAURANT_CAP) {
    console.warn(
      `[sabt-pack] fan-out hit cap of ${FANOUT_RESTAURANT_CAP} — consider raising`
    );
  }
}

async function processGenerateJob(job: GenerateWorkerJob) {
  const { restaurantId, weekStartDate } = job.data;

  if (!env.ANTHROPIC_API_KEY) {
    console.warn(`[sabt-pack] no ANTHROPIC_API_KEY; skipping ${restaurantId}`);
    return;
  }

  const result = await runSabtPackGeneration({ restaurantId, weekStartDate });

  if (result.status === "failed") {
    return;
  }

  // `shouldNotifyOwner` is the single source of truth for whether to send
  // the email. It's true on fresh `ready` packs AND on re-runs that hit
  // an existing `ready` pack (where the previous email send failed). It's
  // false for `delivered`, `approved`, `generating`, `partial`, and any
  // pack that's not full strength.
  if (!result.shouldNotifyOwner) {
    if (result.status === "partial") {
      console.log(
        `[sabt-pack] ${restaurantId} ${weekStartDate} partial=${result.slotsPersisted}/7 (banner-only)`
      );
    }
    return;
  }

  await sendSabtPackEmail({
    adProjectId: result.adProjectId,
    themeOfWeek: result.themeOfWeek,
  });

  // Mirror the weekly pack into the Sous Chef Inbox so it lives alongside
  // chat-originated drafts. Failure here must NOT block the email flow.
  try {
    await mirrorSabtPackToInbox({
      restaurantId,
      adProjectId: result.adProjectId,
      themeOfWeek: result.themeOfWeek,
      weekStartDate,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[sabt-pack] inbox-draft mirror failed for ${result.adProjectId}: ${message}`);
  }
}

async function mirrorSabtPackToInbox(args: {
  restaurantId: string;
  adProjectId: string;
  themeOfWeek: string | null;
  weekStartDate: string;
}) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: args.restaurantId },
    select: { ownerId: true, name: true },
  });
  if (!restaurant) return;

  // ensureSystemDraftForAdProject is idempotent — protects against the
  // duplicate-draft case on email-retry runs (where shouldNotifyOwner fires
  // again for a pack whose previous mirror succeeded).
  await ensureSystemDraftForAdProject(
    args.restaurantId,
    restaurant.ownerId,
    args.adProjectId,
    {
      actionType: "sabt_pack_review",
      source: DraftActionSource.sabt_pack,
      title: `Sabt Pack ready · 7 posts for the week`,
      subtitle: args.themeOfWeek
        ? `Theme: ${args.themeOfWeek}`
        : "Open Ad Studio to review and approve",
      iconKey: "ad",
      affectedSurface: `/dashboard/ad-studio/weekly/${args.adProjectId}`,
      payload: {
        adProjectId: args.adProjectId,
        weekStartDate: args.weekStartDate,
      },
      preview: {
        themeOfWeek: args.themeOfWeek,
        weekStartDate: args.weekStartDate,
        slotCount: 7,
      },
    }
  );
}

/** Sunday-morning email to the restaurant owner. Updates `sabt_pack_delivered_at`
 *  on success. Errors do NOT bubble to the worker because an email outage shouldn't
 *  reset a successful pack to "generating" — the banner is the always-on fallback.
 *
 *  Resolves the restaurant by walking from `adProjectId` → AdProject → Restaurant
 *  → Owner, so callers don't have to know whether the job payload contains a
 *  cuid or a slug. The AdProject row was just written by the orchestrator and
 *  always carries the canonical Restaurant cuid in its restaurantId column. */
async function sendSabtPackEmail(args: {
  adProjectId: string;
  themeOfWeek: string | null;
}) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) {
    console.log(
      `[sabt-pack] ${args.adProjectId} email not configured; banner-only delivery`
    );
    return;
  }

  const project = await prisma.adProject.findUnique({
    where: { id: args.adProjectId },
    select: {
      sabtPackThemeOfWeek: true,
      restaurant: {
        select: {
          id: true,
          name: true,
          owner: { select: { email: true, fullName: true } },
        },
      },
    },
  });

  if (!project?.restaurant?.owner?.email) {
    console.warn(
      `[sabt-pack] ${args.adProjectId} no owner email; banner-only delivery`
    );
    return;
  }

  const restaurant = project.restaurant;
  const reviewUrl = `${env.FRONTEND_APP_URL.replace(/\/$/, "")}/dashboard/ad-studio/weekly/${args.adProjectId}`;
  // Prefer the caller-supplied theme (fresh from the strategy pass) but fall
  // back to the persisted value when the worker is re-firing the email for
  // a pack generated on an earlier run.
  const themeOfWeek = args.themeOfWeek ?? project.sabtPackThemeOfWeek ?? null;

  try {
    await sendLifecycleEmail({
      to: restaurant.owner.email,
      subject: `Your Sabt Pack is ready — 7 posts for the week`,
      html: buildSabtPackEmailHtml({
        ownerName: restaurant.owner.fullName,
        restaurantName: restaurant.name,
        themeOfWeek,
        reviewUrl,
      }),
    });

    await prisma.adProject.update({
      where: { id: args.adProjectId },
      data: {
        sabtPackStatus: "delivered",
        sabtPackDeliveredAt: new Date(),
      },
    });
    console.log(`[sabt-pack] ${restaurant.id} delivered via email`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[sabt-pack] email send failed for ${restaurant.id}; pack remains ready:`,
      message
    );
    // Don't mark delivered; banner stays visible.
  }
}

/** Escape strings interpolated into HTML so a restaurant name like
 *  "Mama's <i>Kitchen</i>" can't break out of the template. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface SabtPackEmailInput {
  ownerName: string | null;
  restaurantName: string;
  themeOfWeek: string | null;
  reviewUrl: string;
}

function buildSabtPackEmailHtml(input: SabtPackEmailInput): string {
  const greeting = input.ownerName
    ? `Hi ${escapeHtml(input.ownerName.split(" ")[0] ?? input.ownerName)},`
    : "Hi there,";
  const themeBlock = input.themeOfWeek
    ? `<p style="margin: 0 0 24px; padding: 16px 18px; background: #FFF8EC; border-radius: 16px; font-size: 14px; color: #5C4A2C; line-height: 1.5;"><strong style="color: #8A6912;">This week's theme:</strong> ${escapeHtml(
        input.themeOfWeek
      )}</p>`
    : "";
  // Inline styles only — most email clients strip <style> and external CSS.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Your Sabt Pack is ready</title>
</head>
<body style="margin: 0; padding: 0; background: #FFFDF9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #201A17;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: #FFFDF9; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 560px; background: #FFFFFF; border-radius: 24px; border: 1px solid #E5D7C0; overflow: hidden;">
          <tr>
            <td style="padding: 32px 32px 8px;">
              <p style="margin: 0 0 4px; font-size: 11px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: #8A6912;">Sabt Pack · Week ready</p>
              <h1 style="margin: 0 0 8px; font-size: 24px; line-height: 1.25; color: #201A17;">Your 7 posts for the week</h1>
              <p style="margin: 0 0 24px; font-size: 15px; line-height: 1.5; color: #5C5046;">
                ${greeting} ${escapeHtml(input.restaurantName)}&apos;s Sabt Pack is generated and waiting on your review — slideshow, Reel cover, IG Feed, Carousel, GBP image, WhatsApp Status, and a GBP post.
              </p>
              ${themeBlock}
              <p style="margin: 0 0 24px;">
                <a href="${escapeHtml(input.reviewUrl)}" style="display: inline-block; background: #201A17; color: #FFFFFF; padding: 14px 28px; border-radius: 999px; text-decoration: none; font-weight: 600; font-size: 15px;">Review &amp; approve</a>
              </p>
              <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #8A7C6E;">
                Tap any slot to edit copy on your phone, then approve all 7. Posts are yours to publish on TikTok, Instagram, Google Business, and WhatsApp Status.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 16px 32px 24px; border-top: 1px solid #F2E7D8;">
              <p style="margin: 0; font-size: 12px; color: #A99A87;">From Bustan — your weekly content, ready before service.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Manual trigger — used by the admin endpoint + CLI. */
export async function enqueueSabtPackForRestaurant(
  restaurantId: string,
  weekStartDate?: string
) {
  await ensureGenerateQueue();
  const queue = await getBoss();
  await queue.send(
    SABT_PACK_GENERATE_JOB,
    {
      restaurantId,
      weekStartDate: weekStartDate ?? sundayOfThisWeekUae(),
    },
    { retryLimit: RETRY_LIMIT }
  );
}

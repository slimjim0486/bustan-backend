import type { SubscriptionPlan } from "@prisma/client";
import { prisma } from "@/lib/prisma";

const DEFAULT_CAPS: Record<"trial" | SubscriptionPlan, number> = {
  trial: 200,
  starter: 200,
  pro: 1000,
  fulltime: 3000,
  portfolio: 10000,
};

function readCap(key: string, fallback: number) {
  const raw = process.env[key];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function currentConciergeMonth(now = new Date()) {
  return now.toISOString().slice(0, 7);
}

export function getConciergeMonthlyCap(input: {
  subscriptionStatus?: string | null;
  subscription?: { plan: SubscriptionPlan | null } | null;
  operatorAccount?: { status?: string | null } | null;
}) {
  const plan =
    input.operatorAccount?.status === "active" || input.operatorAccount?.status === "trial"
      ? "portfolio"
      : input.subscription?.plan ?? "starter";
  const tier = input.subscriptionStatus === "trial" ? "trial" : plan;

  return readCap(
    `CONCIERGE_MONTHLY_CAP_${String(tier).toUpperCase()}`,
    DEFAULT_CAPS[tier]
  );
}

export async function getConciergeUsageState(restaurantId: string, cap: number) {
  const month = currentConciergeMonth();
  const usage = await prisma.conciergeUsage.findUnique({
    where: {
      restaurantId_month: {
        restaurantId,
        month,
      },
    },
    select: {
      repliesSent: true,
    },
  });
  const repliesSent = usage?.repliesSent ?? 0;
  return {
    month,
    repliesSent,
    cap,
    remaining: Math.max(0, cap - repliesSent),
    allowed: repliesSent < cap,
    warning: cap > 0 && repliesSent >= Math.floor(cap * 0.8),
  };
}

export async function incrementConciergeUsage(restaurantId: string, amount = 1) {
  const month = currentConciergeMonth();
  return prisma.conciergeUsage.upsert({
    where: {
      restaurantId_month: {
        restaurantId,
        month,
      },
    },
    create: {
      restaurantId,
      month,
      repliesSent: amount,
    },
    update: {
      repliesSent: {
        increment: amount,
      },
    },
  });
}

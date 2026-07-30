import type Anthropic from "@anthropic-ai/sdk";
import type { PlanEntitlements } from "@/lib/entitlements";
import { prisma } from "@/lib/prisma";
import type { AgentChannel } from "@/services/agent/idempotency";
import { addDays, startOfTodayGst, startOfWeekGst } from "@/lib/gst-time";
import { FEE_COUNTED_STATUSES, computeNoShowRate } from "@/lib/booking-metrics";

export interface ToolResult {
  content: string;
  preview?: {
    pendingActionId: string;
    description: string;
    changes: Array<{ label: string; before: string | null; after: string }>;
  };
  draftId?: string;
}

export const OWNER_TOOLS: Anthropic.Tool[] = [
  {
    name: "get_business_snapshot",
    description:
      "Get the business profile and current WhatsApp customer/inquiry counts.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_today_bookings",
    description:
      "List today's bookings (Dubai time): time, customer, service, status. Use for 'who's coming in today'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_week_new_customers",
    description:
      "Count this week's billable new-customer bookings and the fees they earned Bustan (AED).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_no_show_rate",
    description:
      "No-show rate over the last 30 days: completed vs no-show counts and the percentage.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_top_services",
    description: "The most-booked services over the last 30 days, with counts.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_quiet_slots",
    description:
      "Bookings per day for the next 7 days (Dubai), quietest days first — use to suggest filling empty days.",
    input_schema: { type: "object", properties: {} },
  },
];

export const PHASE2_TOOL_NAMES = new Set<string>();

export function getOwnerTools(_phase2Enabled: boolean): Anthropic.Tool[] {
  return OWNER_TOOLS;
}

export async function executeTool(
  toolName: string,
  restaurantId: string,
  clerkId: string,
  _entitlements: PlanEntitlements,
  _input: Record<string, unknown>,
  _options: { channel?: AgentChannel; idempotencyScope?: string } = {}
): Promise<ToolResult> {
  switch (toolName) {
    case "get_business_snapshot":
      return getBusinessSnapshot(restaurantId, clerkId);
    case "get_today_bookings":
      return getTodayBookings(restaurantId, clerkId);
    case "get_week_new_customers":
      return getWeekNewCustomers(restaurantId, clerkId);
    case "get_no_show_rate":
      return getNoShowRate(restaurantId, clerkId);
    case "get_top_services":
      return getTopServices(restaurantId, clerkId);
    case "get_quiet_slots":
      return getQuietSlots(restaurantId, clerkId);
    default:
      return {
        content: JSON.stringify({
          error: `Tool ${toolName} belongs to the archived restaurant product.`,
        }),
      };
  }
}

// Every helper below re-verifies restaurant ownership (id + owner.clerkId)
// before touching booking data — clerkId is never trusted to already scope
// the restaurantId argument.
async function verifyOwnership(restaurantId: string, clerkId: string): Promise<boolean> {
  const restaurant = await prisma.restaurant.findFirst({
    where: { id: restaurantId, owner: { clerkId } },
    select: { id: true },
  });
  return restaurant !== null;
}

async function getBusinessSnapshot(restaurantId: string, clerkId: string): Promise<ToolResult> {
  const restaurant = await prisma.restaurant.findFirst({
    where: { id: restaurantId, owner: { clerkId } },
    select: {
      id: true,
      name: true,
      location: true,
      _count: {
        select: {
          customers: true,
          whatsappConversations: true,
        },
      },
    },
  });

  if (!restaurant) {
    return { content: JSON.stringify({ error: "Business not found" }) };
  }

  return {
    content: JSON.stringify({
      business: {
        id: restaurant.id,
        name: restaurant.name,
        area: restaurant.location,
      },
      customers: restaurant._count.customers,
      whatsappInquiries: restaurant._count.whatsappConversations,
    }),
  };
}

async function getTodayBookings(restaurantId: string, clerkId: string): Promise<ToolResult> {
  if (!(await verifyOwnership(restaurantId, clerkId))) {
    return { content: JSON.stringify({ error: "Business not found" }) };
  }
  const todayStart = startOfTodayGst();
  const bookings = await prisma.booking.findMany({
    where: { restaurantId, slotAt: { gte: todayStart, lt: addDays(todayStart, 1) } },
    include: {
      customer: { select: { displayName: true } },
      service: { select: { name: true, durationMinutes: true } },
    },
    orderBy: { slotAt: "asc" },
    take: 50,
  });
  return {
    content: JSON.stringify({
      date: todayStart.toISOString().slice(0, 10),
      count: bookings.length,
      bookings: bookings.map((b) => ({
        slotAt: b.slotAt.toISOString(),
        customer: b.customer.displayName,
        service: b.service.name,
        durationMinutes: b.service.durationMinutes,
        status: b.status,
        isNewCustomer: b.isNewCustomer,
      })),
    }),
  };
}

async function getWeekNewCustomers(restaurantId: string, clerkId: string): Promise<ToolResult> {
  if (!(await verifyOwnership(restaurantId, clerkId))) {
    return { content: JSON.stringify({ error: "Business not found" }) };
  }
  const weekStart = startOfWeekGst();
  const agg = await prisma.booking.aggregate({
    where: {
      restaurantId,
      isNewCustomer: true,
      status: { in: FEE_COUNTED_STATUSES },
      confirmedAt: { gte: weekStart },
    },
    _sum: { feeAed: true },
    _count: true,
  });
  return {
    content: JSON.stringify({
      weekStart: weekStart.toISOString().slice(0, 10),
      newCustomers: agg._count,
      feesAed: agg._sum.feeAed ?? 0,
    }),
  };
}

async function getNoShowRate(restaurantId: string, clerkId: string): Promise<ToolResult> {
  if (!(await verifyOwnership(restaurantId, clerkId))) {
    return { content: JSON.stringify({ error: "Business not found" }) };
  }
  const since = addDays(startOfTodayGst(), -30);
  const [completed, noShows] = await Promise.all([
    prisma.booking.count({
      where: { restaurantId, status: "COMPLETED", resolvedAt: { gte: since } },
    }),
    prisma.booking.count({
      where: { restaurantId, status: "NO_SHOW", resolvedAt: { gte: since } },
    }),
  ]);
  return {
    content: JSON.stringify({
      windowDays: 30,
      completed,
      noShows,
      noShowRatePct: computeNoShowRate(completed, noShows),
    }),
  };
}

async function getTopServices(restaurantId: string, clerkId: string): Promise<ToolResult> {
  if (!(await verifyOwnership(restaurantId, clerkId))) {
    return { content: JSON.stringify({ error: "Business not found" }) };
  }
  const since = addDays(startOfTodayGst(), -30);
  const grouped = await prisma.booking.groupBy({
    by: ["serviceId"],
    where: { restaurantId, createdAt: { gte: since } },
    _count: { _all: true },
    orderBy: { _count: { serviceId: "desc" } },
    take: 5,
  });
  const services = await prisma.service.findMany({
    where: { id: { in: grouped.map((g) => g.serviceId) } },
    select: { id: true, name: true },
  });
  const nameById = new Map(services.map((s) => [s.id, s.name]));
  return {
    content: JSON.stringify({
      windowDays: 30,
      topServices: grouped.map((g) => ({
        service: nameById.get(g.serviceId) ?? g.serviceId,
        bookings: g._count._all,
      })),
    }),
  };
}

async function getQuietSlots(restaurantId: string, clerkId: string): Promise<ToolResult> {
  if (!(await verifyOwnership(restaurantId, clerkId))) {
    return { content: JSON.stringify({ error: "Business not found" }) };
  }
  const todayStart = startOfTodayGst();
  const days = await Promise.all(
    Array.from({ length: 7 }, (_, i) => {
      const dayStart = addDays(todayStart, i);
      return prisma.booking
        .count({
          where: {
            restaurantId,
            slotAt: { gte: dayStart, lt: addDays(dayStart, 1) },
            status: { in: ["CONFIRMED", "DEPOSIT_SENT"] },
          },
        })
        .then((count) => ({ date: dayStart.toISOString().slice(0, 10), bookings: count }));
    })
  );
  return {
    content: JSON.stringify({
      next7Days: [...days].sort((a, b) => a.bookings - b.bookings),
    }),
  };
}

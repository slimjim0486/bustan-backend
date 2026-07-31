// Tool surface for the customer-facing WhatsApp booking agent
// (Phase 4 / Task 11).
//
// Five tools, in a module-level const so the array identity is stable across
// turns — same pattern as OWNER_TOOLS in services/owner-chat-tools.ts. Tools
// render FIRST in the prompt prefix, so a freshly-built array (or a reordered
// one) would invalidate the prompt cache on every request.
//
// Everything here is scoped by restaurantId on every query: the caller is a
// member of the public, so a serviceId or a slot from the model is untrusted
// input, not a capability.

import type Anthropic from "@anthropic-ai/sdk";
import {
  GST_OFFSET_MS,
  computeAvailableSlots,
  type ExistingBooking,
} from "@/lib/booking-availability";
import { RELATIONSHIP_STATUSES, computeBookingFee, isNewCustomer } from "@/lib/booking-fee";
import { formatSlotGst } from "@/lib/booking-templates";
import { prisma } from "@/lib/prisma";
import { scheduleDepositLifecycle } from "@/queue/booking-expiry";
import { sendCoworkerText } from "@/services/coworker/sender";
import { payUrlFor } from "@/services/deposits";
import {
  parseOperatingHoursJson,
  summarizeOperatingHours,
} from "@/services/booking-agent/prompts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Slots held by a booking. Mirrors booking-availability's contract exactly. */
const HELD_BOOKING_STATUSES = ["DEPOSIT_SENT", "CONFIRMED"] as const;
const DEFAULT_GRANULARITY_MINUTES = 30;
const DEFAULT_AVAILABILITY_DAYS = 7;
const MAX_AVAILABILITY_DAYS = 14;
/** Few enough to read in one WhatsApp bubble. */
const MAX_SLOTS_RETURNED = 12;
const MAX_ALTERNATIVES = 3;
/** A genuine escalation: the customer needs a human, so the bot stands down for
 *  a full day and the owner owns the thread. */
export const ESCALATION_PAUSE_MS = 24 * 60 * 60 * 1000;
/** A guard trip (prompt-injection heuristic) is NOT a confirmed escalation. The
 *  patterns were tuned for owner-authored text, where a false positive cost one
 *  refusal line; here it costs a customer-facing mute, so the blast radius is
 *  deliberately an hour rather than a day. */
export const GUARD_PAUSE_MS = 60 * 60 * 1000;
const PAUSE_REASON_MAX_CHARS = 200;

export const BOOKING_AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: "get_services",
    description:
      "List the services this business actually offers, grouped by category, with their exact AED price and duration. Use it whenever the customer asks what is available or how much something costs.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_policies",
    description:
      "Get the business's no-show/cancellation policy, the deposit amount in AED, and the opening hours. Use it before asking for a deposit or answering a 'what if I cancel' question.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "check_availability",
    description:
      "Find real open slots for a service. ALWAYS call this before offering any time to a customer — never guess availability. Returns up to 12 upcoming slots in Gulf time.",
    input_schema: {
      type: "object",
      properties: {
        serviceId: {
          type: "string",
          description: "The id of the service, exactly as listed in the services section.",
        },
        fromDateIso: {
          type: "string",
          description:
            "Optional ISO date/time to start searching from. Defaults to now. Use it when the customer asks about a specific day.",
        },
        days: {
          type: "integer",
          description: "How many days ahead to search. Default 7, maximum 14.",
        },
      },
      required: ["serviceId"],
    },
  },
  {
    name: "create_booking",
    description:
      "Book a specific slot for the customer and get back the deposit payment link. Only call this after the customer has confirmed the service AND the exact time, and after check_availability offered that time.",
    input_schema: {
      type: "object",
      properties: {
        serviceId: {
          type: "string",
          description: "The id of the service the customer confirmed.",
        },
        slotAtIso: {
          type: "string",
          description:
            "The exact slot, as the slotAtIso value returned by check_availability. Do not construct one yourself.",
        },
        customerName: {
          type: "string",
          description: "The customer's name, if they gave it in this conversation.",
        },
      },
      required: ["serviceId", "slotAtIso"],
    },
  },
  {
    name: "escalate_to_owner",
    description:
      "Hand the conversation to the business owner and stop replying for 24 hours. Use it for complaints, refunds, medical or chemical questions, custom quotes, price negotiation, or anything you are not confident answering.",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            "One short sentence telling the owner what the customer needs, so they can pick up the thread.",
        },
      },
      required: ["reason"],
    },
  },
];

export interface BookingAgentToolContext {
  restaurantId: string;
  conversationId: string;
  customerId: string;
  customerPhone: string;
}

export interface BookingAgentToolResult {
  content: string;
  escalated?: boolean;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function asString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function granularityOf(bookingPolicies: unknown): number {
  if (!bookingPolicies || typeof bookingPolicies !== "object" || Array.isArray(bookingPolicies)) {
    return DEFAULT_GRANULARITY_MINUTES;
  }
  const raw = (bookingPolicies as { slotGranularityMinutes?: unknown }).slotGranularityMinutes;
  return typeof raw === "number" && raw > 0 ? raw : DEFAULT_GRANULARITY_MINUTES;
}

function noShowPolicyOf(bookingPolicies: unknown): string | null {
  if (!bookingPolicies || typeof bookingPolicies !== "object" || Array.isArray(bookingPolicies)) {
    return null;
  }
  const raw = (bookingPolicies as { noShowPolicy?: unknown }).noShowPolicy;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/** Start of the GST-local day containing `instant`, as a UTC instant. */
function gstDayStart(instant: Date): Date {
  const shifted = instant.getTime() + GST_OFFSET_MS;
  return new Date(Math.floor(shifted / DAY_MS) * DAY_MS - GST_OFFSET_MS);
}

/** A display name we're allowed to overwrite: the phone-derived placeholder the
 *  webhook writes when WhatsApp gives us no profile name. */
function isPhoneLikeName(name: string): boolean {
  return /^[+\d][\d\s()\-.]*$/.test(name.trim());
}

async function loadServiceAndRestaurant(restaurantId: string, serviceId: string) {
  const [service, restaurant] = await Promise.all([
    prisma.service.findFirst({
      where: { id: serviceId, restaurantId, isActive: true },
      select: { id: true, name: true, durationMinutes: true, priceAed: true },
    }),
    prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: {
        operatingHours: true,
        bookingPolicies: true,
        parallelCapacity: true,
        depositAed: true,
        newCustomerFeeAed: true,
      },
    }),
  ]);
  return { service, restaurant };
}

async function loadHeldBookings(
  restaurantId: string,
  from: Date,
  to: Date
): Promise<ExistingBooking[]> {
  const rows = await prisma.booking.findMany({
    where: {
      restaurantId,
      status: { in: [...HELD_BOOKING_STATUSES] },
      slotAt: { gte: from, lt: to },
    },
    select: { slotAt: true, service: { select: { durationMinutes: true } } },
  });
  return rows.map((row) => ({
    slotAt: row.slotAt,
    durationMinutes: row.service.durationMinutes,
  }));
}

async function getServices(ctx: BookingAgentToolContext): Promise<BookingAgentToolResult> {
  const services = await prisma.service.findMany({
    where: { restaurantId: ctx.restaurantId, isActive: true },
    orderBy: [{ categoryId: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      nameAr: true,
      priceAed: true,
      durationMinutes: true,
      description: true,
      category: { select: { name: true, sortOrder: true } },
    },
  });

  const byCategory = new Map<string, Array<Record<string, unknown>>>();
  for (const service of services) {
    const key = service.category?.name ?? "Other";
    const bucket = byCategory.get(key) ?? [];
    bucket.push({
      id: service.id,
      name: service.name,
      nameAr: service.nameAr,
      priceAed: service.priceAed,
      durationMinutes: service.durationMinutes,
      description: service.description,
    });
    byCategory.set(key, bucket);
  }

  return {
    content: json({
      categories: [...byCategory.entries()].map(([category, items]) => ({
        category,
        services: items,
      })),
    }),
  };
}

async function getPolicies(ctx: BookingAgentToolContext): Promise<BookingAgentToolResult> {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: ctx.restaurantId },
    select: { bookingPolicies: true, depositAed: true, operatingHours: true },
  });
  if (!restaurant) return { content: json({ error: "business_not_found" }) };

  return {
    content: json({
      noShowPolicy: noShowPolicyOf(restaurant.bookingPolicies),
      depositAed: restaurant.depositAed ?? 0,
      hoursSummary: summarizeOperatingHours(parseOperatingHoursJson(restaurant.operatingHours)),
    }),
  };
}

async function checkAvailability(
  input: Record<string, unknown>,
  ctx: BookingAgentToolContext
): Promise<BookingAgentToolResult> {
  const serviceId = asString(input, "serviceId");
  if (!serviceId) return { content: json({ error: "missing_service_id" }) };

  const { service, restaurant } = await loadServiceAndRestaurant(ctx.restaurantId, serviceId);
  if (!service) return { content: json({ error: "unknown_service" }) };
  if (!restaurant) return { content: json({ error: "business_not_found" }) };

  const now = new Date();
  const requestedFrom = asString(input, "fromDateIso");
  const parsedFrom = requestedFrom ? new Date(requestedFrom) : null;
  const from =
    parsedFrom && !Number.isNaN(parsedFrom.getTime()) && parsedFrom.getTime() > now.getTime()
      ? parsedFrom
      : now;

  const rawDays = typeof input.days === "number" ? Math.floor(input.days) : DEFAULT_AVAILABILITY_DAYS;
  const days = Math.min(Math.max(rawDays, 1), MAX_AVAILABILITY_DAYS);
  const to = new Date(gstDayStart(from).getTime() + days * DAY_MS);

  const existing = await loadHeldBookings(ctx.restaurantId, gstDayStart(from), to);

  const slots = computeAvailableSlots({
    hours: parseOperatingHoursJson(restaurant.operatingHours),
    durationMinutes: service.durationMinutes,
    granularityMinutes: granularityOf(restaurant.bookingPolicies),
    parallelCapacity: restaurant.parallelCapacity,
    existing,
    from,
    to,
    now,
  });

  return {
    content: json({
      serviceId: service.id,
      serviceName: service.name,
      durationMinutes: service.durationMinutes,
      priceAed: service.priceAed,
      slots: slots.slice(0, MAX_SLOTS_RETURNED).map((slot) => ({
        slotAtIso: slot.toISOString(),
        label: formatSlotGst(slot),
      })),
    }),
  };
}

async function createBooking(
  input: Record<string, unknown>,
  ctx: BookingAgentToolContext
): Promise<BookingAgentToolResult> {
  const serviceId = asString(input, "serviceId");
  const slotAtIso = asString(input, "slotAtIso");
  if (!serviceId || !slotAtIso) return { content: json({ error: "missing_service_or_slot" }) };

  const slotAt = new Date(slotAtIso);
  if (Number.isNaN(slotAt.getTime())) return { content: json({ error: "invalid_slot" }) };

  const { service, restaurant } = await loadServiceAndRestaurant(ctx.restaurantId, serviceId);
  if (!service) return { content: json({ error: "unknown_service" }) };
  if (!restaurant) return { content: json({ error: "business_not_found" }) };

  const now = new Date();
  // Re-verify against a fresh availability computation rather than trusting the
  // slot the model echoed back: minutes may have passed since check_availability
  // and someone else may have taken it. The window starts at the slot's own GST
  // day so alternatives land near what the customer asked for.
  const windowFrom = gstDayStart(slotAt);
  const windowTo = new Date(windowFrom.getTime() + DEFAULT_AVAILABILITY_DAYS * DAY_MS);
  const existing = await loadHeldBookings(ctx.restaurantId, windowFrom, windowTo);
  const slots = computeAvailableSlots({
    hours: parseOperatingHoursJson(restaurant.operatingHours),
    durationMinutes: service.durationMinutes,
    granularityMinutes: granularityOf(restaurant.bookingPolicies),
    parallelCapacity: restaurant.parallelCapacity,
    existing,
    from: windowFrom,
    to: windowTo,
    now,
  });

  if (!slots.some((slot) => slot.getTime() === slotAt.getTime())) {
    const alternatives = slots
      .filter((slot) => slot.getTime() >= slotAt.getTime())
      .slice(0, MAX_ALTERNATIVES);
    return {
      content: json({
        error: "slot_taken",
        alternatives: (alternatives.length ? alternatives : slots.slice(0, MAX_ALTERNATIVES)).map(
          (slot) => ({ slotAtIso: slot.toISOString(), label: formatSlotGst(slot) })
        ),
      }),
    };
  }

  const [customer, conversation, priorRelationshipBookings] = await Promise.all([
    prisma.customer.findFirst({
      where: { id: ctx.customerId, restaurantId: ctx.restaurantId },
      select: { id: true, createdAt: true, displayName: true, referralCtwaClid: true },
    }),
    prisma.whatsAppConversation.findFirst({
      where: { id: ctx.conversationId, restaurantId: ctx.restaurantId },
      select: { id: true, createdAt: true },
    }),
    // MUST filter on RELATIONSHIP_STATUSES: a prior EXPIRED / CANCELLED /
    // INQUIRY booking is not a relationship, so it must NOT disqualify this
    // customer from counting as new (Task 3 contract).
    prisma.booking.count({
      where: {
        restaurantId: ctx.restaurantId,
        customerId: ctx.customerId,
        status: { in: [...RELATIONSHIP_STATUSES] },
      },
    }),
  ]);

  if (!customer) return { content: json({ error: "customer_not_found" }) };

  const newCustomer = isNewCustomer({
    priorRelationshipBookings,
    customerCreatedAt: customer.createdAt,
    conversationCreatedAt: conversation?.createdAt ?? null,
  });

  // CTWA attribution lives on Customer (promoted from the inbound webhook's
  // referral payload); the conversation row carries no referral columns.
  const source = customer.referralCtwaClid ? "AD" : "WHATSAPP";
  const depositAed = restaurant.depositAed ?? 0;
  const feeAed = computeBookingFee({
    source,
    isNewCustomer: newCustomer,
    tenantFeeAed: restaurant.newCustomerFeeAed,
  });

  const booking = await prisma.booking.create({
    data: {
      restaurantId: ctx.restaurantId,
      customerId: ctx.customerId,
      serviceId: service.id,
      slotAt,
      status: "DEPOSIT_SENT",
      // Frozen at creation: the fee is decided once, here, and never
      // recomputed when the booking later confirms or resolves.
      isNewCustomer: newCustomer,
      feeAed,
      depositAed,
      conversationId: conversation?.id ?? null,
      source,
    },
    select: { id: true },
  });

  const customerName = asString(input, "customerName");
  if (customerName && isPhoneLikeName(customer.displayName)) {
    await prisma.customer
      .update({
        where: { id: customer.id },
        data: { displayName: customerName.slice(0, 160) },
      })
      .catch((error) => {
        console.error("[booking-agent] displayName update failed", error);
      });
  }

  // Schedules the +5h nudge and the +6h expiry. Called exactly once per
  // DEPOSIT_SENT transition — the two queue.sends inside are not atomic
  // (known, accepted), so retrying here would risk duplicate nudges.
  //
  // Isolated from the outer catch ON PURPOSE. The booking row already exists and
  // is holding the slot; if we let a queue failure fall through to tool_failed,
  // the customer never receives a pay link, nothing ever expires the row, and
  // the model may retry only to hit slot_taken against its own orphan. A booking
  // with a pay link but no expiry job is strictly better than a held slot with
  // no link — it is recoverable by hand, and the customer can still pay.
  try {
    await scheduleDepositLifecycle(booking.id, new Date());
  } catch (error) {
    console.error(
      `[booking-agent] scheduleDepositLifecycle failed for booking=${booking.id} — booking is live with NO expiry/nudge job, needs manual sweep`,
      error
    );
  }

  return {
    content: json({
      bookingId: booking.id,
      payUrl: payUrlFor(booking.id),
      slotLabel: formatSlotGst(slotAt),
      depositAed,
    }),
  };
}

/**
 * Best-effort ping to the owner's coworker thread. Deliberately swallows every
 * failure: no CoworkerOwner row, a closed 24h window, or a WhatsApp error must
 * never break the customer's turn. The paused conversation in the CRM inbox is
 * the real, durable signal — this is only a nudge on top of it.
 */
async function notifyOwnerOfEscalation(restaurantId: string, reason: string): Promise<void> {
  try {
    const owner = await prisma.coworkerOwner.findUnique({ where: { restaurantId } });
    if (!owner) return;
    if (!owner.windowExpiresAt || owner.windowExpiresAt < new Date()) return;

    const result = await sendCoworkerText({
      coworkerOwnerId: owner.id,
      restaurantId,
      body: `A customer on WhatsApp needs you: ${reason} I've paused the booking bot on that chat — reply to them from your inbox.`,
    });
    if (result.status === "failed") {
      console.warn(`[booking-agent] owner escalation ping failed: ${result.errorMessage ?? "unknown"}`);
    }
  } catch (error) {
    console.warn("[booking-agent] owner escalation ping threw", error);
  }
}

/**
 * Pauses the bot on a conversation and flags it unread for the owner. Shared by
 * the escalate_to_owner tool and the agent's pre-LLM guard path so both write
 * the pause exactly the same way — only the duration and the reason differ.
 */
export async function pauseConversationForOwner(args: {
  restaurantId: string;
  conversationId: string;
  reason: string;
  pauseMs: number;
  notifyOwner?: boolean;
}): Promise<void> {
  await prisma.whatsAppConversation.updateMany({
    where: { id: args.conversationId, restaurantId: args.restaurantId },
    data: {
      botPausedUntil: new Date(Date.now() + args.pauseMs),
      botPausedReason: args.reason.slice(0, PAUSE_REASON_MAX_CHARS),
      unreadCount: { increment: 1 },
    },
  });

  if (args.notifyOwner) {
    await notifyOwnerOfEscalation(args.restaurantId, args.reason);
  }
}

async function escalateToOwner(
  input: Record<string, unknown>,
  ctx: BookingAgentToolContext
): Promise<BookingAgentToolResult> {
  const reason = asString(input, "reason") ?? "Customer needs a human.";

  await pauseConversationForOwner({
    restaurantId: ctx.restaurantId,
    conversationId: ctx.conversationId,
    reason,
    pauseMs: ESCALATION_PAUSE_MS,
    notifyOwner: true,
  });

  return {
    content: json({
      escalated: true,
      // Says only what is actually guaranteed: the chat is flagged unread in the
      // owner's inbox. The owner ping above is best-effort and may not land, so
      // promising "the owner has been notified" would be a lie we make the model
      // tell the customer.
      note: "This chat has been flagged to the team's inbox and you are paused on it. Tell the customer someone from the team will reply here shortly, then stop.",
    }),
    escalated: true,
  };
}

export async function executeBookingAgentTool(
  name: string,
  input: Record<string, unknown>,
  ctx: BookingAgentToolContext
): Promise<BookingAgentToolResult> {
  try {
    switch (name) {
      case "get_services":
        return await getServices(ctx);
      case "get_policies":
        return await getPolicies(ctx);
      case "check_availability":
        return await checkAvailability(input, ctx);
      case "create_booking":
        return await createBooking(input, ctx);
      case "escalate_to_owner":
        return await escalateToOwner(input, ctx);
      default:
        return { content: json({ error: "unknown_tool", name }) };
    }
  } catch (error) {
    // Never let a DB blip end the turn with an unhandled rejection — the model
    // gets a structured failure and can apologise or escalate.
    console.error(`[booking-agent] tool ${name} failed`, error);
    return { content: json({ error: "tool_failed", tool: name }) };
  }
}

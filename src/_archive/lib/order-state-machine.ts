/**
 * OrderIntent state machine helpers — used by the WhatsApp webhook router
 * (when the restaurant taps Accept/Reject on an alert), the dashboard
 * Orders page (same actions via UI), and the expiry cron.
 *
 * Centralizing the transitions here means there is exactly one place that
 *   - validates a transition is legal
 *   - writes the OrderIntentEvent audit row
 *   - schedules the follow-up customer-facing WhatsApp template
 *   - triggers a Telr refund when a paid order is rejected
 *
 * H1 fix: every transition runs as an atomic conditional `updateMany`
 * with `where: { id, status: expected }`. If count !== 1 the transition
 * lost the race (another actor — usually the expiry cron racing a
 * restaurant Accept) and we return `{ ok: false }` without firing side
 * effects. Prevents the customer from receiving both an "Accepted" and a
 * "Cancelled" template (plus a phantom refund) when a Restaurant tap and
 * the cron expiry land in the same millisecond.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sendOrderTemplate } from "@/lib/order-messages";
import { telrAdapter } from "@/lib/payments/telr";

type OrderActionAccept = { type: "accept"; prepMinutes?: number };
type OrderActionReject = { type: "reject"; reason?: string };
type OrderActionMarkReady = { type: "mark_ready" };
type OrderActionMarkCompleted = { type: "mark_completed" };
type OrderActionExpire = { type: "expire" };

export type OrderAction =
  | OrderActionAccept
  | OrderActionReject
  | OrderActionMarkReady
  | OrderActionMarkCompleted
  | OrderActionExpire;

export type OrderActor = "customer" | "restaurant" | "system" | "webhook";

/**
 * Detect whether an inbound webhook message is an operator order action.
 * Returns null when the message is not an order action (caller should fall
 * through to normal CRM conversation handling).
 *
 * C1 (review finding): also surfaces a parsed order number when the
 * operator's reply quotes or contains one — caller uses that to route to
 * a SPECIFIC order rather than falling back to "oldest pending" which
 * misroutes when an operator manages multiple brands.
 */
export type DetectedOrderAction = {
  action: OrderAction;
  orderNumber: string | null;
};

// Crockford alphabet only — no I, L, O, U, 0, 1. Matches what
// generateOrderNumber emits so we never accept a number we couldn't have
// generated. Case-insensitive so operators who type lowercase still work.
const ORDER_NUMBER_RE = /\b(BST-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{5,12})\b/i;

export function detectOrderAction(message: Record<string, any>): DetectedOrderAction | null {
  const buttonText = (
    message.button?.text ??
    message.interactive?.button_reply?.title ??
    message.interactive?.list_reply?.title ??
    null
  ) as string | null;

  // Buttons emitted by templates carry the template's body text in `payload`
  // on some integrations — try to extract a quoted order number from there.
  const buttonPayload = (
    message.button?.payload ??
    message.interactive?.button_reply?.id ??
    message.interactive?.list_reply?.id ??
    null
  ) as string | null;

  const textBody = message.type === "text"
    ? String(message.text?.body ?? "")
    : "";

  const haystack = `${textBody}\n${buttonPayload ?? ""}`;
  const orderNumberMatch = haystack.match(ORDER_NUMBER_RE);
  const orderNumber = orderNumberMatch ? orderNumberMatch[1].toUpperCase() : null;

  if (buttonText) {
    const normalized = buttonText.trim().toLowerCase();
    if (normalized === "accept") return { action: { type: "accept" }, orderNumber };
    if (normalized === "reject") return { action: { type: "reject" }, orderNumber };
    const need = normalized.match(/^need\s+(\d{1,3})\s*min/);
    if (need) return { action: { type: "accept", prepMinutes: Number(need[1]) }, orderNumber };
  }

  if (textBody) {
    const body = textBody.trim().toLowerCase();
    if (!body) return null;
    // Allow keyword + order number in any position: "accept BST-7K3X9",
    // "BST-7K3X9 accept", "30 BST-7K3X9", "BST-7K3X9 30".
    const bare = body.replace(/\s*bst-[a-z0-9]+\s*/gi, " ").trim();
    if (bare === "accept") return { action: { type: "accept" }, orderNumber };
    if (bare === "reject") return { action: { type: "reject" }, orderNumber };
    const numeric = bare.match(/^(\d{1,3})$/);
    if (numeric) {
      const minutes = Number(numeric[1]);
      if (minutes >= 1 && minutes <= 240) {
        return { action: { type: "accept", prepMinutes: minutes }, orderNumber };
      }
    }
  }

  return null;
}

export type TransitionInput = {
  orderIntentId: string;
  action: OrderAction;
  actor: OrderActor;
  source: string;
  metadata?: Record<string, unknown>;
  /**
   * Optional safety guard — caller asserts they own this order. If provided
   * and the order's restaurantId doesn't match, the transition is rejected
   * atomically. H9 hardening.
   */
  expectedRestaurantId?: string;
};

export type TransitionResult =
  | { ok: true; status: string }
  | { ok: false; reason: string };

const FROM_STATUSES_BY_ACTION: Record<OrderAction["type"], string[]> = {
  accept: ["pending"],
  reject: ["pending", "accepted", "preparing"],
  mark_ready: ["accepted", "preparing"],
  mark_completed: ["ready"],
  expire: ["pending"],
};

function computeNextStatus(
  current: string,
  action: OrderAction
): "accepted" | "preparing" | "ready" | "completed" | "rejected" | "expired" | null {
  if (action.type === "accept") return current === "pending" ? "accepted" : null;
  if (action.type === "reject") {
    return current === "pending" || current === "accepted" || current === "preparing"
      ? "rejected"
      : null;
  }
  if (action.type === "mark_ready") {
    return current === "accepted" || current === "preparing" ? "ready" : null;
  }
  if (action.type === "mark_completed") return current === "ready" ? "completed" : null;
  if (action.type === "expire") return current === "pending" ? "expired" : null;
  return null;
}

/**
 * Apply a state transition to an OrderIntent atomically. Returns ok:false
 * (without firing side effects) when the order's status has moved under us
 * — caller can decide whether to retry or surface as a 409.
 *
 * Side effects (WhatsApp send, Telr refund) fire AFTER the conditional
 * update commits so a Meta 500 doesn't roll back the state change.
 */
export async function transitionOrder(input: TransitionInput): Promise<TransitionResult> {
  const expectedStatuses = FROM_STATUSES_BY_ACTION[input.action.type];
  if (!expectedStatuses) {
    return { ok: false, reason: `Unknown action: ${input.action.type}` };
  }

  // 1. Atomic conditional update — won't fire if the row's status has moved.
  const now = new Date();
  const updateData: Prisma.OrderIntentUpdateManyMutationInput = {};

  if (input.action.type === "accept") {
    updateData.status = "accepted";
    updateData.acceptedAt = now;
    updateData.estimatedPrepMinutes = input.action.prepMinutes ?? 25;
  } else if (input.action.type === "reject") {
    updateData.status = "rejected";
    updateData.rejectedAt = now;
    updateData.rejectionReason = input.action.reason ?? "Restaurant rejected the order.";
  } else if (input.action.type === "mark_ready") {
    updateData.status = "ready";
    updateData.readyAt = now;
  } else if (input.action.type === "mark_completed") {
    updateData.status = "completed";
    updateData.completedAt = now;
  } else if (input.action.type === "expire") {
    updateData.status = "expired";
    updateData.rejectionReason = "No response from restaurant within 15 minutes.";
  }

  // 1a. Read the current status FIRST so the audit log records the actual
  // previous state (not just the first item in the allowed-from-states
  // array, which loses information for actions like `reject` that accept
  // multiple from-states).
  const current = await prisma.orderIntent.findUnique({
    where: { id: input.orderIntentId },
    select: { status: true, restaurantId: true },
  });
  if (!current) {
    return { ok: false, reason: "Order not found" };
  }
  if (
    input.expectedRestaurantId &&
    current.restaurantId !== input.expectedRestaurantId
  ) {
    return { ok: false, reason: "Order does not belong to this restaurant" };
  }
  if (!expectedStatuses.includes(current.status)) {
    return {
      ok: false,
      reason: `Order is in '${current.status}' which does not allow '${input.action.type}'`,
    };
  }

  // 1b. Atomic conditional update on the EXACT current status — protects
  // against a race where the row's status flips between the read above
  // and the update below (e.g. cron expire firing in the same ms).
  const updateResult = await prisma.orderIntent.updateMany({
    where: {
      id: input.orderIntentId,
      status: current.status,
    },
    data: updateData,
  });

  if (updateResult.count !== 1) {
    return {
      ok: false,
      reason: `Race detected: order status changed under us during the ${input.action.type} attempt.`,
    };
  }

  // 2. Re-read the (now updated) row for side effects.
  const order = await prisma.orderIntent.findUnique({
    where: { id: input.orderIntentId },
    include: {
      restaurant: {
        select: {
          name: true,
          whatsappIntegration: {
            select: {
              id: true,
              restaurantId: true,
              phoneNumberId: true,
              displayPhoneNumber: true,
              accessTokenCipher: true,
            },
          },
        },
      },
    },
  });

  if (!order) {
    return { ok: false, reason: "Order vanished after transition." };
  }

  // 3. Audit event with the ACTUAL previous status.
  await prisma.orderIntentEvent
    .create({
      data: {
        orderIntentId: order.id,
        fromStatus: current.status,
        toStatus: order.status,
        actor: input.actor,
        source: input.source,
        metadata: input.metadata
          ? (input.metadata as Prisma.InputJsonValue)
          : undefined,
      },
    })
    .catch((error) => {
      console.error("[order-state-machine] audit event insert failed", {
        orderIntentId: order.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });

  // 4. Side effects. Failures are persisted as `system:side_effect_failed`
  // audit rows so the dashboard can surface them (M2 fix).
  await fireSideEffects(order, input.action).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[order-state-machine] post-commit side effect failed", {
      orderIntentId: input.orderIntentId,
      action: input.action,
      error: message,
    });
    await prisma.orderIntentEvent
      .create({
        data: {
          orderIntentId: order.id,
          fromStatus: order.status,
          toStatus: order.status,
          actor: "system",
          source: "side_effect_failed",
          metadata: { action: input.action.type, error: message } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
  });

  return { ok: true, status: order.status };
}

async function fireSideEffects(
  order: {
    id: string;
    orderNumber: string;
    customerName: string;
    phoneNumber: string;
    normalizedPhone: string | null;
    fulfillmentMethod: string;
    address: string | null;
    totalPrice: Prisma.Decimal;
    estimatedPrepMinutes: number | null;
    rejectionReason: string | null;
    paymentProvider: string | null;
    paymentSessionId: string | null;
    paymentStatus: string;
    paymentAmountMinor: bigint | null;
    restaurant: {
      name: string;
      whatsappIntegration: {
        id: string;
        restaurantId: string;
        phoneNumberId: string;
        displayPhoneNumber: string;
        accessTokenCipher: string;
      } | null;
    };
  },
  action: OrderAction
): Promise<void> {
  const integration = order.restaurant.whatsappIntegration;
  if (!integration) {
    return;
  }

  // H3: prefer the persisted normalized phone — never re-normalize at use
  // time, since `normalizeE164Phone` is not idempotent on UAE shorthand.
  const toPhone = order.normalizedPhone ?? order.phoneNumber;

  if (action.type === "accept") {
    await sendOrderTemplate({
      integration,
      toPhone,
      templateName: "order_accepted_v1",
      parameters: [
        order.restaurant.name,
        order.orderNumber,
        String(order.estimatedPrepMinutes ?? 25),
      ],
    });
  } else if (action.type === "reject" || action.type === "expire") {
    const refundLine = await maybeRefundAndDescribe(order);
    await sendOrderTemplate({
      integration,
      toPhone,
      templateName: "order_cancelled_v1",
      parameters: [
        order.orderNumber,
        order.rejectionReason ?? "Order cancelled.",
        refundLine,
      ],
    });
  } else if (action.type === "mark_ready") {
    const line =
      order.fulfillmentMethod === "delivery"
        ? "Your delivery is on the way."
        : order.fulfillmentMethod === "dine_in"
        ? "Bring this code to your table."
        : "Pickup ready at the counter.";
    await sendOrderTemplate({
      integration,
      toPhone,
      templateName: "order_ready_v1",
      parameters: [order.orderNumber, order.restaurant.name, line],
    });
  }
}

async function maybeRefundAndDescribe(order: {
  id: string;
  paymentProvider: string | null;
  paymentSessionId: string | null;
  paymentStatus: string;
  paymentAmountMinor: bigint | null;
  totalPrice: Prisma.Decimal;
}): Promise<string> {
  if (
    order.paymentStatus !== "paid" ||
    !order.paymentSessionId ||
    order.paymentProvider !== "telr"
  ) {
    return "No payment was taken.";
  }

  try {
    await telrAdapter.refund({
      sessionRef: order.paymentSessionId,
      amountMinor: order.paymentAmountMinor ?? BigInt(0),
      reason: "Order cancelled by restaurant.",
    });
    // Transition paymentStatus → refunded (independent of order status).
    await prisma.orderIntent
      .update({ where: { id: order.id }, data: { paymentStatus: "refunded" } })
      .catch(() => undefined);
    return `Refund of AED ${Number(order.totalPrice.toString()).toFixed(2)} will appear in 3-5 business days.`;
  } catch (error) {
    console.error("[order-state-machine] refund failed", {
      sessionRef: order.paymentSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    await prisma.orderIntent
      .update({ where: { id: order.id }, data: { paymentStatus: "failed" } })
      .catch(() => undefined);
    return "Refund could not be processed automatically — the restaurant will contact you.";
  }
}

/**
 * Find the oldest open OrderIntent for a restaurant. Caller (webhook router)
 * uses this only as a fallback when the operator's reply did NOT contain a
 * BST-XXXXX order number — when it did, the caller looks up by orderNumber
 * directly to avoid mis-routing across brands.
 */
export async function findOldestPendingOrderForRestaurant(restaurantId: string) {
  return prisma.orderIntent.findFirst({
    where: {
      restaurantId,
      status: "pending",
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, orderNumber: true, customerName: true, phoneNumber: true },
  });
}

/**
 * C1: look up by explicit order number (with restaurant guard so an operator
 * on brand A can't accidentally accept brand B's order even if the message
 * was somehow misrouted).
 */
export async function findPendingOrderByNumber(
  restaurantId: string,
  orderNumber: string
) {
  return prisma.orderIntent.findFirst({
    where: {
      restaurantId,
      orderNumber,
      status: { in: ["pending", "accepted", "preparing"] },
    },
    select: { id: true, orderNumber: true, status: true, customerName: true, phoneNumber: true },
  });
}

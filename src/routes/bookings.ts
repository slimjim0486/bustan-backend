import { Hono } from "hono";
import { z } from "zod";
import { BookingStatus } from "@prisma/client";
import {
  FEE_COUNTED_STATUSES,
  assertStatusTransition,
  buildBookingListWhere,
  computeNoShowRate,
} from "@/lib/booking-metrics";
import { ApiError } from "@/lib/errors";
import {
  addDays,
  startOfMonthGst,
  startOfNextMonthGst,
  startOfTodayGst,
  startOfWeekGst,
} from "@/lib/gst-time";
import { errorResponse } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { normalizeUaePhone } from "@/lib/uae-phone";
import { requireAuth } from "@/middleware/auth";
import { resolveBooking } from "@/services/booking-resolution";

const statusCsv = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (!value) return undefined;
    const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
    const valid = new Set<string>(Object.values(BookingStatus));
    for (const part of parts) {
      if (!valid.has(part)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown status ${part}` });
        return z.NEVER;
      }
    }
    return parts as BookingStatus[];
  });

export const listQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  status: statusCsv,
}).transform(({ from, to, status }) => ({ from, to, statuses: status }));

export const manualBookingSchema = z.object({
  customerPhone: z.string().min(4).max(32),
  customerName: z.string().trim().min(1).max(120),
  serviceId: z.string().min(1),
  slotAt: z.coerce.date(),
  notes: z.string().trim().max(2000).optional(),
});

export const resolveSchema = z.object({
  status: z.enum(["COMPLETED", "NO_SHOW"]),
});

const bookingInclude = {
  customer: { select: { id: true, displayName: true, phoneNumber: true } },
  service: { select: { id: true, name: true, durationMinutes: true, priceAed: true } },
} as const;

async function assertOwnedRestaurant(restaurantId: string, clerkId: string) {
  const restaurant = await prisma.restaurant.findFirst({
    where: { id: restaurantId, owner: { clerkId } },
    select: { id: true },
  });
  if (!restaurant) throw new ApiError("Business not found", 404);
}

const bookingsRouteBase = new Hono<{
  Variables: { auth: { clerkId: string; email: string | null } };
}>();

bookingsRouteBase.use("*", requireAuth);

export const bookingsRoute = bookingsRouteBase
  .get("/:restaurantId/summary", async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      await assertOwnedRestaurant(restaurantId, c.get("auth").clerkId);

      const now = new Date();
      const todayStart = startOfTodayGst(now);
      const todayEnd = addDays(todayStart, 1);
      const weekStart = startOfWeekGst(now);
      const monthStart = startOfMonthGst(now);
      const monthEnd = startOfNextMonthGst(now);
      const billableWhere = {
        restaurantId,
        isNewCustomer: true,
        status: { in: FEE_COUNTED_STATUSES },
      };

      const [
        todayConfirmed,
        waitingInquiries,
        weekFees,
        monthBookings,
        monthNewCustomers,
        monthFees,
        monthCompleted,
        monthNoShows,
        depositsHeld,
        payoutDue,
      ] = await Promise.all([
        prisma.booking.count({
          where: {
            restaurantId,
            slotAt: { gte: todayStart, lt: todayEnd },
            status: { in: ["CONFIRMED", "COMPLETED"] },
          },
        }),
        prisma.booking.count({
          where: { restaurantId, status: { in: ["INQUIRY", "DEPOSIT_SENT"] } },
        }),
        prisma.booking.aggregate({
          where: { ...billableWhere, confirmedAt: { gte: weekStart } },
          _sum: { feeAed: true },
        }),
        prisma.booking.count({
          where: { restaurantId, slotAt: { gte: monthStart, lt: monthEnd } },
        }),
        prisma.booking.count({
          where: { ...billableWhere, confirmedAt: { gte: monthStart } },
        }),
        prisma.booking.aggregate({
          where: { ...billableWhere, confirmedAt: { gte: monthStart } },
          _sum: { feeAed: true },
        }),
        prisma.booking.count({
          where: { restaurantId, status: "COMPLETED", resolvedAt: { gte: monthStart } },
        }),
        prisma.booking.count({
          where: { restaurantId, status: "NO_SHOW", resolvedAt: { gte: monthStart } },
        }),
        prisma.booking.aggregate({
          where: { restaurantId, status: "CONFIRMED" },
          _sum: { depositAed: true },
        }),
        prisma.payoutRecord.aggregate({
          where: { restaurantId, status: "PENDING" },
          _sum: { amountDueAed: true },
        }),
      ]);

      return c.json({
        summary: {
          today: { confirmed: todayConfirmed, waitingInquiries },
          week: { feesAed: weekFees._sum.feeAed ?? 0 },
          month: {
            totalBookings: monthBookings,
            newCustomers: monthNewCustomers,
            feesAed: monthFees._sum.feeAed ?? 0,
            noShowRate: computeNoShowRate(monthCompleted, monthNoShows),
            depositsHeldAed: depositsHeld._sum.depositAed ?? 0,
            payoutDueAed: payoutDue._sum.amountDueAed ?? 0,
          },
        },
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .get("/:restaurantId", async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      await assertOwnedRestaurant(restaurantId, c.get("auth").clerkId);
      const query = listQuerySchema.parse({
        from: c.req.query("from"),
        to: c.req.query("to"),
        status: c.req.query("status"),
      });
      const from = query.from ?? (query.to ? undefined : startOfTodayGst());
      const to = query.to ?? (query.from ? undefined : addDays(startOfTodayGst(), 7));
      const bookings = await prisma.booking.findMany({
        where: buildBookingListWhere(restaurantId, {
          from,
          to,
          statuses: query.statuses,
        }),
        include: bookingInclude,
        orderBy: { slotAt: "asc" },
        take: 500,
      });
      return c.json({ bookings });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/:restaurantId", async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      await assertOwnedRestaurant(restaurantId, c.get("auth").clerkId);
      const body = manualBookingSchema.parse(await c.req.json());

      const normalizedPhone = normalizeUaePhone(body.customerPhone);
      if (!normalizedPhone) throw new ApiError("Invalid UAE phone number", 400);

      const service = await prisma.service.findFirst({
        where: { id: body.serviceId, restaurantId },
        select: { id: true },
      });
      if (!service) throw new ApiError("Service not found", 404);

      const customer = await prisma.customer.upsert({
        where: { restaurantId_normalizedPhone: { restaurantId, normalizedPhone } },
        update: {},
        create: {
          restaurantId,
          normalizedPhone,
          phoneNumber: body.customerPhone,
          displayName: body.customerName,
        },
      });

      // Manual bookings are never billable — the fee only applies to
      // agent-originated bookings (spec §3.2).
      const booking = await prisma.booking.create({
        data: {
          restaurantId,
          customerId: customer.id,
          serviceId: service.id,
          slotAt: body.slotAt,
          status: "CONFIRMED",
          confirmedAt: new Date(),
          isNewCustomer: false,
          feeAed: 0,
          depositAed: 0,
          source: "MANUAL",
          notes: body.notes ?? null,
        },
        include: bookingInclude,
      });
      return c.json({ booking }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .patch("/:restaurantId/:bookingId", async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      const bookingId = c.req.param("bookingId");
      await assertOwnedRestaurant(restaurantId, c.get("auth").clerkId);
      const { status } = resolveSchema.parse(await c.req.json());

      const booking = await prisma.booking.findFirst({
        where: { id: bookingId, restaurantId },
        select: { id: true, status: true },
      });
      if (!booking) throw new ApiError("Booking not found", 404);
      assertStatusTransition(booking.status, status);

      const result = await resolveBooking({ restaurantId, bookingId: booking.id, status });
      if (!result.ok) throw new ApiError(`Cannot mark a ${booking.status} booking as ${status}`, 400);

      const updated = await prisma.booking.findUniqueOrThrow({
        where: { id: booking.id },
        include: bookingInclude,
      });
      return c.json({ booking: updated });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

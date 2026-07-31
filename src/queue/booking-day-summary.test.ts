import assert from "node:assert/strict";
import test from "node:test";
import { computeDaySummary } from "./booking-day-summary";

// GST is UTC+4 year-round. dayStartUtc = today's GST midnight expressed as a
// UTC instant. 2026-07-31T20:00:00Z = 2026-08-01T00:00:00 GST, i.e. "today"
// (GST) runs 2026-07-31T20:00:00Z .. 2026-08-01T20:00:00Z, and "tomorrow"
// (GST) runs 2026-08-01T20:00:00Z .. 2026-08-02T20:00:00Z.
const dayStartUtc = new Date("2026-07-31T20:00:00.000Z");

test("fixture: 3 confirmed-today (2 new, deposits 50+50+75), 2 confirmed-tomorrow", () => {
  const bookings = [
    // Confirmed today, still CONFIRMED, new customer.
    {
      status: "CONFIRMED",
      isNewCustomer: true,
      depositAed: 50,
      slotAt: new Date("2026-08-01T10:00:00.000Z"),
      confirmedAt: new Date("2026-08-01T02:00:00.000Z"),
    },
    // Confirmed today, since resolved COMPLETED, new customer — still counts
    // toward bookingsToday (status filter is CONFIRMED/COMPLETED/NO_SHOW).
    {
      status: "COMPLETED",
      isNewCustomer: true,
      depositAed: 50,
      slotAt: new Date("2026-08-01T06:00:00.000Z"),
      confirmedAt: new Date("2026-08-01T04:00:00.000Z"),
    },
    // Confirmed today, since resolved NO_SHOW, returning customer.
    {
      status: "NO_SHOW",
      isNewCustomer: false,
      depositAed: 75,
      slotAt: new Date("2026-08-01T08:00:00.000Z"),
      confirmedAt: new Date("2026-08-01T10:00:00.000Z"),
    },
    // Confirmed several days ago (not today) but slot is tomorrow — counts
    // only toward tomorrowConfirmed, not bookingsToday.
    {
      status: "CONFIRMED",
      isNewCustomer: true,
      depositAed: 60,
      slotAt: new Date("2026-08-02T09:00:00.000Z"),
      confirmedAt: new Date("2026-07-28T09:00:00.000Z"),
    },
    {
      status: "CONFIRMED",
      isNewCustomer: false,
      depositAed: 60,
      slotAt: new Date("2026-08-02T12:00:00.000Z"),
      confirmedAt: new Date("2026-07-29T09:00:00.000Z"),
    },
  ];

  assert.deepEqual(computeDaySummary(bookings, dayStartUtc), {
    bookingsToday: 3,
    newCustomers: 2,
    depositsAed: 175,
    tomorrowConfirmed: 2,
  });
});

test("all zero when there is nothing today or tomorrow", () => {
  const bookings = [
    {
      status: "CONFIRMED",
      isNewCustomer: true,
      depositAed: 50,
      slotAt: new Date("2026-08-05T09:00:00.000Z"),
      confirmedAt: new Date("2026-07-20T09:00:00.000Z"),
    },
  ];
  assert.deepEqual(computeDaySummary(bookings, dayStartUtc), {
    bookingsToday: 0,
    newCustomers: 0,
    depositsAed: 0,
    tomorrowConfirmed: 0,
  });
});

test("a CANCELLED booking confirmed today does not count toward bookingsToday", () => {
  const bookings = [
    {
      status: "CANCELLED",
      isNewCustomer: true,
      depositAed: 50,
      slotAt: new Date("2026-08-01T10:00:00.000Z"),
      confirmedAt: new Date("2026-08-01T02:00:00.000Z"),
    },
  ];
  assert.deepEqual(computeDaySummary(bookings, dayStartUtc), {
    bookingsToday: 0,
    newCustomers: 0,
    depositsAed: 0,
    tomorrowConfirmed: 0,
  });
});

test("a booking confirmed exactly at dayStartUtc counts (inclusive lower bound)", () => {
  const bookings = [
    {
      status: "CONFIRMED",
      isNewCustomer: false,
      depositAed: 10,
      slotAt: new Date("2026-08-01T10:00:00.000Z"),
      confirmedAt: dayStartUtc,
    },
  ];
  assert.deepEqual(computeDaySummary(bookings, dayStartUtc), {
    bookingsToday: 1,
    newCustomers: 0,
    depositsAed: 10,
    tomorrowConfirmed: 0,
  });
});

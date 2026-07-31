import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBookingAgentSystemPrompt,
  summarizeOperatingHours,
  type BookingAgentPromptContext,
} from "@/services/booking-agent/prompts";

const SALON_CTX: BookingAgentPromptContext = {
  businessType: "SALON",
  businessName: "Glow Salon Jumeirah",
  services: [
    {
      id: "svc_keratin",
      name: "Keratin Treatment",
      nameAr: "علاج الكرياتين",
      priceAed: 450,
      durationMinutes: 120,
      category: "Hair",
    },
    {
      id: "svc_mani",
      name: "Classic Manicure",
      nameAr: null,
      priceAed: 90,
      durationMinutes: 45,
      category: "Nails",
    },
  ],
  policies: {
    noShowPolicy: "Deposit is kept if you miss your appointment without 24h notice.",
    slotGranularityMinutes: 30,
  },
  hoursSummary: "Sat-Thu 09:00-21:00, Fri closed",
  depositAed: 50,
};

const HOME_CTX: BookingAgentPromptContext = {
  ...SALON_CTX,
  businessType: "HOME_SERVICES",
  businessName: "Falcon Home Fix",
  services: [
    {
      id: "svc_ac",
      name: "AC Service Call-out",
      nameAr: null,
      priceAed: 250,
      durationMinutes: 90,
      category: "Cooling",
    },
  ],
};

test("salon prompt grounds the agent in the business name, services and money", () => {
  const prompt = buildBookingAgentSystemPrompt(SALON_CTX);

  assert.ok(prompt.includes("Glow Salon Jumeirah"));
  for (const service of SALON_CTX.services) {
    assert.ok(prompt.includes(service.name), `missing service name: ${service.name}`);
    assert.ok(
      prompt.includes(`AED ${service.priceAed}`),
      `missing price for ${service.name}`
    );
    assert.ok(prompt.includes(service.id), `missing service id: ${service.id}`);
  }
  assert.ok(prompt.includes(SALON_CTX.policies.noShowPolicy!));
  assert.ok(prompt.includes("AED 50"));
  assert.ok(prompt.includes("Sat-Thu 09:00-21:00, Fri closed"));
});

test("prompt carries the hard rules verbatim", () => {
  const prompt = buildBookingAgentSystemPrompt(SALON_CTX);

  assert.ok(prompt.includes("Never change a price"));
  assert.ok(prompt.includes("never discuss Bustan's fee"));
  assert.ok(prompt.includes("escalate_to_owner"));
  assert.ok(prompt.includes("check_availability"));
  assert.ok(prompt.includes("<customer_message>"));
});

test("vertical persona lines are swapped per business type", () => {
  const salon = buildBookingAgentSystemPrompt(SALON_CTX);
  const home = buildBookingAgentSystemPrompt(HOME_CTX);

  assert.ok(salon.includes("Quote only active services and their configured AED prices."));
  assert.ok(!salon.includes("Ask for area and access details before proposing a slot."));

  assert.ok(home.includes("Ask for area and access details before proposing a slot."));
  assert.ok(!home.includes("Quote only active services and their configured AED prices."));
});

test("prompt is deterministic for identical context (prompt-cache safety)", () => {
  assert.equal(
    buildBookingAgentSystemPrompt(SALON_CTX),
    buildBookingAgentSystemPrompt(SALON_CTX)
  );
  assert.equal(
    buildBookingAgentSystemPrompt(HOME_CTX),
    buildBookingAgentSystemPrompt(HOME_CTX)
  );
});

test("missing policy text and empty service list degrade gracefully", () => {
  const prompt = buildBookingAgentSystemPrompt({
    ...SALON_CTX,
    services: [],
    policies: {},
  });
  assert.ok(prompt.includes("Glow Salon Jumeirah"));
  assert.ok(prompt.includes("escalate_to_owner"));
});

test("summarizeOperatingHours renders a compact GST week", () => {
  const summary = summarizeOperatingHours({
    timezone: "Asia/Dubai",
    schedule: [
      { dayOfWeek: 0, isClosed: false, periods: [{ open: "09:00", close: "21:00" }] },
      { dayOfWeek: 1, isClosed: false, periods: [{ open: "09:00", close: "21:00" }] },
      { dayOfWeek: 2, isClosed: false, periods: [{ open: "09:00", close: "21:00" }] },
      { dayOfWeek: 3, isClosed: false, periods: [{ open: "09:00", close: "21:00" }] },
      { dayOfWeek: 4, isClosed: false, periods: [{ open: "09:00", close: "21:00" }] },
      { dayOfWeek: 5, isClosed: true, periods: [] },
      { dayOfWeek: 6, isClosed: false, periods: [{ open: "09:00", close: "21:00" }] },
    ],
  });

  assert.ok(summary.includes("Fri closed"), summary);
  assert.ok(summary.includes("09:00-21:00"), summary);
  assert.equal(summarizeOperatingHours(null), "Hours not configured");
});

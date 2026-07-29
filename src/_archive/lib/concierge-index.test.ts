import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareMessages } from "@/lib/concierge";

const restaurant = {
  id: "rst_1",
  slug: "demo",
  name: "Demo",
  cuisineType: "Levantine",
  location: "Dubai",
  address: null,
  phone: null,
  website: null,
  whatsappNumber: null,
  operatingHours: null,
  deliverooUrl: null,
  talabatUrl: null,
  uberEatsUrl: null,
  menuSections: [],
};

test("prepareMessages drops leading assistant turns and merges adjacent roles", () => {
  const messages = prepareMessages({
    restaurant,
    channel: "whatsapp",
    message: "And fries?",
    history: [
      { role: "assistant", content: "Old answer with no preceding user" },
      { role: "user", content: "Do you have burgers?" },
      { role: "user", content: "Any chicken option?" },
      { role: "assistant", content: "Yes, chicken is available." },
      { role: "assistant", content: "It comes with sauce." },
    ],
  });

  assert.equal(messages.length, 3);
  assert.equal(messages[0].role, "user");
  assert.match(String(messages[0].content), /Do you have burgers\?/);
  assert.match(String(messages[0].content), /Any chicken option\?/);
  assert.equal(messages[1].role, "assistant");
  assert.match(String(messages[1].content), /Yes, chicken is available\./);
  assert.match(String(messages[1].content), /It comes with sauce\./);
  assert.equal(messages[2].role, "user");
  assert.match(String(messages[2].content), /And fries\?/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { prepareAgentMessages, type BookingAgentHistoryRow } from "@/services/booking-agent/agent";

const rows = (...spec: Array<[string, string | null]>): BookingAgentHistoryRow[] =>
  spec.map(([direction, body]) => ({ direction, body }));

function roles(history: BookingAgentHistoryRow[]): string[] {
  return prepareAgentMessages(history).map((message) => message.role);
}

test("history starting on an outbound row drops the leading assistant turns", () => {
  // The real trigger: lifecycle jobs (reminder, deposit nudge, confirmation)
  // write outbound rows, so a returning customer's window opens on one. The
  // Messages API 400s unless messages[0] is a user turn.
  const messages = prepareAgentMessages(
    rows(
      ["outbound", "Reminder: your appointment is tomorrow at 10:00."],
      ["outbound", "Your deposit link is still open."],
      ["inbound", "can I move it to friday?"]
    )
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.ok(String(messages[0].content).includes("can I move it to friday?"));
});

test("adjacent same-role turns are merged (WhatsApp bursts)", () => {
  const messages = prepareAgentMessages(
    rows(["inbound", "hi"], ["inbound", "are you open today"], ["inbound", "for keratin?"])
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  const content = String(messages[0].content);
  for (const part of ["hi", "are you open today", "for keratin?"]) {
    assert.ok(content.includes(part), `merged content missing: ${part}`);
  }
});

test("trailing assistant turns are dropped so the window ends on the customer", () => {
  assert.deepEqual(
    roles(
      rows(
        ["inbound", "morning"],
        ["outbound", "Good morning! How can I help?"],
        ["outbound", "Reminder: we close at 21:00."]
      )
    ),
    ["user"]
  );
});

test("normalized history strictly alternates and always starts with user", () => {
  const messages = prepareAgentMessages(
    rows(
      ["outbound", "template blast"],
      ["inbound", "hello"],
      ["inbound", "you there?"],
      ["outbound", "Yes! What can I book for you?"],
      ["outbound", "We have slots tomorrow."],
      ["inbound", "10am works"],
      ["outbound", "trailing note"]
    )
  );

  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "assistant", "user"]
  );
  for (let i = 1; i < messages.length; i += 1) {
    assert.notEqual(messages[i].role, messages[i - 1].role, `roles repeat at index ${i}`);
  }
});

test("inbound bodies are wrapped as untrusted data, outbound are not", () => {
  const messages = prepareAgentMessages(
    rows(["inbound", "book me"], ["outbound", "Sure."], ["inbound", "thanks"])
  );

  assert.ok(String(messages[0].content).startsWith("<customer_message>"));
  assert.equal(messages[1].content, "Sure.");
  assert.ok(String(messages[2].content).includes("<customer_message>thanks</customer_message>"));
});

test("empty and whitespace-only bodies are skipped, not merged as blanks", () => {
  const messages = prepareAgentMessages(
    rows(["inbound", null], ["inbound", "   "], ["inbound", "real message"])
  );

  assert.equal(messages.length, 1);
  assert.ok(String(messages[0].content).includes("real message"));
});

test("a history with no inbound rows normalizes to empty (caller stays silent)", () => {
  assert.deepEqual(prepareAgentMessages(rows(["outbound", "a"], ["outbound", "b"])), []);
  assert.deepEqual(prepareAgentMessages([]), []);
});

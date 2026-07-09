import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkInputGuardrails,
  handoffMessage,
  parseConciergeAction,
} from "@/lib/concierge/guards";
import { getConciergeMonthlyCap } from "@/lib/concierge/usage";

test("WhatsApp human requests escalate instead of using the model", () => {
  const messages = [
    "Can I speak to a manager?",
    "I need a human agent please",
    "wrong order",
    "اتكلم مع موظف",
  ];

  for (const message of messages) {
    const result = checkInputGuardrails(message, "en", "whatsapp");
    assert.equal(result.allowed, false, message);
    if (!result.allowed) {
      assert.equal(result.action, "escalate", message);
      assert.equal(result.reason, "human_request", message);
    }
  }
});

test("WhatsApp human guard does not escalate normal menu phrases", () => {
  const messages = [
    "Do you have humanely raised chicken?",
    "What is the owner's favorite dish?",
    "Is this enough food for one person?",
    "Can someone explain the mezze platter ingredients?",
  ];

  for (const message of messages) {
    const result = checkInputGuardrails(message, "en", "whatsapp");
    assert.equal(result.allowed, true, message);
  }
});

test("Arabic handoff copy is returned for Arabic escalations", () => {
  assert.equal(handoffMessage("ar"), "وصلت رسالتك للفريق، وسيردون عليك هنا قريباً.");
});

test("concierge action markers are stripped from model output", () => {
  assert.deepEqual(parseConciergeAction("[REPLY] The menu link is here."), {
    action: "reply",
    reply: "The menu link is here.",
  });
  assert.deepEqual(parseConciergeAction("[ESCALATE] I flagged this for the team."), {
    action: "escalate",
    reply: "I flagged this for the team.",
  });
});

test("concierge caps match launch defaults by tier", () => {
  assert.equal(getConciergeMonthlyCap({ subscriptionStatus: "trial" }), 200);
  assert.equal(
    getConciergeMonthlyCap({
      subscriptionStatus: "active",
      subscription: { plan: "pro" },
    }),
    1000
  );
  assert.equal(
    getConciergeMonthlyCap({
      subscriptionStatus: "active",
      subscription: { plan: "fulltime" },
    }),
    3000
  );
  assert.equal(
    getConciergeMonthlyCap({
      subscriptionStatus: "active",
      operatorAccount: { status: "active" },
    }),
    10000
  );
});

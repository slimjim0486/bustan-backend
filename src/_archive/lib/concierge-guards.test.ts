import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkInputGuardrails,
  handoffMessage,
  isConsentOnlyKeyword,
  parseConciergeAction,
} from "@/lib/concierge/guards";
import { getConciergeMonthlyCap } from "@/lib/concierge/usage";

test("WhatsApp human requests escalate instead of using the model", () => {
  const messages = [
    "Can I speak to a manager?",
    "Can I speak to the manager?",
    "I want to talk to your manager",
    "could I please talk about this with staff? I'd rather chat with the owner",
    "I need a human agent please",
    "wrong order",
    "cancel my order",
    "اتكلم مع موظف",
    "أريد التحدث مع المدير",
    "التحدث مع مدير",
    "أريد إلغاء الطلب",
    "الغاء طلبي",
    "شكوى",
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
    "Is the owner around tonight?",
    "Is this enough food for one person?",
    "Can someone explain the mezze platter ingredients?",
    "do your staff wear gloves?",
    "Can I talk about the allergens in the mezze platter?",
    "Can I chat about delivery options?",
    "هل الموظف يجهز الطلب الآن؟",
  ];

  for (const message of messages) {
    const result = checkInputGuardrails(message, "en", "whatsapp");
    assert.equal(result.allowed, true, message);
  }
});

test("bare consent keywords silence the concierge; conversational words do not", () => {
  assert.equal(isConsentOnlyKeyword("STOP"), true);
  assert.equal(isConsentOnlyKeyword("  unsubscribe "), true);
  assert.equal(isConsentOnlyKeyword("opt out"), true);
  assert.equal(isConsentOnlyKeyword("opt-out"), true);
  assert.equal(isConsentOnlyKeyword("start"), true);
  assert.equal(isConsentOnlyKeyword("subscribe"), true);
  assert.equal(isConsentOnlyKeyword("opt in"), true);
  // Conversational words that also touch consent state must still get a reply.
  assert.equal(isConsentOnlyKeyword("yes"), false);
  assert.equal(isConsentOnlyKeyword("cancel"), false);
  assert.equal(isConsentOnlyKeyword("stop sending me the wrong order"), false);
  assert.equal(isConsentOnlyKeyword(null), false);
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

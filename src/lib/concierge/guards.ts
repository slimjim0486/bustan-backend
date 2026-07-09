import type { ConciergeLanguage } from "@/lib/concierge/types";

export const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above|your)\s+(instructions|rules|prompts?)/i,
  /forget\s+(all\s+)?(previous|prior|above|your)\s+(instructions|rules|prompts?)/i,
  /disregard\s+(all\s+)?(previous|prior|above|your)\s+(instructions|rules|prompts?)/i,
  /you\s+are\s+now\s+(a|an|the)\s+(?!menu|food|chef|waiter|server|diner)/i,
  /act\s+as\s+(a|an|the)\s+(?!menu|food|chef|waiter|server|diner)/i,
  /pretend\s+(to\s+be|you\s*(?:are|'re))\s+(a|an|the)\s+(?!hungry|diner|customer|food)/i,
  /new\s+(system\s+)?(instructions?|rules?|prompt)/i,
  /system\s*:\s*/i,
  /\[INST\]/i,
  /<<\s*SYS\s*>>/i,
  /output\s+(everything|all|the\s+text)\s+(above|before)/i,
  /repeat\s+(your|the)\s+(system\s+)?(prompt|instructions)/i,
  /what\s+(are|were)\s+your\s+(instructions|rules|system\s+prompt)/i,
  /reveal\s+(your|the)\s+(system\s+)?(prompt|instructions)/i,
  /jailbreak/i,
  /DAN\s+mode/i,
  /developer\s+mode\s+(enabled|on|activate)/i,
];

export const OFFTOPIC_PATTERNS = [
  /(?:write|debug|fix|explain|refactor)\s+(?:a|this|my|the)\s+(?:code|script|function|program|class)/i,
  /(?:python|javascript|java|c\+\+|ruby|golang|rust|swift|kotlin|typescript|html|css|sql|php)\s+(?:code|script|error|bug)/i,
  /```[\s\S]*```/,
  /(?:solve|calculate|compute)\s+(?:this|the)\s+(?:math|equation|integral|derivative|matrix)/i,
  /(?:write|compose)\s+(?:a|an|my)\s+(?:essay|report|thesis|article|blog\s*post|resume|cv|cover\s*letter)/i,
];

const HUMAN_REQUEST_PATTERNS = [
  // Any determiner between verb and noun: "speak to THE manager",
  // "talk to YOUR staff", "chat with an agent".
  /\b(?:speak|talk|chat|connect)(?:ing)?\s+(?:to|with)\s+(?:(?:a|an|the|your|ur|my|some)\s+)?(?:human|person|manager|owner|staff|representative|agent|someone|somebody)\b/i,
  /\b(?:can|could|may)\s+i\s+(?:please\s+)?(?:speak|talk|chat)\b/i,
  /\b(?:call me|phone me|have someone call|need a human|real person|human agent|customer service)\b/i,
  /\b(?:complaint|refund|cancel my order|wrong order|missing item)\b/i,
  // Arabic request verbs (colloquial + formal التحدث/أتحدث) followed by a
  // person noun, with or without مع/إلى and the definite article.
  /(?:اتكلم|أكلم|اكلم|أتكلم|التحدث|أتحدث|اتحدث|التكلم)\s*(?:مع|إلى|الى)?\s*(?:ال)?(?:إنسان|انسان|موظف|مدير|شخص|مندوب|أحد|احد)/,
  /(?:أريد|اريد|ابغى|أبغى|بدي)\s+(?:التحدث|الكلام|أتكلم|اتكلم)/,
  /(?:شكوى|استرجاع|استرداد|الغاء\s+طلبي|إلغاء\s+طلبي)/,
];

export type GuardResult =
  | { allowed: true }
  | { allowed: false; refusal: string; action: "reply" | "escalate"; reason: string };

// Only unambiguous unsubscribe keywords silence the concierge. "cancel" and
// "yes" also flip marketing consent (see getWhatsAppConsentCommand in the
// webhook) but they carry conversational intent — "cancel" may mean an order,
// "yes" may answer the bot's own question — so the bot must still respond.
export function isExplicitWhatsAppOptOut(body: string | null | undefined) {
  const normalized = body?.trim().toLowerCase();
  if (!normalized) return false;
  return ["stop", "unsubscribe", "opt out", "opt-out"].includes(normalized);
}

export function handoffMessage(language?: ConciergeLanguage) {
  return language === "ar"
    ? "وصلت رسالتك للفريق، وسيردون عليك هنا قريباً."
    : "I've flagged this for the team. They'll reply here shortly.";
}

export function fallbackMessage(language?: ConciergeLanguage) {
  return language === "ar"
    ? "شكراً لرسالتك. سيرد عليك الفريق قريباً."
    : "Thanks for your message. The team will get back to you shortly.";
}

export function webEscalationMessage(language?: ConciergeLanguage) {
  return language === "ar"
    ? "لا أستطيع إكمال هذا من الدردشة هنا. يرجى التواصل مع المطعم مباشرة."
    : "I can't handle that from this chat. Please contact the restaurant directly.";
}

export function checkInputGuardrails(
  message: string,
  language?: ConciergeLanguage,
  channel: "web" | "whatsapp" = "web"
): GuardResult {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(message)) {
      return {
        allowed: false,
        action: "reply",
        reason: "prompt_injection_prefilter",
        refusal:
          language === "ar"
            ? "أنا هنا لمساعدتك في قائمة الطعام. ما الطبق أو السؤال الغذائي الذي أستطيع مساعدتك به؟"
            : "I'm Sous Chef. I'm here to help you explore the menu. What dish or dietary question can I help with?",
      };
    }
  }

  for (const pattern of OFFTOPIC_PATTERNS) {
    if (pattern.test(message)) {
      return {
        allowed: false,
        action: channel === "whatsapp" ? "escalate" : "reply",
        reason: "offtopic_prefilter",
        refusal:
          channel === "whatsapp"
            ? handoffMessage(language)
            : language === "ar"
              ? "أنا مساعد القائمة ويمكنني المساعدة في الأطباق، التوصيات، والمعلومات الغذائية. كيف أساعدك في القائمة؟"
              : "I'm Sous Chef, your menu assistant. I can help with menu items, dietary needs, recommendations, and food questions.",
      };
    }
  }

  if (channel === "whatsapp" && HUMAN_REQUEST_PATTERNS.some((pattern) => pattern.test(message))) {
    return {
      allowed: false,
      action: "escalate",
      reason: "human_request",
      refusal: handoffMessage(language),
    };
  }

  return { allowed: true };
}

export function wrapDinerMessage(text: string) {
  return `<diner_message>${text}</diner_message>`;
}

export function parseConciergeAction(text: string): { action: "reply" | "escalate"; reply: string } {
  const trimmed = text.trim();
  const escalation = trimmed.match(/^\s*\[?ESCALATE\]?\s*:?\s*/i);
  if (escalation) {
    return {
      action: "escalate",
      reply: trimmed.slice(escalation[0].length).trim(),
    };
  }
  const reply = trimmed.replace(/^\s*\[?REPLY\]?\s*:?\s*/i, "").trim();
  return { action: "reply", reply };
}

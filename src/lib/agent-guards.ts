// Shared prompt-injection guard for LLM agents that read untrusted text.
//
// Lifted verbatim from services/coworker/agent.ts (Phase 4 / Task 11) so the
// customer-facing booking agent and the owner-facing coworker agent share ONE
// pattern list. Pure move — the patterns and the refusal string are byte-for-
// byte what coworker/agent.ts carried, so coworker behaviour is unchanged.
//
// NOTE: routes/owner-chat.ts keeps its own, WIDER list (it also blocks
// prompt-exfiltration phrasings and DAN/developer-mode). Folding that one in
// would CHANGE coworker + booking behaviour, so it is deliberately left alone;
// widening this list is a separate, deliberate decision.

import { OWNER_AGENT } from "@/lib/owner-agent-identity";

export const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above|your)\s+(instructions|rules|prompts?)/i,
  /forget\s+(all\s+)?(previous|prior|above|your)\s+(instructions|rules|prompts?)/i,
  /disregard\s+(all\s+)?(previous|prior|above|your)\s+(instructions|rules|prompts?)/i,
  /new\s+(system\s+)?(instructions?|rules?|prompt)/i,
  /system\s*:\s*/i,
  /\[INST\]/i,
  /<<\s*SYS\s*>>/i,
  /jailbreak/i,
];

/** True when the text looks like a prompt-injection attempt. Channel-agnostic —
 *  callers decide what to do about it (refuse, escalate, drop). */
export function matchesInjection(message: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(message));
}

/** Owner-facing variant: returns Bustan's refusal line on a hit, else null.
 *  Kept here (rather than at the call site) so coworker/agent.ts is a pure
 *  import swap. */
export function checkInjection(message: string): string | null {
  return matchesInjection(message) ? OWNER_AGENT.injectionRefusal : null;
}

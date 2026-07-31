// Pure dispatch gate for the customer-facing booking agent (Phase 4 / Task 12).
//
// Called twice per inbound message: once at webhook time (fast path, may see
// stale conversation state) and once again inside the reply-queue worker
// right before the agent turn runs (fresh state — the owner may have paused
// the bot, disabled it, or the businessType may have changed in between).
//
// Kept pure and total so it's exhaustively table-testable without touching
// Prisma or the queue.

/** Business types the booking agent is allowed to answer for. RESTAURANT
 *  tenants have no services/bookings surface (see agent.ts). */
const DISPATCHABLE_BUSINESS_TYPES = new Set(["SALON", "HOME_SERVICES"]);

export interface ShouldDispatchBookingAgentInput {
  businessType: string;
  agentAutonomyOptIn: boolean;
  botDisabled: boolean;
  botPausedUntil: Date | null;
  messageType: string;
  duplicate: boolean;
  consentCommand: string | null;
  now: Date;
}

export function shouldDispatchBookingAgent(input: ShouldDispatchBookingAgentInput): boolean {
  if (!DISPATCHABLE_BUSINESS_TYPES.has(input.businessType)) return false;
  if (!input.agentAutonomyOptIn) return false;
  if (input.botDisabled) return false;
  if (input.botPausedUntil && input.botPausedUntil.getTime() >= input.now.getTime()) return false;
  if (input.messageType !== "text") return false;
  if (input.duplicate) return false;
  if (input.consentCommand !== null) return false;
  return true;
}

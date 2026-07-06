/**
 * B1b: owner notification for auto-executed actions.
 *
 * v1 scope (decided during planning): the in-app Activity Feed's
 * "about to ship · Undo" row is the primary notify+undo surface. A direct
 * out-of-app WhatsApp ping is a documented fast-follow — deliberately NOT
 * wired to the whisper generator, which runs an LLM daily-briefing job (wrong
 * content + cost per action). This module is the seam where that non-LLM ping
 * will land.
 */

/**
 * Pure: should a high-impact auto-action ping the owner out-of-app? Reversible
 * edits rely on the in-app feed only.
 */
export function shouldPingOwner(highImpact: boolean): boolean {
  return highImpact;
}

export async function notifyOwnerAutoAction(args: {
  restaurantId: string;
  toolName: string;
  draftId: string;
  highImpact: boolean;
}): Promise<void> {
  if (!shouldPingOwner(args.highImpact)) return;
  // Out-of-app ping is a documented fast-follow (non-LLM WhatsApp send within
  // the 24h service window). Intentionally a no-op for v1 — the in-app Activity
  // Feed covers notify+undo. Kept as the stable wiring seam for callers.
}

import { createHash } from "node:crypto";

export type AgentChannel = "owner_whatsapp" | "dashboard_chat" | "diner_public" | "system_cron";

/** Deterministically sort object keys so equal args → equal digest. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = canonicalize((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
}

export function deriveIdempotencyKey(input: {
  restaurantId: string;
  toolName: string;
  args: unknown;
  scope: string;
}): string {
  const payload = JSON.stringify({
    r: input.restaurantId,
    t: input.toolName,
    a: canonicalize(input.args),
    s: input.scope,
  });
  return createHash("sha256").update(payload).digest("hex");
}

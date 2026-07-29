import type Anthropic from "@anthropic-ai/sdk";
import type { PlanEntitlements } from "@/lib/entitlements";
import { prisma } from "@/lib/prisma";
import type { AgentChannel } from "@/services/agent/idempotency";

export interface ToolResult {
  content: string;
  preview?: {
    pendingActionId: string;
    description: string;
    changes: Array<{ label: string; before: string | null; after: string }>;
  };
  draftId?: string;
}

export const OWNER_TOOLS: Anthropic.Tool[] = [
  {
    name: "get_business_snapshot",
    description:
      "Get the business profile and current WhatsApp customer/inquiry counts.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
];

export const PHASE2_TOOL_NAMES = new Set<string>();

export function getOwnerTools(_phase2Enabled: boolean): Anthropic.Tool[] {
  return OWNER_TOOLS;
}

export async function executeTool(
  toolName: string,
  restaurantId: string,
  clerkId: string,
  _entitlements: PlanEntitlements,
  _input: Record<string, unknown>,
  _options: { channel?: AgentChannel; idempotencyScope?: string } = {}
): Promise<ToolResult> {
  if (toolName !== "get_business_snapshot") {
    return {
      content: JSON.stringify({
        error: `Tool ${toolName} belongs to the archived restaurant product.`,
      }),
    };
  }

  const restaurant = await prisma.restaurant.findFirst({
    where: { id: restaurantId, owner: { clerkId } },
    select: {
      id: true,
      name: true,
      location: true,
      _count: {
        select: {
          customers: true,
          whatsappConversations: true,
        },
      },
    },
  });

  if (!restaurant) {
    return { content: JSON.stringify({ error: "Business not found" }) };
  }

  return {
    content: JSON.stringify({
      business: {
        id: restaurant.id,
        name: restaurant.name,
        area: restaurant.location,
      },
      customers: restaurant._count.customers,
      whatsappInquiries: restaurant._count.whatsappConversations,
    }),
  };
}

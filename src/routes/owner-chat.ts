import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { z } from "zod";
import { getRestaurantEntitlements } from "@/lib/entitlements";
import { checkAiLimit, getAiUsageSummary, logAiUsage } from "@/lib/ai-usage";
import { env } from "@/lib/env";
import { ApiError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { buildOwnerSystemPrompt } from "@/lib/owner-chat-prompts";
import { prisma } from "@/lib/prisma";
import { assertRateLimit } from "@/lib/public-request-guards";
import { requireAuth } from "@/middleware/auth";
import { createSousChefMessage } from "@/services/anthropic-models";
import { OWNER_TOOLS, executeTool } from "@/services/owner-chat-tools";
import { enqueueExtractionForRestaurant } from "@/queue/owner-chat-memory";
import { enqueueWhisperForRestaurant } from "@/queue/owner-whisper";

// ── Schema ─────────────────────────────────────────────────────

const ownerChatSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  // Optional optimistic history; server is source of truth via DB thread
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1).max(4000),
      })
    )
    .max(30)
    .optional(),
});

const THREAD_HISTORY_LIMIT = 30;

// ── Anthropic client ───────────────────────────────────────────

let anthropic: Anthropic | null = null;

function getClient() {
  if (!env.ANTHROPIC_API_KEY) {
    throw new ApiError("AI assistant is not configured", 503);
  }

  if (!anthropic) {
    anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }

  return anthropic;
}

// ── SSE helpers ────────────────────────────────────────────────

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ── Persistence hygiene ───────────────────────────────────────

function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 4) {
    return "[redacted]";
  }
  return `***${digits.slice(-4)}`;
}

function scrubPersistedToolJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(scrubPersistedToolJson);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, raw]) => {
      const normalized = key.toLowerCase();
      if (typeof raw === "string") {
        if (normalized.includes("phone")) {
          return [key, maskPhone(raw)];
        }
        if (normalized === "name" || normalized.includes("displayname") || normalized.includes("customername")) {
          return [key, "[redacted]"];
        }
      }
      return [key, scrubPersistedToolJson(raw)];
    })
  );
}

function scrubPersistedToolResult(
  result: Anthropic.ToolResultBlockParam
): Anthropic.ToolResultBlockParam {
  if (typeof result.content !== "string") {
    return result;
  }

  try {
    return {
      ...result,
      content: JSON.stringify(scrubPersistedToolJson(JSON.parse(result.content))),
    };
  } catch {
    return result;
  }
}

function assertOwnerChatEndpointRateLimit(options: {
  action: string;
  clerkId: string;
  restaurantId: string;
  userLimit?: number;
  restaurantLimit?: number;
  windowMs?: number;
}) {
  const windowMs = options.windowMs ?? 10 * 60_000;
  assertRateLimit({
    key: `owner-chat:${options.action}:user:${options.clerkId}`,
    limit: options.userLimit ?? 120,
    windowMs,
  });
  assertRateLimit({
    key: `owner-chat:${options.action}:restaurant:${options.restaurantId}`,
    limit: options.restaurantLimit ?? 120,
    windowMs,
  });
}

// ── Input guardrails ──────────────────────────────────────────

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above|your)\s+(instructions|rules|prompts?)/i,
  /forget\s+(all\s+)?(previous|prior|above|your)\s+(instructions|rules|prompts?)/i,
  /disregard\s+(all\s+)?(previous|prior|above|your)\s+(instructions|rules|prompts?)/i,
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

const INJECTION_REFUSAL =
  "I'm Sous Chef, your restaurant assistant! How can I help you manage your restaurant today?";

function checkInjection(message: string): string | null {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(message)) {
      return INJECTION_REFUSAL;
    }
  }
  return null;
}

// ── Ownership check ────────────────────────────────────────────

async function loadOwnedRestaurant(restaurantId: string, clerkId: string) {
  const restaurant = await prisma.restaurant.findFirst({
    where: {
      id: restaurantId,
      owner: { clerkId },
    },
    include: {
      subscription: true,
      operatorAccount: {
        include: { _count: { select: { brands: true } } },
      },
      _count: {
        select: {
          menuSections: true,
        },
      },
    },
  });

  if (!restaurant) {
    throw new ApiError("Restaurant not found", 404);
  }

  return restaurant;
}

// ── Route ──────────────────────────────────────────────────────

const MAX_TOOL_ITERATIONS = 8;

export const ownerChatRoute = new Hono<{
  Variables: {
    auth: { clerkId: string; email: string | null };
  };
}>()
  // ── GET /:restaurantId/thread — hydrate dock on mount ──
  .get("/:restaurantId/thread", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const restaurantId = c.req.param("restaurantId");
      assertOwnerChatEndpointRateLimit({
        action: "thread",
        clerkId: auth.clerkId,
        restaurantId,
        userLimit: 180,
        restaurantLimit: 180,
      });
      const limitRaw = c.req.query("limit");
      const limit = Math.min(
        Math.max(1, Number.parseInt(limitRaw ?? `${THREAD_HISTORY_LIMIT}`, 10) || THREAD_HISTORY_LIMIT),
        100
      );

      await loadOwnedRestaurant(restaurantId, auth.clerkId);

      const rows = await prisma.ownerChatMessage.findMany({
        where: { restaurantId, role: { in: ["user", "assistant"] } },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          role: true,
          content: true,
          source: true,
          whisperId: true,
          createdAt: true,
        },
      });

      return c.json({
        messages: rows.reverse().map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          source: m.source,
          whisperId: m.whisperId,
          createdAt: m.createdAt.toISOString(),
        })),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  // ── POST /:restaurantId/extract-memory — trigger nightly extraction on demand
  .post("/:restaurantId/extract-memory", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const restaurantId = c.req.param("restaurantId");
      assertOwnerChatEndpointRateLimit({
        action: "memories-list",
        clerkId: auth.clerkId,
        restaurantId,
        userLimit: 60,
        restaurantLimit: 60,
      });
      await loadOwnedRestaurant(restaurantId, auth.clerkId);
      assertRateLimit({
        key: `owner-chat:extract-memory:restaurant:${restaurantId}`,
        limit: 3,
        windowMs: 60 * 60_000,
      });
      assertRateLimit({
        key: `owner-chat:extract-memory:user:${auth.clerkId}`,
        limit: 6,
        windowMs: 60 * 60_000,
      });
      await enqueueExtractionForRestaurant(restaurantId);
      return c.json({ ok: true, queued: true });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  // ── GET /:restaurantId/memories — list extracted memories (for settings UI / debugging)
  .get("/:restaurantId/memories", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const restaurantId = c.req.param("restaurantId");
      await loadOwnedRestaurant(restaurantId, auth.clerkId);

      const rows = await prisma.ownerChatMemory.findMany({
        where: { restaurantId },
        orderBy: [{ lastReinforced: "desc" }, { confidence: "desc" }],
        take: 100,
        select: {
          id: true,
          type: true,
          content: true,
          confidence: true,
          tags: true,
          reinforceCount: true,
          lastReinforced: true,
          createdAt: true,
        },
      });

      return c.json({
        memories: rows.map((m) => ({
          ...m,
          lastReinforced: m.lastReinforced.toISOString(),
          createdAt: m.createdAt.toISOString(),
        })),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  // ── DELETE /:restaurantId/memories/:memoryId — owner can prune a memory
  .delete("/:restaurantId/memories/:memoryId", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const restaurantId = c.req.param("restaurantId");
      const memoryId = c.req.param("memoryId");
      assertOwnerChatEndpointRateLimit({
        action: "memories-delete",
        clerkId: auth.clerkId,
        restaurantId,
        userLimit: 30,
        restaurantLimit: 30,
      });
      await loadOwnedRestaurant(restaurantId, auth.clerkId);

      const result = await prisma.ownerChatMemory.deleteMany({
        where: { id: memoryId, restaurantId },
      });

      if (result.count === 0) {
        throw new ApiError("Memory not found", 404);
      }
      return c.json({ ok: true });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  // ── GET /:restaurantId/unread — dock badge driver
  .get("/:restaurantId/unread", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const restaurantId = c.req.param("restaurantId");
      assertOwnerChatEndpointRateLimit({
        action: "unread",
        clerkId: auth.clerkId,
        restaurantId,
        userLimit: 240,
        restaurantLimit: 240,
      });
      await loadOwnedRestaurant(restaurantId, auth.clerkId);

      const latest = await prisma.ownerWhisper.findFirst({
        where: { restaurantId },
        orderBy: { generatedAt: "desc" },
        select: {
          id: true,
          content: true,
          status: true,
          generatedAt: true,
          forDate: true,
        },
      });

      return c.json({
        hasUnreadWhisper: latest?.status === "unread",
        latestWhisper: latest
          ? {
              id: latest.id,
              content: latest.content,
              status: latest.status,
              generatedAt: latest.generatedAt.toISOString(),
              forDate: latest.forDate.toISOString().slice(0, 10),
            }
          : null,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  // ── PATCH /:restaurantId/whisper/:whisperId/read — mark a whisper read
  .patch("/:restaurantId/whisper/:whisperId/read", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const restaurantId = c.req.param("restaurantId");
      const whisperId = c.req.param("whisperId");
      assertOwnerChatEndpointRateLimit({
        action: "whisper-read",
        clerkId: auth.clerkId,
        restaurantId,
        userLimit: 120,
        restaurantLimit: 120,
      });
      await loadOwnedRestaurant(restaurantId, auth.clerkId);

      const result = await prisma.ownerWhisper.updateMany({
        where: { id: whisperId, restaurantId, status: "unread" },
        data: { status: "read", readAt: new Date() },
      });

      return c.json({ ok: true, updated: result.count });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  // ── POST /:restaurantId/whisper/generate-now — manual trigger for testing
  .post("/:restaurantId/whisper/generate-now", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const restaurantId = c.req.param("restaurantId");
      const body = (await c.req.json().catch(() => ({}))) as { forDate?: string };
      await loadOwnedRestaurant(restaurantId, auth.clerkId);
      assertRateLimit({
        key: `owner-chat:whisper-generate:restaurant:${restaurantId}`,
        limit: 2,
        windowMs: 60 * 60_000,
      });
      assertRateLimit({
        key: `owner-chat:whisper-generate:user:${auth.clerkId}`,
        limit: 4,
        windowMs: 60 * 60_000,
      });
      await enqueueWhisperForRestaurant(restaurantId, body.forDate);
      return c.json({ ok: true, queued: true });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  // ── POST /:restaurantId — send message, stream response ──
  .post("/:restaurantId", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const restaurantId = c.req.param("restaurantId");

      // Rate limits
      assertRateLimit({
        key: `owner-chat:restaurant:${restaurantId}`,
        limit: 60,
        windowMs: 10 * 60_000,
      });
      assertRateLimit({
        key: `owner-chat:user:${auth.clerkId}`,
        limit: 120,
        windowMs: 10 * 60_000,
      });

      const data = ownerChatSchema.parse(await c.req.json());

      // Input guardrail
      const refusal = checkInjection(data.message);
      if (refusal) {
        c.header("Content-Type", "text/event-stream");
        c.header("Cache-Control", "no-cache");
        c.header("Connection", "keep-alive");

        const body = sseEvent("text", { delta: refusal }) + sseEvent("done", {});
        return c.body(body);
      }

      const restaurant = await loadOwnedRestaurant(restaurantId, auth.clerkId);
      const entitlements = getRestaurantEntitlements(restaurant);

      // Entitlement gate: require Pro or Portfolio
      if (!entitlements.menuAssistantEnabled) {
        throw new ApiError(
          "Sous Chef is available on Pro and Portfolio plans. Upgrade to unlock your AI assistant.",
          403
        );
      }

      const ownerChatLimit = await checkAiLimit(
        restaurantId,
        "owner_chat",
        entitlements.ownerChatMonthlyTurnLimit
      );
      if (!ownerChatLimit.allowed) {
        throw new ApiError(
          `Owner chat limit reached (${ownerChatLimit.used}/${entitlements.ownerChatMonthlyTurnLimit} this month).`,
          403
        );
      }

      // Get menu item count for context
      const totalItems = await prisma.menuItem.count({ where: { restaurantId } });

      // Get AI usage for context
      const [descUsage, tagUsage, analysisUsage, imageUsage] = await Promise.all([
        getAiUsageSummary(restaurantId, "description_enhance"),
        getAiUsageSummary(restaurantId, "tag_analysis"),
        getAiUsageSummary(restaurantId, "menu_analysis"),
        getAiUsageSummary(restaurantId, "image_enhancement"),
      ]);

      // Load long-term memories for personalization
      const memoryRows = await prisma.ownerChatMemory.findMany({
        where: {
          restaurantId,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        orderBy: [{ lastReinforced: "desc" }, { confidence: "desc" }],
        take: 20,
        select: { type: true, content: true },
      });

      const systemPrompt = buildOwnerSystemPrompt(
        {
          id: restaurant.id,
          name: restaurant.name,
          slug: restaurant.slug,
          cuisineType: restaurant.cuisineType,
          location: restaurant.location,
          isPublished: restaurant.isPublished,
          description: restaurant.description,
          plan: entitlements.plan,
          totalSections: restaurant._count.menuSections,
          totalItems,
        },
        entitlements,
        {
          descriptions: { used: descUsage.used, limit: entitlements.aiDescriptionLimit },
          tags: { used: tagUsage.used, limit: entitlements.aiTagAnalysisLimit },
          analysis: { used: analysisUsage.used, limit: entitlements.analysisLimit },
          images: { used: imageUsage.used, limit: entitlements.imageEnhancementLimit },
        },
        memoryRows
      );

      // Load persisted thread (server is source of truth, fall back to client history if provided)
      const persistedRows = await prisma.ownerChatMessage.findMany({
        where: {
          restaurantId,
          role: { in: ["user", "assistant"] },
        },
        orderBy: { createdAt: "desc" },
        take: THREAD_HISTORY_LIMIT,
        select: { role: true, content: true },
      });
      const persistedHistory = persistedRows.reverse();

      // Build messages with injection delimiter
      const wrapOwnerMessage = (text: string) => `<owner_message>${text}</owner_message>`;

      const messages: Anthropic.MessageParam[] = [
        ...persistedHistory.map((msg) => ({
          role: msg.role as "user" | "assistant",
          content: msg.role === "user" ? wrapOwnerMessage(msg.content) : msg.content,
        })),
        { role: "user" as const, content: wrapOwnerMessage(data.message) },
      ];

      const client = getClient();
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let accumulatedText = "";
      const accumulatedToolCalls: Anthropic.ToolUseBlock[] = [];
      const accumulatedToolResults: Anthropic.ToolResultBlockParam[] = [];

      // Stream via ReadableStream
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();

          function emit(event: string, data: unknown) {
            controller.enqueue(encoder.encode(sseEvent(event, data)));
          }

          let iterations = 0;

          try {
            while (iterations <= MAX_TOOL_ITERATIONS) {
              const response = await createSousChefMessage(client, {
                max_tokens: 1024,
                system: systemPrompt,
                tools: OWNER_TOOLS,
                messages,
              }, {
                route: "owner-chat",
                restaurantId,
                clerkId: auth.clerkId,
                iteration: iterations,
              });

              totalInputTokens += response.usage.input_tokens;
              totalOutputTokens += response.usage.output_tokens;

              // Stream text blocks
              for (const block of response.content) {
                if (block.type === "text" && block.text.trim()) {
                  emit("text", { delta: block.text });
                  accumulatedText += block.text;
                }
              }

              // If done (no tool calls), break
              if (response.stop_reason === "end_turn" || response.stop_reason === "max_tokens") {
                break;
              }

              // Extract tool use blocks
              const toolUseBlocks = response.content.filter(
                (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
              );

              if (toolUseBlocks.length === 0) {
                break;
              }

              // Add assistant response to messages
              messages.push({ role: "assistant", content: response.content });
              accumulatedToolCalls.push(...toolUseBlocks);

              // Execute tools and build results
              const toolResults: Anthropic.ToolResultBlockParam[] = [];

              for (const block of toolUseBlocks) {
                emit("tool_start", { tool: block.name, id: block.id });

                const result = await executeTool(
                  block.name,
                  restaurantId,
                  auth.clerkId,
                  entitlements,
                  block.input as Record<string, unknown>
                );

                // If there's a preview, emit it
                if (result.preview) {
                  emit("preview", result.preview);
                }

                // Sous Chef Inbox: a draftId means the action was persisted as
                // a card and the chat client should render a "view in Inbox" pill
                // instead of the old inline approve/reject buttons.
                if (result.draftId) {
                  emit("draft", { draftId: result.draftId, tool: block.name });
                }

                toolResults.push({
                  type: "tool_result" as const,
                  tool_use_id: block.id,
                  content: result.content,
                });

                emit("tool_done", { tool: block.name, id: block.id });
              }

              // Add tool results as user message
              messages.push({ role: "user", content: toolResults });
              accumulatedToolResults.push(...toolResults);

              iterations++;
            }

            emit("done", {});
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "An error occurred";
            console.error("[owner-chat] stream failed", {
              restaurantId,
              clerkId: auth.clerkId,
              iterations,
              totalInputTokens,
              totalOutputTokens,
              message,
              error,
            });
            emit("error", { message });
          } finally {
            // Persist the user + assistant turn together only when we have an
            // assistant response, avoiding orphan questions after model failure.
            if (accumulatedText.trim()) {
              const toolCallsJson =
                accumulatedToolCalls.length > 0
                  ? (JSON.parse(JSON.stringify(accumulatedToolCalls)) as object)
                  : undefined;
              const toolResultsJson =
                accumulatedToolResults.length > 0
                  ? (JSON.parse(
                      JSON.stringify(
                        accumulatedToolResults.map(scrubPersistedToolResult)
                      )
                    ) as object)
                  : undefined;
              try {
                await prisma.$transaction([
                  prisma.ownerChatMessage.create({
                    data: {
                      restaurantId,
                      role: "user",
                      content: data.message,
                      authorUserId: auth.clerkId,
                      source: "chat",
                    },
                  }),
                  prisma.ownerChatMessage.create({
                    data: {
                      restaurantId,
                      role: "assistant",
                      content: accumulatedText,
                      toolCalls: toolCallsJson,
                      toolResults: toolResultsJson,
                      source: "chat",
                    },
                  }),
                ]);
              } catch (err) {
                console.error("Failed to persist owner chat turn:", err);
              }
            }

            // Log usage
            if (totalInputTokens > 0 || totalOutputTokens > 0) {
              try {
                await logAiUsage(
                  restaurantId,
                  "owner_chat",
                  totalInputTokens,
                  totalOutputTokens
                );
              } catch (err) {
                console.error("Failed to log owner chat usage:", err);
              }
            }

            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    } catch (error) {
      // For non-streaming errors (auth, validation, etc.)
      return errorResponse(c, error);
    }
  });

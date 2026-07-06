import { Hono, type Context } from "hono";
import { z } from "zod";
import { ApiError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { assertRateLimit } from "@/lib/public-request-guards";
import { requireAdmin, requireAuth } from "@/middleware/auth";
import {
  calculateSupportPriority,
  effectiveSeverity,
  findFaqMatches,
  mirrorSupportUpdateToOwnerChat,
  serializeSupportArticle,
  serializeSupportTicket,
  supportTicketInclude,
  supportTicketListInclude,
  uniqueSupportArticleSlug,
} from "@/services/support";

const ticketStatusValues = ["open", "in_progress", "waiting_on_customer", "resolved", "closed"] as const;
const ticketPriorityValues = ["urgent", "high", "normal", "low"] as const;
const ticketSeverityValues = ["sev1", "sev2", "sev3", "sev4"] as const;
const planValues = ["starter", "pro", "fulltime", "portfolio"] as const;
const MINUTE = 60_000;

const ticketStatusSchema = z.object({
  status: z.enum(ticketStatusValues),
  resolutionSummary: z.string().trim().max(2000).optional(),
});

const ticketPrioritySchema = z.object({
  severity: z.enum(ticketSeverityValues).optional(),
  priority: z.enum(ticketPriorityValues).optional(),
  priorityScore: z.number().int().min(0).max(200).optional(),
});

const replySchema = z.object({
  body: z.string().trim().min(1).max(5000),
  isInternal: z.boolean().default(false),
  status: z.enum(ticketStatusValues).optional(),
});

const assignSchema = z.object({
  assignedAdminUserId: z.string().nullable(),
});

const articleSchema = z.object({
  title: z.string().trim().min(3).max(160),
  question: z.string().trim().min(3).max(1000),
  answer: z.string().trim().min(3).max(6000),
  category: z.string().trim().max(80).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  isPublished: z.boolean().default(false),
});

const ticketListQuerySchema = z.object({
  status: z.enum(ticketStatusValues).optional(),
  priority: z.enum(ticketPriorityValues).optional(),
  severity: z.enum(ticketSeverityValues).optional(),
  plan: z.enum(planValues).optional(),
});

const usersQuerySchema = z.object({
  role: z.enum(["admin", "restaurant_owner"]).optional(),
});

function setNoStoreHeaders(c: Context) {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
}

const adminRouteBase = new Hono<{
  Variables: {
    auth: { clerkId: string; email: string | null; fullName: string | null };
    admin: {
      clerkId: string;
      email: string | null;
      fullName: string | null;
      user: { id: string; email: string; fullName: string | null; role: string };
    };
  };
}>();

adminRouteBase.use("*", requireAuth, requireAdmin);
adminRouteBase.use("*", async (c, next) => {
  setNoStoreHeaders(c);
  const admin = c.get("admin").user;
  assertRateLimit({
    key: `admin:api:user:${admin.id}`,
    limit: 600,
    windowMs: 10 * MINUTE,
  });
  if (c.req.method !== "GET") {
    assertRateLimit({
      key: `admin:api:write:user:${admin.id}`,
      limit: 120,
      windowMs: 10 * MINUTE,
    });
  }
  await next();
});

export const adminRoute = adminRouteBase
  .get("/overview", async (c) => {
    try {
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const [
        users,
        restaurants,
        openTickets,
        urgentTickets,
        staleTickets,
        recentAiUsage,
        subscriptions,
      ] = await Promise.all([
        prisma.user.count(),
        prisma.restaurant.count(),
        prisma.supportTicket.count({ where: { status: { in: ["open", "in_progress", "waiting_on_customer"] } } }),
        prisma.supportTicket.count({ where: { priority: "urgent", status: { in: ["open", "in_progress"] } } }),
        prisma.supportTicket.count({
          where: {
            status: { in: ["open", "in_progress", "waiting_on_customer"] },
            createdAt: { lt: sevenDaysAgo },
          },
        }),
        prisma.aiUsageLog.aggregate({
          where: { createdAt: { gte: sevenDaysAgo } },
          _sum: { costUsd: true, tokensIn: true, tokensOut: true },
        }),
        prisma.subscription.groupBy({
          by: ["plan", "status"],
          _count: { _all: true },
        }),
      ]);

      const ticketCounts = await prisma.supportTicket.groupBy({
        by: ["status", "priority"],
        _count: { _all: true },
      });
      const latestTickets = await prisma.supportTicket.findMany({
        include: supportTicketListInclude,
        orderBy: [{ priorityScore: "desc" }, { updatedAt: "desc" }],
        take: 8,
      });

      return c.json({
        overview: {
          users,
          restaurants,
          openTickets,
          urgentTickets,
          staleTickets,
          aiUsage7d: {
            costUsd: recentAiUsage._sum?.costUsd ?? 0,
            inputTokens: recentAiUsage._sum?.tokensIn ?? 0,
            outputTokens: recentAiUsage._sum?.tokensOut ?? 0,
          },
          subscriptions,
          ticketCounts,
          latestTickets: latestTickets.map((ticket) => serializeSupportTicket(ticket)),
        },
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .get("/accounts", async (c) => {
    try {
      const restaurants = await prisma.restaurant.findMany({
        include: {
          owner: { select: { id: true, email: true, fullName: true, role: true } },
          subscription: true,
          operatorAccount: true,
          _count: {
            select: {
              supportTickets: true,
              menuItems: true,
              pageViews: true,
            },
          },
        },
        orderBy: { updatedAt: "desc" },
        take: 100,
      });
      return c.json({
        accounts: restaurants.map((restaurant) => ({
          id: restaurant.id,
          name: restaurant.name,
          slug: restaurant.slug,
          isPublished: restaurant.isPublished,
          subscriptionStatus: restaurant.subscriptionStatus,
          subscription: restaurant.subscription,
          operatorAccount: restaurant.operatorAccount,
          owner: restaurant.owner,
          counts: restaurant._count,
          createdAt: restaurant.createdAt.toISOString(),
          updatedAt: restaurant.updatedAt.toISOString(),
        })),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .get("/users", async (c) => {
    try {
      const { role } = usersQuerySchema.parse(c.req.query());
      const users = await prisma.user.findMany({
        where: role ? { role } : {},
        select: {
          id: true,
          email: true,
          fullName: true,
          role: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: {
              assignedTickets: true,
            },
          },
        },
        orderBy: [{ role: "asc" }, { email: "asc" }],
        take: 200,
      });

      return c.json({
        users: users.map((user) => ({
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          role: user.role,
          assignedTicketCount: user._count.assignedTickets,
          createdAt: user.createdAt.toISOString(),
          updatedAt: user.updatedAt.toISOString(),
        })),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .get("/support/tickets", async (c) => {
    try {
      const { status, priority, severity, plan } = ticketListQuerySchema.parse(c.req.query());
      const tickets = await prisma.supportTicket.findMany({
        where: {
          ...(status ? { status } : {}),
          ...(priority ? { priority } : {}),
          ...(plan ? { planSnapshot: plan } : {}),
          ...(severity
            ? {
                OR: [
                  { adminOverrideSeverity: severity },
                  { adminOverrideSeverity: null, aiSeverity: severity },
                ],
              }
            : {}),
        },
        include: supportTicketListInclude,
        orderBy: [{ priorityScore: "desc" }, { updatedAt: "desc" }],
        take: 100,
      });
      return c.json({ tickets: tickets.map((ticket) => serializeSupportTicket(ticket)) });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .get("/support/tickets/:ticketId", async (c) => {
    try {
      const ticket = await prisma.supportTicket.findUnique({
        where: { id: c.req.param("ticketId") },
        include: supportTicketInclude,
      });
      if (!ticket) throw new ApiError("Support ticket not found", 404);
      return c.json({ ticket: serializeSupportTicket(ticket) });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/support/tickets/:ticketId/reply", async (c) => {
    try {
      const admin = c.get("admin").user;
      const ticketId = c.req.param("ticketId");
      const data = replySchema.parse(await c.req.json());
      const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
      if (!ticket) throw new ApiError("Support ticket not found", 404);

      const nextStatus = data.status ?? (data.isInternal ? ticket.status : "waiting_on_customer");
      const updated = await prisma.$transaction(async (tx) => {
        await tx.supportTicketMessage.create({
          data: {
            ticketId,
            restaurantId: ticket.restaurantId,
            authorType: "admin",
            authorUserId: admin.id,
            body: data.body,
            isInternal: data.isInternal,
          },
        });
        await tx.supportTicketEvent.create({
          data: {
            ticketId,
            restaurantId: ticket.restaurantId,
            actorUserId: admin.id,
            eventType: data.isInternal ? "admin_internal_note" : "admin_replied",
            previous: { status: ticket.status },
            next: { status: nextStatus },
            note: data.isInternal ? "Internal note added." : data.body.slice(0, 500),
            visibleToOwner: !data.isInternal,
          },
        });
        if (!data.isInternal) {
          await mirrorSupportUpdateToOwnerChat({
            restaurantId: ticket.restaurantId,
            ticketId,
            content: `Support replied: ${data.body.slice(0, 600)}`,
            tx,
          });
        }
        return tx.supportTicket.update({
          where: { id: ticketId },
          data: {
            status: nextStatus,
            firstResponseAt: ticket.firstResponseAt ?? (!data.isInternal ? new Date() : null),
            resolvedAt: nextStatus === "resolved" ? new Date() : ticket.resolvedAt,
            closedAt: nextStatus === "closed" ? new Date() : ticket.closedAt,
          },
          include: supportTicketInclude,
        });
      });

      return c.json({ ticket: serializeSupportTicket(updated) });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .patch("/support/tickets/:ticketId/assign", async (c) => {
    try {
      const admin = c.get("admin").user;
      const ticketId = c.req.param("ticketId");
      const data = assignSchema.parse(await c.req.json());
      const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
      if (!ticket) throw new ApiError("Support ticket not found", 404);
      if (data.assignedAdminUserId) {
        const assignee = await prisma.user.findFirst({
          where: { id: data.assignedAdminUserId, role: "admin" },
          select: { id: true },
        });
        if (!assignee) throw new ApiError("Assigned admin not found", 404);
      }
      const updated = await prisma.$transaction(async (tx) => {
        await tx.supportTicketEvent.create({
          data: {
            ticketId,
            restaurantId: ticket.restaurantId,
            actorUserId: admin.id,
            eventType: "ticket_assigned",
            previous: { assignedAdminUserId: ticket.assignedAdminUserId },
            next: { assignedAdminUserId: data.assignedAdminUserId },
            visibleToOwner: false,
          },
        });
        return tx.supportTicket.update({
          where: { id: ticketId },
          data: { assignedAdminUserId: data.assignedAdminUserId },
          include: supportTicketInclude,
        });
      });
      return c.json({ ticket: serializeSupportTicket(updated) });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .patch("/support/tickets/:ticketId/status", async (c) => {
    try {
      const admin = c.get("admin").user;
      const ticketId = c.req.param("ticketId");
      const data = ticketStatusSchema.parse(await c.req.json());
      const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
      if (!ticket) throw new ApiError("Support ticket not found", 404);
      const now = new Date();
      const updated = await prisma.$transaction(async (tx) => {
        await tx.supportTicketEvent.create({
          data: {
            ticketId,
            restaurantId: ticket.restaurantId,
            actorUserId: admin.id,
            eventType: "status_changed",
            previous: { status: ticket.status },
            next: { status: data.status },
            note: data.resolutionSummary ?? null,
          },
        });
        await mirrorSupportUpdateToOwnerChat({
          restaurantId: ticket.restaurantId,
          ticketId,
          content: `Status changed to ${data.status}.${data.resolutionSummary ? ` ${data.resolutionSummary}` : ""}`,
          tx,
        });
        return tx.supportTicket.update({
          where: { id: ticketId },
          data: {
            status: data.status,
            resolutionSummary: data.resolutionSummary ?? ticket.resolutionSummary,
            resolvedAt: data.status === "resolved" ? now : ticket.resolvedAt,
            closedAt: data.status === "closed" ? now : ticket.closedAt,
          },
          include: supportTicketInclude,
        });
      });
      return c.json({ ticket: serializeSupportTicket(updated) });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .patch("/support/tickets/:ticketId/priority", async (c) => {
    try {
      const admin = c.get("admin").user;
      const ticketId = c.req.param("ticketId");
      const data = ticketPrioritySchema.parse(await c.req.json());
      const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
      if (!ticket) throw new ApiError("Support ticket not found", 404);
      const severity = data.severity ?? effectiveSeverity(ticket);
      const calculated = calculateSupportPriority({
        severity,
        plan: ticket.planSnapshot,
        createdAt: ticket.createdAt,
      });
      const priority = data.priority ?? calculated.priority;
      const priorityScore = data.priorityScore ?? calculated.score;

      const updated = await prisma.$transaction(async (tx) => {
        await tx.supportTicketEvent.create({
          data: {
            ticketId,
            restaurantId: ticket.restaurantId,
            actorUserId: admin.id,
            eventType: "priority_changed",
            previous: {
              adminOverrideSeverity: ticket.adminOverrideSeverity,
              priority: ticket.priority,
              priorityScore: ticket.priorityScore,
            },
            next: { adminOverrideSeverity: data.severity ?? ticket.adminOverrideSeverity, priority, priorityScore },
            visibleToOwner: false,
          },
        });
        return tx.supportTicket.update({
          where: { id: ticketId },
          data: {
            adminOverrideSeverity: data.severity ?? ticket.adminOverrideSeverity,
            priority,
            priorityScore,
          },
          include: supportTicketInclude,
        });
      });

      return c.json({ ticket: serializeSupportTicket(updated) });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .get("/support/articles", async (c) => {
    try {
      const includeDrafts = c.req.query("includeDrafts") !== "false";
      const query = c.req.query("query");
      if (query) {
        const articles = await findFaqMatches(query, { includeDrafts, limit: 20 });
        return c.json({ articles });
      }
      const articles = await prisma.supportArticle.findMany({
        where: includeDrafts ? {} : { isPublished: true },
        orderBy: [{ isPublished: "desc" }, { updatedAt: "desc" }],
        take: 100,
      });
      return c.json({ articles: articles.map(serializeSupportArticle) });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/support/articles", async (c) => {
    try {
      const data = articleSchema.parse(await c.req.json());
      const slug = await uniqueSupportArticleSlug(data.title);
      const article = await prisma.supportArticle.create({
        data: {
          ...data,
          category: data.category ?? null,
          slug,
        },
      });
      return c.json({ article: serializeSupportArticle(article) }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .put("/support/articles/:articleId", async (c) => {
    try {
      const data = articleSchema.parse(await c.req.json());
      const articleId = c.req.param("articleId");
      const existing = await prisma.supportArticle.findUnique({ where: { id: articleId } });
      if (!existing) throw new ApiError("Support article not found", 404);
      const slug = data.title === existing.title ? existing.slug : await uniqueSupportArticleSlug(data.title, articleId);
      const article = await prisma.supportArticle.update({
        where: { id: articleId },
        data: {
          ...data,
          category: data.category ?? null,
          slug,
        },
      });
      return c.json({ article: serializeSupportArticle(article) });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .delete("/support/articles/:articleId", async (c) => {
    try {
      const articleId = c.req.param("articleId");
      await prisma.supportArticle.delete({ where: { id: articleId } });
      return c.json({ ok: true });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

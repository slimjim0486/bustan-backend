import { createHash, randomBytes } from "crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { ApiError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import {
  assertRateLimit,
  getClientIp,
} from "@/lib/public-request-guards";
import { env } from "@/lib/env";
import {
  computeAuditInputsHash,
  runAuditReportJob,
} from "@/services/audit/orchestrator";

const phoneSchema = z.string().regex(/^\+[1-9]\d{7,14}$/);

const createAuditSchema = z.object({
  restaurantName: z.string().min(2).max(160),
  location: z.string().min(2).max(160),
  phone: phoneSchema.optional(),
  email: z.string().email().optional(),
  source: z.string().max(200).optional(),
  company: z.string().optional().default(""),
});

const createLeadSchema = z.object({
  phone: phoneSchema,
  email: z.string().email().optional(),
  source: z.string().max(200).optional(),
  company: z.string().optional().default(""),
});

function hashIp(ip: string) {
  return createHash("sha256").update(`${ip}:${env.IP_HASH_PEPPER}`).digest("hex");
}

function normalizeInput(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function sourceFromRequest(c: Context, explicit?: string) {
  return explicit ?? c.req.query("utm_source") ?? c.req.header("referer") ?? null;
}

async function generateSlug() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = randomBytes(8).toString("base64url");
    const existing = await prisma.auditReport.findUnique({ where: { slug } });
    if (!existing) return slug;
  }
  throw new ApiError("Could not allocate audit slug", 500);
}

function serializeReport(report: any) {
  return {
    ...report,
    costUsd:
      report.costUsd === null || report.costUsd === undefined
        ? null
        : Number(report.costUsd),
  };
}

function applyIpAndGlobalLimits(ipHash: string) {
  assertRateLimit({
    key: `audit:global:hour`,
    limit: 100,
    windowMs: 60 * 60 * 1000,
  });
  assertRateLimit({
    key: `audit:ip:${ipHash}:hour`,
    limit: 5,
    windowMs: 60 * 60 * 1000,
  });
  assertRateLimit({
    key: `audit:ip:${ipHash}:day`,
    limit: 20,
    windowMs: 24 * 60 * 60 * 1000,
  });
}

function applyPhoneLimit(phone: string) {
  assertRateLimit({
    key: `audit:phone:${phone}:day`,
    limit: 2,
    windowMs: 24 * 60 * 60 * 1000,
  });
}

async function createLead(input: {
  phone: string;
  email?: string;
  restaurantName: string;
  location: string;
  ipHash: string;
  userAgent?: string | null;
  source?: string | null;
  reportId: string;
  enforcePhoneLimit?: boolean;
}) {
  if (input.enforcePhoneLimit !== false) {
    applyPhoneLimit(input.phone);
  }
  return prisma.auditLead.create({
    data: {
      phone: input.phone,
      email: input.email,
      restaurantName: input.restaurantName,
      location: input.location,
      ipHash: input.ipHash,
      userAgent: input.userAgent ?? undefined,
      source: input.source ?? undefined,
      reportId: input.reportId,
    },
  });
}

export const auditRoute = new Hono()
  .post("/", async (c) => {
    try {
      const data = createAuditSchema.parse(await c.req.json());
      const restaurantName = normalizeInput(data.restaurantName);
      const location = normalizeInput(data.location);
      const ipHash = hashIp(getClientIp(c));
      applyIpAndGlobalLimits(ipHash);

      if (data.company) {
        throw new ApiError("Invalid submission", 400);
      }

      const inputsHash = computeAuditInputsHash({ restaurantName, location });
      const cached = await prisma.auditReport.findFirst({
        where: {
          inputsHash,
          status: "succeeded",
          createdAt: {
            gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          },
        },
        orderBy: { createdAt: "desc" },
      });

      if (cached) {
        const lead = data.phone
          ? await createLead({
              phone: data.phone,
              email: data.email,
              restaurantName,
              location,
              ipHash,
              userAgent: c.req.header("user-agent"),
              source: sourceFromRequest(c, data.source),
              reportId: cached.id,
            })
          : null;

        return c.json({
          auditSlug: cached.slug,
          leadId: lead?.id ?? null,
          status: cached.status,
          cached: true,
          report: serializeReport(cached),
        });
      }

      const running = await prisma.auditReport.findFirst({
        where: {
          inputsHash,
          status: { in: ["queued", "running"] },
          createdAt: {
            gte: new Date(Date.now() - 60 * 60 * 1000),
          },
        },
        orderBy: { createdAt: "desc" },
      });

      if (running) {
        const lead = data.phone
          ? await createLead({
              phone: data.phone,
              email: data.email,
              restaurantName,
              location,
              ipHash,
              userAgent: c.req.header("user-agent"),
              source: sourceFromRequest(c, data.source),
              reportId: running.id,
            })
          : null;

        return c.json(
          {
            auditSlug: running.slug,
            leadId: lead?.id ?? null,
            status: running.status,
            cached: false,
          },
          202
        );
      }

      if (data.phone) {
        applyPhoneLimit(data.phone);
      }

      const report = await prisma.auditReport.create({
        data: {
          slug: await generateSlug(),
          inputsHash,
          status: "queued",
          restaurantName,
          location,
          scorecard: {},
          rawData: {},
          recommendations: [],
          progress: {},
        },
      });

      const lead = data.phone
        ? await createLead({
            phone: data.phone,
            email: data.email,
            restaurantName,
            location,
            ipHash,
            userAgent: c.req.header("user-agent"),
            source: sourceFromRequest(c, data.source),
            reportId: report.id,
            enforcePhoneLimit: false,
          })
        : null;

      void runAuditReportJob(report.id).catch((error) => {
        console.error("Audit report job failed", {
          reportId: report.id,
          slug: report.slug,
          error,
        });
      });

      return c.json(
        {
          auditSlug: report.slug,
          leadId: lead?.id ?? null,
          status: report.status,
          cached: false,
        },
        202
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/:slug/lead", async (c) => {
    try {
      const data = createLeadSchema.parse(await c.req.json());
      if (data.company) {
        throw new ApiError("Invalid submission", 400);
      }

      const report = await prisma.auditReport.findUnique({
        where: { slug: c.req.param("slug") },
      });
      if (!report) {
        throw new ApiError("Audit report not found", 404);
      }

      const ipHash = hashIp(getClientIp(c));
      applyIpAndGlobalLimits(ipHash);
      const lead = await createLead({
        phone: data.phone,
        email: data.email,
        restaurantName: report.restaurantName,
        location: report.location,
        ipHash,
        userAgent: c.req.header("user-agent"),
        source: sourceFromRequest(c, data.source),
        reportId: report.id,
      });

      return c.json({
        leadId: lead.id,
        auditSlug: report.slug,
        status: report.status,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .get("/:slug", async (c) => {
    try {
      const report = await prisma.auditReport.findUnique({
        where: { slug: c.req.param("slug") },
        include: {
          _count: {
            select: { leads: true },
          },
        },
      });

      if (!report) {
        throw new ApiError("Audit report not found", 404);
      }

      // hasLead drives the preview/full-report gate on the frontend. We
      // never leak phone/email out of this endpoint — the count is enough.
      const { _count, ...rest } = report;
      return c.json({
        ...serializeReport(rest),
        hasLead: (_count?.leads ?? 0) > 0,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

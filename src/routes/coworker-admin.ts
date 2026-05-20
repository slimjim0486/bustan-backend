// Admin Coworker routes — template management + pilot owner controls.
// Mounted at /api/admin/coworker. requireAdmin gate.

import { Hono } from "hono";
import { z } from "zod";
import { env } from "@/lib/env";
import { ApiError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireAuth } from "@/middleware/auth";
import { COWORKER_TEMPLATE_LIBRARY } from "@/lib/coworker/templates";
import {
  ensureLibraryRows,
  pushAndSync,
  submitLibraryToMeta,
  syncStatusFromMeta,
} from "@/services/coworker/template-sync";
import { enqueueBriefSendNow } from "@/queue/coworker-daily-brief";

const sendNowSchema = z.object({
  coworkerOwnerId: z.string().min(1),
  forDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .optional(),
});

export const coworkerAdminRoute = new Hono<{
  Variables: {
    auth: { clerkId: string; email: string | null };
    admin: { user: { id: string; role: string } };
  };
}>()
  // ── GET /status — env + feature flag summary ──
  .get("/status", requireAuth, requireAdmin, async (c) => {
    try {
      const [owners, templates] = await Promise.all([
        prisma.coworkerOwner.count(),
        prisma.coworkerTemplate.count(),
      ]);
      return c.json({
        enabled: env.COWORKER_ENABLED,
        dryRun: env.COWORKER_DRY_RUN,
        dryRunPhoneConfigured: Boolean(env.COWORKER_DRY_RUN_PHONE),
        wabaConfigured: Boolean(env.COWORKER_WABA_ID && env.COWORKER_ACCESS_TOKEN),
        phoneConfigured: Boolean(env.COWORKER_PHONE_NUMBER_ID),
        webhookConfigured: Boolean(env.COWORKER_WEBHOOK_VERIFY_TOKEN && env.COWORKER_APP_SECRET),
        displayPhone: env.COWORKER_DISPLAY_PHONE ?? null,
        counts: { owners, templates, libraryDefinitions: COWORKER_TEMPLATE_LIBRARY.length },
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  // ── GET /templates — list templates (with definition diff) ──
  .get("/templates", requireAuth, requireAdmin, async (c) => {
    try {
      const rows = await prisma.coworkerTemplate.findMany({
        orderBy: [{ name: "asc" }, { locale: "asc" }, { version: "desc" }],
      });
      return c.json({
        templates: rows.map((r) => ({
          ...r,
          // Mark rows whose body has diverged from the live library def — operator must bump version + resubmit.
          libraryDiverged: (() => {
            const def = COWORKER_TEMPLATE_LIBRARY.find(
              (d) => d.name === r.name && d.locale === r.locale && d.version === r.version
            );
            return def ? def.body !== r.body : true;
          })(),
        })),
        library: COWORKER_TEMPLATE_LIBRARY.map((d) => ({
          name: d.name,
          locale: d.locale,
          version: d.version,
          body: d.body,
          variables: d.variables,
          buttons: d.buttons,
          footer: d.footer,
        })),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  // ── POST /templates/ensure-rows — upsert DB rows from library (no Meta) ──
  .post("/templates/ensure-rows", requireAuth, requireAdmin, async (c) => {
    try {
      const results = await ensureLibraryRows();
      return c.json({ results });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  // ── POST /templates/submit — push to Meta + sync (idempotent) ──
  .post("/templates/submit", requireAuth, requireAdmin, async (c) => {
    try {
      const { pushed, synced } = await pushAndSync();
      return c.json({ pushed, synced });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  // ── POST /templates/sync-status — pull current Meta status only ──
  .post("/templates/sync-status", requireAuth, requireAdmin, async (c) => {
    try {
      const results = await syncStatusFromMeta();
      return c.json({ results });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  // ── PATCH /templates/:id/pause — operator can disable a template locally ──
  .patch("/templates/:id/pause", requireAuth, requireAdmin, async (c) => {
    try {
      const id = c.req.param("id");
      const row = await prisma.coworkerTemplate.update({
        where: { id },
        data: { status: "paused" },
      });
      return c.json({ ok: true, template: row });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  // ── PATCH /templates/:id/resume ──
  .patch("/templates/:id/resume", requireAuth, requireAdmin, async (c) => {
    try {
      const id = c.req.param("id");
      // Only flip back to the pre-pause state we can infer from Meta —
      // since we don't store it, we set pending and re-sync.
      const row = await prisma.coworkerTemplate.update({
        where: { id },
        data: { status: "pending" },
      });
      await syncStatusFromMeta().catch((e) =>
        console.warn("[coworker-admin] post-resume sync failed", e)
      );
      return c.json({ ok: true, template: row });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  // ── GET /owners — list pilot/active owners ──
  .get("/owners", requireAuth, requireAdmin, async (c) => {
    try {
      const owners = await prisma.coworkerOwner.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          restaurant: { select: { id: true, name: true, slug: true } },
          owner: { select: { id: true, email: true, fullName: true } },
          _count: { select: { messages: true } },
        },
      });
      return c.json({ owners });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  // ── POST /send-now — manually enqueue a daily brief for one owner ──
  .post("/send-now", requireAuth, requireAdmin, async (c) => {
    try {
      if (!env.COWORKER_ENABLED) {
        throw new ApiError("Coworker disabled (COWORKER_ENABLED=false).", 503);
      }
      const data = sendNowSchema.parse(await c.req.json());
      await enqueueBriefSendNow(data);
      return c.json({ ok: true, queued: true });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  // ── GET /owners/:id/messages — last 50 messages for one pilot ──
  .get("/owners/:id/messages", requireAuth, requireAdmin, async (c) => {
    try {
      const id = c.req.param("id");
      const messages = await prisma.coworkerMessage.findMany({
        where: { coworkerOwnerId: id },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      return c.json({ messages });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

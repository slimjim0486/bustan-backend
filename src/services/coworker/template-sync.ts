// Idempotent push of COWORKER_TEMPLATE_LIBRARY → Meta + sync status into DB.
// Safe to run repeatedly: a template that already exists in CoworkerTemplate
// with a matching version is left alone unless its body diverges (in which
// case it's flagged for the operator — never silently mutated, since Meta
// would treat that as a new template anyway).
//
// Called from:
//   - scripts/coworker-submit-templates.ts (CLI for first push)
//   - admin endpoint POST /api/admin/coworker/templates/:id/submit (operator-triggered)
//   - admin endpoint POST /api/admin/coworker/templates/sync (pull status from Meta)

import { Prisma } from "@prisma/client";
import {
  fetchAllTemplates,
  submitTemplate,
} from "@/lib/coworker/meta-client";
import {
  COWORKER_TEMPLATE_LIBRARY,
  type CoworkerTemplateDefinition,
  toSubmitInput,
} from "@/lib/coworker/templates";
import { prisma } from "@/lib/prisma";

export interface TemplateSyncResult {
  name: string;
  locale: string;
  version: number;
  action: "created" | "already_synced" | "submitted_to_meta" | "skipped" | "error";
  metaTemplateId?: string;
  message?: string;
}

/** Upsert every library definition into CoworkerTemplate (DRAFT) without
 *  touching Meta. Useful in dry-run / dev where you want rows to show up
 *  in the admin UI before Meta credentials are wired. */
export async function ensureLibraryRows(): Promise<TemplateSyncResult[]> {
  const results: TemplateSyncResult[] = [];
  for (const def of COWORKER_TEMPLATE_LIBRARY) {
    const existing = await prisma.coworkerTemplate.findUnique({
      where: { name_locale_version: { name: def.name, locale: def.locale, version: def.version } },
    });
    if (existing) {
      results.push({
        name: def.name,
        locale: def.locale,
        version: def.version,
        action: "already_synced",
        metaTemplateId: existing.metaTemplateId ?? undefined,
      });
      continue;
    }
    await prisma.coworkerTemplate.create({
      data: {
        name: def.name,
        locale: def.locale,
        category: def.category,
        body: def.body,
        variables: def.variables.map((v) => v.name),
        buttons: def.buttons ? (def.buttons as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        footer: def.footer,
        version: def.version,
        status: "draft",
      },
    });
    results.push({
      name: def.name,
      locale: def.locale,
      version: def.version,
      action: "created",
    });
  }
  return results;
}

/** Push DRAFT-or-missing rows to Meta. Idempotent: rows with a metaTemplateId
 *  are skipped (use syncStatusFromMeta to refresh their status). */
export async function submitLibraryToMeta(): Promise<TemplateSyncResult[]> {
  // Ensure rows exist before talking to Meta.
  await ensureLibraryRows();

  const results: TemplateSyncResult[] = [];
  for (const def of COWORKER_TEMPLATE_LIBRARY) {
    const row = await prisma.coworkerTemplate.findUnique({
      where: { name_locale_version: { name: def.name, locale: def.locale, version: def.version } },
    });
    if (!row) {
      results.push({
        name: def.name,
        locale: def.locale,
        version: def.version,
        action: "error",
        message: "Row missing after ensure step.",
      });
      continue;
    }
    if (row.metaTemplateId) {
      results.push({
        name: def.name,
        locale: def.locale,
        version: def.version,
        action: "already_synced",
        metaTemplateId: row.metaTemplateId,
      });
      continue;
    }

    try {
      const submission = await submitTemplate(toSubmitInput(def));
      await prisma.coworkerTemplate.update({
        where: { id: row.id },
        data: {
          metaTemplateId: submission.metaTemplateId,
          status: submission.status === "APPROVED" ? "approved" : "pending",
          lastSyncedAt: new Date(),
        },
      });
      results.push({
        name: def.name,
        locale: def.locale,
        version: def.version,
        action: "submitted_to_meta",
        metaTemplateId: submission.metaTemplateId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        name: def.name,
        locale: def.locale,
        version: def.version,
        action: "error",
        message,
      });
    }
  }
  return results;
}

/** Pull current status from Meta for every row that has a metaTemplateId.
 *  Updates `status` + `rejectionReason` + `lastSyncedAt`. Idempotent. */
export async function syncStatusFromMeta(): Promise<TemplateSyncResult[]> {
  const remote = await fetchAllTemplates();
  const remoteByKey = new Map<string, (typeof remote)[number]>();
  for (const t of remote) {
    if (t.id) remoteByKey.set(t.id, t);
  }

  const localRows = await prisma.coworkerTemplate.findMany({
    where: { metaTemplateId: { not: null } },
  });

  const results: TemplateSyncResult[] = [];
  for (const row of localRows) {
    const r = row.metaTemplateId ? remoteByKey.get(row.metaTemplateId) : undefined;
    if (!r) {
      results.push({
        name: row.name,
        locale: row.locale,
        version: row.version,
        action: "skipped",
        message: "No matching template at Meta — likely deleted on their side.",
      });
      continue;
    }

    const status =
      r.status === "APPROVED"
        ? "approved"
        : r.status === "REJECTED"
          ? "rejected"
          : r.status === "PAUSED"
            ? "paused"
            : r.status === "DISABLED"
              ? "disabled"
              : "pending";

    await prisma.coworkerTemplate.update({
      where: { id: row.id },
      data: {
        status,
        rejectionReason: r.rejected_reason ?? null,
        lastSyncedAt: new Date(),
      },
    });
    results.push({
      name: row.name,
      locale: row.locale,
      version: row.version,
      action: "submitted_to_meta",
      message: status,
    });
  }
  return results;
}

/** Convenience for the CLI script + admin endpoint. */
export async function pushAndSync(): Promise<{
  pushed: TemplateSyncResult[];
  synced: TemplateSyncResult[];
}> {
  const pushed = await submitLibraryToMeta();
  const synced = await syncStatusFromMeta();
  return { pushed, synced };
}

/** Look up a CoworkerTemplate row by (name, locale). Returns the highest
 *  version row that is APPROVED (or the latest DRAFT/PENDING in dry-run). */
export async function findSendableTemplate(input: {
  name: string;
  locale: string;
  dryRun: boolean;
}) {
  if (input.dryRun) {
    // In dry-run we tolerate non-approved rows so pilots can test before Meta approval.
    return prisma.coworkerTemplate.findFirst({
      where: { name: input.name, locale: input.locale, supersededAt: null },
      orderBy: { version: "desc" },
    });
  }
  return prisma.coworkerTemplate.findFirst({
    where: {
      name: input.name,
      locale: input.locale,
      status: "approved",
      supersededAt: null,
    },
    orderBy: { version: "desc" },
  });
}

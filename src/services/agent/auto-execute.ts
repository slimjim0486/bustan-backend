import { DraftActionStatus } from "@prisma/client";
import type { PlanEntitlements } from "@/lib/entitlements";
import { prisma } from "@/lib/prisma";
import { approveDraft } from "@/services/draft-actions";
import { enqueueDraftShip } from "@/queue/draft-ship";
import { getToolTier } from "@/services/agent/autonomy-tiers";
import {
  resolveEffectiveAutonomy,
  isHighImpactPaused,
  decideAutoExecution,
  isHighImpactActionType,
  graceMsForAutoExecute,
} from "./autonomy";
import { notifyOwnerAutoAction } from "./autonomy-notify";

// Mirrors ToolResult from owner-chat-tools.ts. Duplicated (rather than
// imported) so this stays a leaf module with no dependency back on the
// tool-execution file that imports maybeAutoExecuteDraft.
interface ToolResultLike {
  content: string;
  draftId?: string;
  preview?: {
    pendingActionId: string;
    description: string;
    changes: Array<{ label: string; before: string | null; after: string }>;
  };
}

/**
 * B1b spine: for a guarded_auto account, auto-approve + ship the draft a Tier-2
 * tool just created, reusing approveDraft + enqueueDraftShip. Returns the input
 * result unchanged for draft_only / non-draft / paused-high-impact cases.
 */
export async function maybeAutoExecuteDraft(args: {
  result: ToolResultLike;
  toolName: string;
  restaurantId: string;
  clerkId: string;
  entitlements: PlanEntitlements;
  restaurant: { agentAutonomyOptIn: boolean };
}): Promise<ToolResultLike> {
  const { result, toolName, restaurantId, clerkId, entitlements, restaurant } = args;

  const effective = resolveEffectiveAutonomy(restaurant, entitlements);
  const isDryRun = !!result.draftId && result.draftId.startsWith("dryrun_");
  const draftActionType =
    result.draftId && !isDryRun
      ? (
          await prisma.draftAction.findFirst({
            where: { id: result.draftId, restaurantId },
            select: { actionType: true },
          })
        )?.actionType ?? null
      : null;
  const highImpact = draftActionType ? isHighImpactActionType(draftActionType) : false;

  // Only consult the velocity breaker (a DB count) when it can matter.
  const paused =
    highImpact && effective === "guarded_auto" && !isDryRun && !!result.draftId
      ? await isHighImpactPaused(restaurantId)
      : false;

  const decision = decideAutoExecution({
    hasDraft: !!result.draftId,
    isDryRun,
    tier: getToolTier(toolName),
    effective,
    highImpact,
    paused,
  });

  if (decision === "passthrough") return result;

  if (decision === "pause_to_draft") {
    return {
      ...result,
      content: JSON.stringify({
        ...safeParse(result.content),
        autoPaused: true,
        note: "Paused auto-execution — a lot of high-impact actions in a short window. This is staged in your Inbox for approval.",
      }),
    };
  }

  // decision === "auto"
  const graceMs = graceMsForAutoExecute(draftActionType ?? "");
  const shipAt = new Date(Date.now() + graceMs);

  let approval: Awaited<ReturnType<typeof approveDraft>> | undefined;
  try {
    approval = await approveDraft(result.draftId!, restaurantId, clerkId, { shipAt });
    await prisma.draftAction.update({ where: { id: result.draftId! }, data: { autoExecuted: true } });
    await Promise.all(
      approval.toShip.filter((d) => d.shipAt !== null).map((d) => enqueueDraftShip(d.id, d.shipAt!)),
    );
  } catch (err) {
    console.error("[b1b] auto-execute failed; degrading to staged draft", {
      draftId: result.draftId,
      toolName,
      err,
    });
    // If approve already scheduled the row(s) but a later step failed, revert them to
    // pending so the draft is cleanly staged in the Inbox — never orphaned-scheduled.
    if (approval) {
      await prisma.draftAction
        .updateMany({
          where: {
            id: { in: approval.toShip.map((d) => d.id) },
            restaurantId,
            status: DraftActionStatus.scheduled,
          },
          data: {
            status: DraftActionStatus.pending,
            shipAt: null,
            decisionAt: null,
            decidedBy: null,
            autoExecuted: false,
          },
        })
        .catch((revertErr) =>
          console.error("[b1b] revert-to-pending after failed auto-execute also failed", {
            draftId: result.draftId,
            revertErr,
          }),
        );
    }
    return result; // passthrough — turn continues, owner approves from the Inbox
  }

  // Fire-and-forget — never block the tool loop on a notification.
  void notifyOwnerAutoAction({ restaurantId, toolName, draftId: result.draftId!, highImpact }).catch(
    () => undefined,
  );

  const graceLabel = highImpact ? "5 minutes" : "1 minute";
  return {
    ...result,
    content: JSON.stringify({
      ...safeParse(result.content),
      autoExecuted: true,
      note: `Done — I carried this out on your behalf. It ships in ${graceLabel}; you can undo it from the Inbox until then.`,
    }),
  };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

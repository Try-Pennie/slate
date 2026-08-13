"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin, requireManager } from "@/lib/auth";
import { approveOoo, rejectOoo, retryOooSideEffects } from "@/lib/ooo/service";
import { describeEffects, retryOutcome } from "@/lib/ooo/effect-copy";
import type { OooActionResult } from "@/lib/ooo/orchestration";

/**
 * Manager queue actions. requireManager gates the surface; per-request
 * authority (the request's manager of record, or an admin) is enforced inside
 * the service via canModerate. Failures travel back as ?msg= for the banner.
 * A succeeded-but-degraded action (some side effect failed) also surfaces a
 * banner so the approver sees it, not just the background ops alert.
 *
 * Which steps count as failed is decided in ONE place, `describeEffects`, which
 * the admin page's own panel reads too (#1477), so the banner and the list under
 * the request can never disagree about what is in place.
 */

function finish(
  result: OooActionResult,
  opts?: { success?: string; partialMsg?: (failedCount: number) => string },
): void {
  revalidatePath("/admin/ooo");
  if (!result.ok) {
    redirect(`/admin/ooo?msg=${encodeURIComponent(result.error)}`);
  }
  if (opts?.partialMsg) {
    const failed = describeEffects(result.request.side_effects).failed;
    if (failed.length) {
      redirect(
        `/admin/ooo?msg=${encodeURIComponent(opts.partialMsg(failed.length))}`,
      );
    }
  }
  if (opts?.success) {
    redirect(`/admin/ooo?ok=${encodeURIComponent(opts.success)}`);
  }
}

export async function approveOooAction(form: FormData): Promise<void> {
  const actor = await requireManager();
  const requestId = String(form.get("request_id") ?? "");
  if (!requestId) return;
  finish(await approveOoo(requestId, actor), {
    success: "Time off approved.",
    partialMsg: (n) =>
      `Approved, but ${n} follow-up step${n > 1 ? "s" : ""} failed to apply. Use Retry on the request below.`,
  });
}

export async function rejectOooAction(form: FormData): Promise<void> {
  const actor = await requireManager();
  const requestId = String(form.get("request_id") ?? "");
  if (!requestId) return;
  finish(
    await rejectOoo(requestId, actor, String(form.get("rejection_note") ?? "")),
    { success: "Request declined." },
  );
}

/**
 * Retry the post-approval calendar work, and SAY what is true afterwards (#1476).
 *
 * The banner is built from the request's finished state, not from the fact that
 * the action returned without throwing (L78). Without it, a retry that fixed
 * everything, one that fixed some steps, and one that fixed nothing were
 * indistinguishable: the only signal was whether the red marker happened to
 * disappear, and the person who pressed it had to have someone query the database
 * to find out whether the calendar event had landed.
 */
export async function retryOooAction(form: FormData): Promise<void> {
  const actor = await requireAdmin();
  const requestId = String(form.get("request_id") ?? "");
  if (!requestId) return;
  const result = await retryOooSideEffects(requestId, actor);
  if (!result.ok) {
    finish(result);
    return;
  }
  const outcome = retryOutcome(result.request.side_effects);
  // Exactly one of the two is set, by the same predicate `finish` uses to choose
  // between them, so they cannot disagree.
  finish(result, {
    success: outcome.ok ?? undefined,
    partialMsg: () => outcome.msg ?? "",
  });
}

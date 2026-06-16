"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin, requireManager } from "@/lib/auth";
import { approveOoo, rejectOoo, retryOooSideEffects } from "@/lib/ooo/service";
import type { OooActionResult } from "@/lib/ooo/orchestration";

/**
 * Manager queue actions. requireManager gates the surface; per-request
 * authority (the request's manager of record, or an admin) is enforced inside
 * the service via canModerate. Failures travel back as ?msg= for the banner.
 * A succeeded-but-degraded action (some side effect failed) also surfaces a
 * banner so the approver sees it, not just the background ops alert.
 */

function finish(
  result: OooActionResult,
  partialMsg?: (failedCount: number) => string,
): void {
  revalidatePath("/admin/ooo");
  if (!result.ok) {
    redirect(`/admin/ooo?msg=${encodeURIComponent(result.error)}`);
  }
  if (partialMsg) {
    const failed = Object.values(result.request.side_effects ?? {}).filter(
      (v) => typeof v === "string" && v.startsWith("failed"),
    );
    if (failed.length) {
      redirect(`/admin/ooo?msg=${encodeURIComponent(partialMsg(failed.length))}`);
    }
  }
}

export async function approveOooAction(form: FormData): Promise<void> {
  const actor = await requireManager();
  const requestId = String(form.get("request_id") ?? "");
  if (!requestId) return;
  finish(
    await approveOoo(requestId, actor),
    (n) =>
      `Approved — but ${n} follow-up step${n > 1 ? "s" : ""} failed to apply. Use “Retry” on the request below.`,
  );
}

export async function rejectOooAction(form: FormData): Promise<void> {
  const actor = await requireManager();
  const requestId = String(form.get("request_id") ?? "");
  if (!requestId) return;
  finish(
    await rejectOoo(requestId, actor, String(form.get("rejection_note") ?? "")),
  );
}

export async function retryOooAction(form: FormData): Promise<void> {
  const actor = await requireAdmin();
  const requestId = String(form.get("request_id") ?? "");
  if (!requestId) return;
  finish(await retryOooSideEffects(requestId, actor));
}

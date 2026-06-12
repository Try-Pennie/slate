"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin, requireManager } from "@/lib/auth";
import { approveOoo, rejectOoo, retryOooSideEffects } from "@/lib/ooo/service";

/**
 * Manager queue actions. requireManager gates the surface; per-request
 * authority (the request's manager of record, or an admin) is enforced inside
 * the service via canModerate. Failures travel back as ?msg= for the banner.
 */

function finish(result: { ok: boolean } | { ok: false; error: string }): void {
  revalidatePath("/admin/ooo");
  if (!result.ok && "error" in result) {
    redirect(`/admin/ooo?msg=${encodeURIComponent(result.error)}`);
  }
}

export async function approveOooAction(form: FormData): Promise<void> {
  const actor = await requireManager();
  const requestId = String(form.get("request_id") ?? "");
  if (!requestId) return;
  finish(await approveOoo(requestId, actor));
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

import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { canEditOrgSettings } from "@/lib/auth/roles";
import { consoleHiddenFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import ReasonOptionsEditor from "@/components/ReasonOptionsEditor";
import { SettingsSaveNotice } from "@/app/admin/settings/SettingsSaveNotice";
import { savedOutcome, savedSentence } from "@/lib/admin/save-outcomes";
import { resolveEditorRows, type ReasonOptionRow as PureReasonRow } from "@/lib/booking/reason-options";
import {
  loadReasonUsageCounts,
  type ReasonUsageCounts,
} from "@/lib/booking/reason-usage";
import { log } from "@/lib/log";
import type { ReasonOptionRow, User } from "@/lib/db/types";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";

export const dynamic = "force-dynamic";

/**
 * Admin editor for the reschedule/cancel/reassign reason options (#346). Reads the
 * full store (active + retired), seeds the coded defaults when the store is empty,
 * and hands the ordered set to the client editor. Admin-only (canEditOrgSettings);
 * the save action (setReasonOptions) guards independently with requireAdmin.
 */
export default async function ReasonOptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const saved = savedSentence(savedOutcome(sp.ok));
  const me = await currentUser();
  if (!me) redirect("/login");
  if (consoleHiddenFor(me.role)) redirect("/admin/ooo");
  if (!canEditOrgSettings(me.role)) {
    return (
      <main className="p-8 text-sm text-fg-muted">
        You need an admin account to edit reason options.
      </main>
    );
  }

  // Read the full store (incl. retired). Guarded: the table may not exist during a
  // migrate-before-deploy window, and a missing table must not 500 the page.
  let stored: ReasonOptionRow[] = [];
  let lastChanged = "Never changed; using built-in defaults.";
  try {
    const { data, error } = await supabaseAdmin()
      .from("reason_options")
      .select("action,code,label,sort_order,active,locked,updated_at,updated_by");
    if (!error && data) {
      stored = data as ReasonOptionRow[];
      const stamps = [...stored].sort(
        (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at),
      );
      const latest = stamps[0];
      if (latest) {
        const editorIds = [...new Set(stored.map((r) => r.updated_by).filter(Boolean))] as string[];
        const nameById = new Map<string, string>();
        if (editorIds.length) {
          // error-ok: an id-to-display-name lookup for the "last changed by" line
          // only, and the very next line already renders an unresolved id as
          // "someone". No reason option is decided by it, and the reasons
          // themselves are read above with `error` bound and checked.
          const { data: users } = await supabaseAdmin()
            .from("users")
            .select("id,name,email")
            .in("id", editorIds);
          for (const u of (users ?? []) as Pick<User, "id" | "name" | "email">[]) {
            nameById.set(u.id, u.name ?? u.email);
          }
        }
        const who = latest.updated_by ? (nameById.get(latest.updated_by) ?? "someone") : "someone";
        const when = new Date(latest.updated_at).toLocaleString("en-US", {
          dateStyle: "medium",
          timeStyle: "short",
        });
        lastChanged = `Last changed by ${who} at ${when}.`;
      }
    }
  } catch {
    // Fall through to the coded-default seed below.
  }

  const initial = resolveEditorRows(stored as PureReasonRow[]);

  // Recent usage per reason (#990), so an admin sees how often a reason is picked
  // before retiring it. A read failure (or the RPC missing during a
  // migrate-before-deploy window) degrades to NULL, never to zeros (#1657):
  // `loadReasonUsageCounts` throws for exactly this reason, and degrading the
  // throw to an empty map is the outcome it exists to prevent. Zero is the real
  // answer "nobody has picked this in 90 days", it renders as a positive claim,
  // and the same number gates the confirm before retiring a still-used reason, so
  // zeroing it turns a false all clear into a disabled guardrail on the one screen
  // where the destructive edit is made.
  let usage: ReasonUsageCounts | null = null;
  try {
    usage = await loadReasonUsageCounts();
  } catch (err) {
    log.error("reason-options", { msg: "usage counts unreadable" }, err);
  }

  return (
    <>
      <>
        <AdminPageHeader title="Reason options">
          The reasons staff and customers pick when rescheduling, cancelling, or
          reassigning a booking. Add, rename, reorder, or retire them without a
          deploy. Retiring a reason hides it from new bookings but keeps it readable
          in history. &ldquo;Other&rdquo; is always available.
          <p className="mt-3 text-xs">{lastChanged}</p>
        </AdminPageHeader>

        {/* #1990: the sentence comes from the OUTCOME, so it names the form
          that saved rather than whatever this page had written down. An
          unrecognised value (a bookmarked `?ok=1` from before outcomes were
          named) shows nothing, rather than confirming a save nobody made. */}
      {saved && <SettingsSaveNotice ok saved={saved} error={sp.error} />}
      {sp.error && !saved && <SettingsSaveNotice ok={false} error={sp.error} saved="" />}

        <ReasonOptionsEditor initial={initial} usage={usage} />
      </>
    </>
  );
}

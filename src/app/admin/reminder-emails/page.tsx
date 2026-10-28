import { redirect } from "next/navigation";
import { currentUser, getImpersonation } from "@/lib/auth";
import { canEditOrgSettings, canManageAgents } from "@/lib/auth/roles";
import { consoleHiddenFor, googleHostedDomain } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/log";
import { AdminPageHeader, AdminDenied } from "@/components/admin/AdminPageHeader";
import { SettingsSaveNotice } from "@/app/admin/settings/SettingsSaveNotice";
import { UnreadableNotice } from "@/components/ui/UnreadableNotice";
import { cardCls } from "@/components/ui/styles";
import { ReminderEmailList, type ListedEmail } from "@/components/admin/reminder-emails/ReminderEmailList";
import { ReminderEmailWorkspace } from "@/components/admin/reminder-emails/ReminderEmailWorkspace";
import type { EditorEmail } from "@/components/admin/reminder-emails/ReminderEmailEditor";
import type { HistoryVersion } from "@/components/admin/reminder-emails/ReminderEmailHistory";
import { savedOutcome, savedSentence } from "@/lib/admin/save-outcomes";
import { REMINDER_EMAIL_COLUMNS, readSnapshot } from "@/lib/admin/reminder-email-form";
import { REMINDER_COPY } from "@/lib/admin/reminder-emails-copy";
import { BUSINESS_ZONE } from "@/lib/booking/business-hours";
import { unwrapCount } from "@/lib/db/result";

export const metadata = { title: "Reminder emails" };

export const dynamic = "force-dynamic";

/** How many versions the history shows; the count of the rest is said beneath it. */
const HISTORY_SHOWN = 25;


/**
 * /admin/reminder-emails (#4299, milestone "Editable reminder emails"): the emails a
 * lead gets before the call, their timing, and their copy.
 *
 * Managers read every email and its preview; admins edit, switch on and off, restore
 * earlier copy and send themselves a test. Nobody edits while viewing as someone else,
 * because every save records the real person who made it. Built like /admin/booker-copy:
 * the page header, the save notice, then cards.
 */
export default async function ReminderEmailsPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; ok?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const me = await currentUser();
  if (!me) redirect("/login");
  if (consoleHiddenFor(me.role)) redirect("/admin/ooo");
  if (!canManageAgents(me.role)) return <AdminDenied need="a manager or admin" />;

  const viewingAs = (await getImpersonation()) !== null;
  const canEdit = canEditOrgSettings(me.role) && !viewingAs;
  const saved = savedSentence(savedOutcome(sp.ok));

  const db = supabaseAdmin();
  // cap-safe: reminder_emails is a handful of admin made rows (SAFE_TABLES).
  const read = await db.from("reminder_emails").select(REMINDER_EMAIL_COLUMNS).order("minutes_before", { ascending: false });
  if (read.error) {
    log.error("reminder-emails", { msg: "reminder emails unreadable", code: read.error.code ?? null }, read.error);
  }
  const emails = read.error ? null : ((read.data ?? []) as EditorEmail[]);

  const header = (
    <AdminPageHeader title="Reminder emails">{REMINDER_COPY.pageIntro}</AdminPageHeader>
  );
  const notices = (
    <>
      {saved && <SettingsSaveNotice ok saved={saved} error={sp.error} />}
      {sp.error && !saved && <SettingsSaveNotice ok={false} error={sp.error} saved="" />}
    </>
  );

  // An unreadable list is its own screen, never an empty one: "no reminder emails"
  // would tell an admin leads get nothing, and invite them to add what is there.
  if (emails === null) {
    return (
      <>
        {header}
        {notices}
        <section className={cardCls}>
          <UnreadableNotice>{REMINDER_COPY.unreadable}</UnreadableNotice>
        </section>
      </>
    );
  }

  const creating = sp.email === "new" && canEdit;
  const open: EditorEmail | null = creating ? null : (emails.find((e) => e.id === sp.email) ?? emails[0] ?? null);

  let versions: HistoryVersion[] | null = [];
  let versionsTotal = 0;
  if (open) {
    const loaded = await loadHistory(open.id);
    versions = loaded?.versions ?? null;
    versionsTotal = loaded?.total ?? 0;
  }

  const listed: ListedEmail[] = emails.map((e) => ({
    id: e.id,
    name: e.name,
    minutesBefore: e.minutes_before,
    enabled: e.enabled,
    lateBooking: e.late_booking,
  }));

  const domain = googleHostedDomain().toLowerCase();
  const testAddress = me.email.toLowerCase().endsWith(`@${domain}`) ? me.email.toLowerCase() : null;

  return (
    <>
      {header}
      {notices}
      {viewingAs && <p className="text-sm text-fg-muted">{REMINDER_COPY.viewingAs}</p>}
      <section className={cardCls} aria-labelledby="reminder-list-h">
        <h2 id="reminder-list-h" className="mb-3 text-sm font-semibold">
          {REMINDER_COPY.listHeading}
        </h2>
        <ReminderEmailList emails={listed} openId={creating ? "new" : (open?.id ?? null)} canAdd={canEdit} />
      </section>
      {(open || creating) && (
        <ReminderEmailWorkspace
          email={open}
          canEdit={canEdit}
          readOnlyNote={viewingAs ? REMINDER_COPY.viewingAs : REMINDER_COPY.readOnly}
          testAddress={testAddress}
          versions={versions}
          versionsTotal={versionsTotal}
        />
      )}
    </>
  );
}

/** One email's latest versions with who saved each, or null when they cannot be read. */
async function loadHistory(emailId: string): Promise<{ versions: HistoryVersion[]; total: number } | null> {
  const db = supabaseAdmin();
  const [rows, count] = await Promise.all([
    db
      .from("reminder_email_versions")
      .select("version, snapshot, created_by, created_at")
      .eq("reminder_email_id", emailId)
      .order("version", { ascending: false })
      .limit(HISTORY_SHOWN),
    db.from("reminder_email_versions").select("id", { count: "exact", head: true }).eq("reminder_email_id", emailId),
  ]);
  if (rows.error || count.error) {
    log.error("reminder-emails", { msg: "reminder email versions unreadable", id: emailId }, rows.error ?? count.error);
    return null;
  }
  const data = (rows.data ?? []) as { version: number; snapshot: unknown; created_by: string | null; created_at: string }[];
  const ids = [...new Set(data.map((r) => r.created_by).filter((v): v is string => v !== null))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    // in-chunk-ok: at most HISTORY_SHOWN ids, from the limited read above.
    const people = await db.from("users").select("id, name, email").in("id", ids);
    if (people.error) {
      log.error("reminder-emails", { msg: "version authors unreadable", id: emailId }, people.error);
      return null;
    }
    for (const p of (people.data ?? []) as { id: string; name: string | null; email: string }[]) {
      names.set(p.id, p.name?.trim() || p.email);
    }
  }
  const versions: HistoryVersion[] = [];
  for (const r of data) {
    const snapshot = readSnapshot(r.snapshot);
    if (!snapshot) {
      // Not drawn, since it could not be restored either; said in the log, never hidden.
      log.warn("reminder-emails", { msg: "version snapshot unreadable", id: emailId, version: r.version });
      continue;
    }
    versions.push({
      version: r.version,
      snapshot,
      who: r.created_by === null ? "Set up with Slate" : (names.get(r.created_by) ?? "Someone no longer on the roster"),
      when: `${new Date(r.created_at).toLocaleString("en-US", {
        timeZone: BUSINESS_ZONE,
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })} ET`,
    });
  }
  return { versions, total: unwrapCount(count, "reminder email versions") };
}

import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { canEditOrgSettings } from "@/lib/auth/roles";
import { consoleHiddenFor } from "@/lib/env";
import { cardCls } from "@/components/ui/styles";
import { UnreadableNotice } from "@/components/ui/UnreadableNotice";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { PlaceholderDayLimitForm } from "@/components/admin/PlaceholderDayLimitForm";
import { ProgramLeadDaysTable } from "@/components/admin/ProgramLeadDaysTable";
import { SettingsSaveNotice } from "@/app/admin/settings/SettingsSaveNotice";
import { savedOutcome, savedSentence } from "@/lib/admin/save-outcomes";
import { readProgramLeadTimesSettings } from "@/lib/booking/settings";
import { loadProgramLeadDays } from "@/lib/admin/program-lead-days-load";
import { programLeadDaysEmpty, type ProgramLeadDay } from "@/lib/admin/program-lead-days";
import { PROGRAM_LEADS_COPY as COPY } from "@/lib/admin/program-leads-copy";
import { log } from "@/lib/log";

export const metadata = { title: "Program leads" };

export const dynamic = "force-dynamic";

/**
 * The 14 days, or null when any read failed. Module scope so the clock read is not in
 * render (react-hooks/purity), and so the failure is logged once, here.
 */
async function readDays(): Promise<ProgramLeadDay[] | null> {
  try {
    return await loadProgramLeadDays(Date.now());
  } catch (err) {
    log.error("admin-program-leads", { msg: "program lead days unreadable" }, err);
    return null;
  }
}

/**
 * Program leads (#4392): what happened to program leads over the last 14 Eastern days,
 * and the placeholder day limit.
 *
 * WHO: admins and super admins, and nobody else (Dan, 2026-10-29: anything added in the UI
 * for program leads is visible to admins only). `canEditOrgSettings` is the rank check
 * `requireRole("admin")` makes (`atLeast(role, "admin")`), written as the predicate here
 * because the sidebar's gate check reads it (`scripts/test-admin-nav-reachability.ts`).
 * Every lower role is answered not found, so the page, like its sidebar entry, does not exist
 * for them; a coordinator is nobody to the console (`currentUser`) and is sent to sign in.
 * The save action checks admin itself (`setPlaceholderDayLimit`, `requireAdmin`), so this
 * gate is presentation, not the control. WHOSE DATA: the org wide settings row and the
 * program's bookings and counts, none of it scoped to a person.
 *
 * The days come first, since reading them is what the page is opened for, and the limit,
 * set rarely, after (L609). Each read fails into its own state: an unreadable fortnight is
 * never drawn as an empty one, and an unreadable limit is never drawn as a number (L10).
 */
export default async function ProgramLeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const me = await currentUser();
  if (!me) redirect("/login");
  if (consoleHiddenFor(me.role)) redirect("/admin/ooo");
  if (!canEditOrgSettings(me.role)) notFound();

  const [days, settings] = await Promise.all([readDays(), readProgramLeadTimesSettings()]);
  const saved = savedSentence(savedOutcome(sp.ok));

  return (
    <>
      <AdminPageHeader title={COPY.page.title}>{COPY.page.intro}</AdminPageHeader>
      {saved && <SettingsSaveNotice ok saved={saved} error={sp.error} />}
      {sp.error && !saved && <SettingsSaveNotice ok={false} error={sp.error} saved="" />}

      <section className={cardCls}>
        <h2 className="mb-4 text-sm font-semibold">{COPY.days.heading}</h2>
        {days === null ? (
          <UnreadableNotice>{COPY.days.unreadable}</UnreadableNotice>
        ) : programLeadDaysEmpty(days) ? (
          <p className="text-sm text-fg-muted">{COPY.days.empty}</p>
        ) : (
          <ProgramLeadDaysTable rows={days} />
        )}
      </section>

      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">{COPY.limit.heading}</h2>
        <PlaceholderDayLimitForm limit={settings?.dayLimit ?? null} />
      </section>
    </>
  );
}

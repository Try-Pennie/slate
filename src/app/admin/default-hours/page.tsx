import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { canEditOrgSettings } from "@/lib/auth/roles";
import { oooOnlyFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { minutesToTime } from "@/lib/schedule-core";
import {
  setOrgDefaultHours,
} from "@/app/admin/actions";
import { DayToggles } from "@/components/ui/DayToggles";
import { TimeField } from "@/components/ui/TimeField";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { UnreadableNotice } from "@/components/ui/UnreadableNotice";
import { log } from "@/lib/log";
import { SettingsSaveNotice } from "@/app/admin/settings/SettingsSaveNotice";
import { AdminPageHeader, AdminDenied } from "@/components/admin/AdminPageHeader";
import { btnCls, cardCls, inputCls, labelCls } from "@/components/ui/styles";

export const dynamic = "force-dynamic";

export default async function DefaultHoursPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const me = await currentUser();
  if (!me) redirect("/login");
  if (!canEditOrgSettings(me.role)) return <AdminDenied need="an admin" />;
  if (oooOnlyFor(me.role)) redirect("/admin/ooo");

  // could-not-measure state there was, `coverage = { ok: false }`, whose wording
  // names the ROSTER. A failed WEEK read therefore drew seven unchecked weekdays
  // (this page stating Pennie is closed every day, on the screen whose job is to
  // say what the hours are) beside a notice blaming a read that may have been
  // perfectly fine, and a failed EXCEPTIONS read drew "No dates are set", a
  // categorical all clear about holiday closures produced by a read that never
  // ran. Distinct causes get distinct messages (L11), and a surface derived from
  // several reads gates on every one of them (L530).
  //
  // `null` is the unreadable state throughout, never an empty value: an empty
  // week and an empty exception list are both legitimate readings, and both are
  // the reassuring one.
  // Only the org defaults are read here. The week, the holiday exceptions and the
  // coverage readout belong to /admin/business-hours; loading them for a page that
  // does not draw them is the cost #1748 exists to remove.
  //
  // #1651: `null` is the unreadable state, never an empty value. An empty set of
  // defaults is a legitimate reading and it is the reassuring one, so a failed read
  // that rendered as empty would show this page claiming no starting hours are set.
  type OrgDefaults = {
    default_timezone: string;
    default_start_minute: number;
    default_end_minute: number;
    default_weekdays: number[];
  };
  let org: OrgDefaults | null = null;
  let orgUnreadable = false;
  const orgRead = await supabaseAdmin()
    .from("organizations")
    .select(
      "default_timezone, default_start_minute, default_end_minute, default_weekdays",
    )
    .eq("id", me.org_id)
    .maybeSingle();
  if (!orgRead.error && orgRead.data) {
    org = orgRead.data as OrgDefaults;
  } else {
    orgUnreadable = true;
    if (orgRead.error) {
      log.error("admin-default-hours", { msg: "org defaults unreadable" }, orgRead.error);
    }
  }

  return (
    <>
      <AdminPageHeader title="Default hours for a new agent">
        The weekly hours an agent starts on before they set their own. This is not
        the business hours: those bound every agent, these only seed one.
      </AdminPageHeader>
      <SettingsSaveNotice ok={!!sp.ok} error={sp.error} />
      {orgUnreadable && (
        <section className={cardCls}>
          <h2 className="mb-1 text-sm font-semibold">Starting hours for a new agent</h2>
          <UnreadableNotice className="mt-3">
            The starting hours for a new agent could not be read just now, so nothing is
            shown here. Reload in a moment. The stored defaults are unchanged, and
            adding an agent still applies them.
          </UnreadableNotice>
        </section>
      )}

      {org && (
        <section className={cardCls}>
          <h2 className="mb-1 text-sm font-semibold">Starting hours for a new agent</h2>
          <p className="mb-4 max-w-prose text-xs text-fg-muted">
            Only the hours a newly added agent begins with, and what the{" "}
            <strong>Use default hours</strong>{" "}button applies on an agent&apos;s page.
            Changing this moves nobody who is already set up, and it never widens the
            business hours above.
          </p>
          <form action={setOrgDefaultHours} className="flex flex-wrap items-end gap-3">
            <div>
              <label className={labelCls} htmlFor="default_timezone">
                Timezone
              </label>
              <input
                id="default_timezone"
                name="default_timezone"
                defaultValue={org.default_timezone}
                className={`${inputCls} w-44`}
              />
            </div>
            <div>
              <span className={labelCls}>Days</span>
              <div className="mt-1">
                <DayToggles
                  namePrefix="dday_"
                  isOn={(d) => org.default_weekdays.includes(d)}
                />
              </div>
            </div>
            <div>
              <span className={labelCls}>Start</span>
              <TimeField
                name="default_start"
                ariaLabel="New agent start time"
                defaultValue={minutesToTime(org.default_start_minute)}
                className="mt-1"
              />
            </div>
            <div>
              <span className={labelCls}>End</span>
              <TimeField
                name="default_end"
                ariaLabel="New agent end time"
                round="up"
                defaultValue={minutesToTime(org.default_end_minute)}
                className="mt-1"
              />
            </div>
            <SubmitButton className={btnCls} pendingLabel="Saving…">
              Save starting hours
            </SubmitButton>
          </form>
        </section>
      )}
    </>
  );
}

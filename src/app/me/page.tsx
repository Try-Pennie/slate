import { redirect } from "next/navigation";
import { DateTime } from "luxon";
import { currentUser } from "@/lib/auth";
import { oooOnlyFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { setMyWorkingHours, useMyDefaultHours } from "@/app/admin/actions";
import { cancelMyOoo, modifyMyOoo, submitMyOoo } from "@/app/me/actions";
import {
  formatWhenLine,
  normalizeTzLabel,
  oooApproverLine,
  oooRequestIntro,
  stripModifiedMarkers,
  NO_MANAGER_REVIEWER,
} from "@/lib/ooo/core";
import { AppHeader } from "@/components/AppHeader";
import { btnCls, cardCls } from "@/components/ui/styles";
import { Pill, type PillVariant } from "@/components/ui/Pill";
import { InfoIcon } from "@/components/icons";
import { WorkingHoursForm, workingHoursDays } from "@/components/ui/WorkingHoursForm";
import { OooForm } from "@/components/ui/OooForm";
import { RequestActions } from "@/components/ui/RequestActions";
import type { OooRequest, OooStatus, User } from "@/lib/db/types";

export const dynamic = "force-dynamic";

const OOO_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
];

const STATUS_PILL: Record<OooStatus, PillVariant> = {
  pending: "status-pending",
  approved: "status-ok",
  rejected: "status-error",
  cancelled: "outline",
};

// Module scope so the Date.now() calls don't trip react-hooks/purity in render.
// A pending request is always editable/cancellable (even one whose window has
// passed while it waited on a manager); an approved one only while it's still
// upcoming, since changing an elapsed approval does nothing useful.
function isChangeable(r: OooRequest): boolean {
  if (r.status === "pending") return true;
  return r.status === "approved" && Date.parse(r.ends_at) > Date.now();
}

function summarize(requests: OooRequest[]): {
  pending: number;
  upcomingApproved: number;
} {
  const now = Date.now();
  return {
    pending: requests.filter((r) => r.status === "pending").length,
    upcomingApproved: requests.filter(
      (r) => r.status === "approved" && Date.parse(r.ends_at) > now,
    ).length,
  };
}

/** Upcoming = still awaiting (pending) or approved and not yet over. */
function isUpcoming(r: OooRequest): boolean {
  if (r.status === "pending") return true;
  if (r.status === "approved") return Date.parse(r.ends_at) > Date.now();
  return false;
}

// Selectable date window for time-off: full calendar years, two back to two
// forward (e.g. in 2026 -> Jan 1 2024 through Dec 31 2028). Module scope so the
// Date.now() call doesn't trip react-hooks/purity in render.
function dateBounds(zone: string): {
  minISO: string;
  maxISO: string;
  todayISO: string;
} {
  const today = DateTime.now().setZone(zone).startOf("day");
  return {
    minISO: today.startOf("year").minus({ years: 2 }).toISODate()!,
    maxISO: today.endOf("year").plus({ years: 2 }).toISODate()!,
    todayISO: today.toISODate()!,
  };
}


/** Flat divider list of requests (shared by the Upcoming and Past sections). */
function RequestList({
  items,
  editingId,
}: {
  items: OooRequest[];
  editingId?: string;
}) {
  return (
    <ul className="mt-1 divide-y divide-border">
      {items.map((r) => {
        const isEditing = r.id === editingId;
        return (
        <li
          key={r.id}
          className={`flex items-start justify-between gap-4 py-4 ${
            isEditing
              ? "rounded-lg bg-pennie-sky-soft/60 px-3 dark:bg-accent/10"
              : ""
          }`}
        >
          <div className="min-w-0">
            <span className="block font-semibold tabular-nums text-fg">
              {formatWhenLine(
                r.starts_at,
                r.ends_at,
                r.display_tz_id,
                r.display_tz_label,
              )}
            </span>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
              <Pill variant={STATUS_PILL[r.status]}>{r.status}</Pill>
              <span>{r.reason}</span>
            </div>
            {r.status === "rejected" && r.rejection_note && (
              <p className="mt-1 text-sm text-error">{r.rejection_note}</p>
            )}
          </div>
          {isChangeable(r) &&
            (isEditing ? (
              <span className="inline-flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-sm font-semibold text-pennie-blue dark:text-pennie-sky">
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full bg-pennie-sky"
                />
                Editing above
              </span>
            ) : (
              <RequestActions requestId={r.id} cancelAction={cancelMyOoo} />
            ))}
        </li>
        );
      })}
    </ul>
  );
}

export default async function MePage({
  searchParams,
}: {
  searchParams: Promise<{
    ooo?: string;
    ooo_kind?: string;
    ooo_error?: string;
    edit?: string;
    t?: string;
  }>;
}) {
  const sp = await searchParams;
  const me = await currentUser();
  if (!me) redirect("/login");

  const oooOnly = oooOnlyFor(me.role);

  const db = supabaseAdmin();
  const { data: schedule } = await db
    .from("availability_schedules")
    .select("id, timezone")
    .eq("user_id", me.id)
    .maybeSingle();
  const sched = schedule as { id: string; timezone: string } | null;

  const { data: rulesData } = sched
    ? await db
        // cap-safe: the signed in agent's own schedule rules, at most a few per weekday.
        .from("availability_rules")
        .select("weekday, start_minute, end_minute")
        .eq("schedule_id", sched.id)
    : { data: [] };
  const rules = (rulesData ?? []) as {
    weekday: number;
    start_minute: number;
    end_minute: number;
  }[];
  // #1308: a window PER DAY, read back from each day's own rule rather than from
  // rules[0], which showed Monday's hours for the whole week and then overwrote
  // the rest on save.
  const hoursDays = workingHoursDays(rules);

  const { data: oooData } = await db
    .from("ooo_requests")
    .select("*")
    .eq("user_id", me.id)
    .order("created_at", { ascending: false })
    .limit(25);
  const oooRequests = (oooData ?? []) as OooRequest[];
  const manager = me.manager_id
    ? ((
        await db
          .from("users")
          .select("name, email")
          .eq("id", me.manager_id)
          .maybeSingle()
      ).data as Pick<User, "name" | "email"> | null)
    : null;
  const managerName = manager?.name ?? manager?.email ?? null;

  const editing =
    sp.edit !== undefined
      ? (oooRequests.find((r) => r.id === sp.edit && isChangeable(r)) ?? null)
      : null;
  const defaultTz = editing?.display_tz_id ?? sched?.timezone ?? "America/New_York";
  const tzOptions = OOO_TIMEZONES.includes(defaultTz)
    ? OOO_TIMEZONES
    : [defaultTz, ...OOO_TIMEZONES];
  const editStart = editing
    ? DateTime.fromISO(editing.starts_at, { zone: editing.display_tz_id })
    : null;
  const editEnd = editing
    ? DateTime.fromISO(editing.ends_at, { zone: editing.display_tz_id })
    : null;
  const bounds = dateBounds(defaultTz);
  const tzChoices = tzOptions.map((tz) => ({
    value: tz,
    label: `${tz.split("/")[1]?.replace(/_/g, " ") ?? tz} (${normalizeTzLabel(tz)})`,
  }));
  const editingForForm = editing
    ? {
        id: editing.id,
        whenLine: formatWhenLine(
          editing.starts_at,
          editing.ends_at,
          editing.display_tz_id,
          editing.display_tz_label,
        ),
        approved: editing.status === "approved",
        allDay: editing.all_day,
        startDate: editStart?.toISODate() ?? undefined,
        startTime: editStart?.toFormat("HH:mm") ?? undefined,
        endDate: editEnd?.toISODate() ?? undefined,
        endTime: editEnd?.toFormat("HH:mm") ?? undefined,
        reason: editing.reason,
        // Don't surface the internal "[Modified …]" marker in the editable field.
        notes: stripModifiedMarkers(editing.notes ?? ""),
      }
    : null;

  const firstName = me.name?.trim().split(/\s+/)[0] ?? null;
  const summary = summarize(oooRequests);
  const hasRequests = oooRequests.length > 0;
  // Soonest-first for upcoming; most-recent-first (query order) for past.
  const upcoming = oooRequests
    .filter(isUpcoming)
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  const past = oooRequests.filter((r) => !isUpcoming(r));

  return (
    <>
      <AppHeader
        email={me.email}
        role={me.role}
        active="me"
        themePreference={me.theme_preference}
        userId={me.id}
        orgId={me.org_id}
        bookable={me.bookable}
        avatarUrl={me.avatar_url}
      />
      <main className="mx-auto w-full min-w-0 max-w-2xl space-y-10 px-6 py-10 sm:px-8">
        {oooOnly ? (
          /* Compact navy header: greeting + at-a-glance status (earns its weight). */
          <section className="rounded-xl bg-pennie-navy px-7 py-6 dark:bg-surface-elevated dark:border dark:border-border">
            <h1 className="pn-h3 text-pennie-beige">
              {firstName ? `Hi, ${firstName}.` : "Hi there."}
            </h1>
            <p className="mt-2 text-pennie-beige/85">
              {!hasRequests ? (
                // #1499: no manager of record is not a blocker. It routes to
                // whoever moderates all time off, and the copy says so rather
                // than naming a step nobody can perform (the admin field is read
                // only, because Salesforce owns the link).
                oooRequestIntro(managerName)
              ) : summary.pending === 0 && summary.upcomingApproved === 0 ? (
                "Nothing pending. Need another day off? Request it below."
              ) : (
                <>
                  {summary.pending > 0 && (
                    <span>
                      <span className="font-semibold tabular-nums text-pennie-beige">
                        {summary.pending}
                      </span>{" "}
                      waiting on {managerName ?? NO_MANAGER_REVIEWER}
                    </span>
                  )}
                  {summary.pending > 0 && summary.upcomingApproved > 0 && (
                    <span className="px-2 text-pennie-beige/40">·</span>
                  )}
                  {summary.upcomingApproved > 0 && (
                    <span>
                      <span className="font-semibold tabular-nums text-pennie-beige">
                        {summary.upcomingApproved}
                      </span>{" "}
                      approved and coming up
                    </span>
                  )}
                </>
              )}
            </p>
          </section>
        ) : (
          <>
            <div>
              <h1 className="pn-h3">Your availability</h1>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
                <span>{me.name ?? me.email}</span>
                <Pill variant={me.bookable ? "status-ok" : "outline"}>
                  {me.bookable ? "Bookable" : "Not bookable yet"}
                </Pill>
              </p>
            </div>

            {rules.length === 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-pennie-sky-soft p-4 text-sm text-fg dark:bg-accent/15">
                <span className="flex items-center gap-2.5">
                  <InfoIcon
                    width={20}
                    height={20}
                    className="shrink-0 text-pennie-blue dark:text-pennie-sky"
                  />
                  You have no working hours set, so you won&apos;t get bookings.
                </span>
                <form action={useMyDefaultHours}>
                  <button className={btnCls}>Use default hours</button>
                </form>
              </div>
            )}

            <section className={cardCls}>
              <h2 className="mb-1 text-sm font-semibold">Working hours</h2>
              <p className="mb-4 text-xs text-fg-muted">
                Set your home timezone and weekly hours. Leads always see times in
                their own timezone.
              </p>
              <WorkingHoursForm
                action={setMyWorkingHours}
                days={hoursDays}
                timezone={sched?.timezone ?? "America/New_York"}
                timezoneLabel="Your timezone"
              />
              <form action={useMyDefaultHours} className="mt-3">
                <button className="text-xs text-pennie-blue underline dark:text-pennie-sky">
                  Reset to company default hours
                </button>
              </form>
            </section>
          </>
        )}

        {/* Time off (shared by agents and managers viewing their own page) */}
        <section id="time-off" className="scroll-mt-20 space-y-6">
          <header>
            <h2 className="pn-h3">
              {editing ? "Change your request" : "Request time away"}
            </h2>
            <p className="mt-1.5 text-sm text-fg-muted">
              {oooApproverLine(managerName)}
            </p>
          </header>

          {sp.ooo_error && (
            <div
              role="alert"
              className="rounded-md border border-[var(--error)] px-5 py-4 text-sm text-error"
            >
              {sp.ooo_error}
            </div>
          )}

          <OooForm
            key={sp.t ?? sp.edit ?? "new"}
            action={editing ? modifyMyOoo : submitMyOoo}
            editing={editingForForm}
            managerName={managerName}
            defaultTz={defaultTz}
            tzOptions={tzChoices}
            bounds={bounds}
            successMessage={sp.ooo ?? null}
            successKind={sp.ooo_kind ?? null}
          />

          <div className="space-y-8">
            <div>
              <p className="pn-eyebrow text-fg-muted">
                Upcoming
                {upcoming.length > 0 && (
                  <span className="tabular-nums"> ({upcoming.length})</span>
                )}
              </p>
              {upcoming.length === 0 ? (
                <p className="mt-3 rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-fg-muted">
                  No upcoming time off. Use the form above to request a day.
                </p>
              ) : (
                <RequestList items={upcoming} editingId={editing?.id} />
              )}
            </div>

            {past.length > 0 && (
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky [&::-webkit-details-marker]:hidden">
                  <svg
                    viewBox="0 0 16 16"
                    aria-hidden="true"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-3.5 w-3.5 shrink-0 text-fg-muted transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
                  >
                    <path d="M6 4l4 4-4 4" />
                  </svg>
                  <span className="pn-eyebrow text-fg-muted">
                    Past <span className="tabular-nums">({past.length})</span>
                  </span>
                </summary>
                <div className="mt-3">
                  <RequestList items={past} />
                </div>
              </details>
            )}
          </div>
        </section>

        {!oooOnly && (
          <p className="text-sm text-fg-muted">
            Your manager controls whether you&apos;re bookable and which teams
            you&apos;re on.
          </p>
        )}
      </main>
    </>
  );
}

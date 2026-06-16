import { redirect } from "next/navigation";
import { DateTime } from "luxon";
import { currentUser } from "@/lib/auth";
import { agentSchedulingLive } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { setMyWorkingHours, useMyDefaultHours } from "@/app/admin/actions";
import { cancelMyOoo, modifyMyOoo, submitMyOoo } from "@/app/me/actions";
import { formatWhenLine, normalizeTzLabel } from "@/lib/ooo/core";
import { AppHeader } from "@/components/AppHeader";
import { labelCls, inputCls, btnCls, cardCls } from "@/components/ui/styles";
import { Pill, type PillVariant } from "@/components/ui/Pill";
import { InfoIcon } from "@/components/icons";
import { DateTimeField } from "@/components/ui/DateTimeField";
import { TimeField } from "@/components/ui/TimeField";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { OooRequest, OooStatus, User } from "@/lib/db/types";

export const dynamic = "force-dynamic";

function minutesToTime(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

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
function isChangeable(r: OooRequest): boolean {
  return (
    (r.status === "pending" || r.status === "approved") &&
    Date.parse(r.ends_at) > Date.now()
  );
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

// Form fields get a visible border so they don't vanish on the white card
// (inputCls relies on a faint shadow alone, which is white-on-white here).
const fieldBaseCls =
  "h-[44px] rounded-sm border border-border bg-[var(--field)] px-3 text-fg placeholder:text-fg-muted";
const tzInputCls = `${fieldBaseCls} text-sm`;
// Graphite (not muted) labels — these are fields the agent has to read and fill.
const formLabelCls = "block text-xs font-semibold text-fg";

/** Flat divider list of requests (shared by the Upcoming and Past sections). */
function RequestList({ items }: { items: OooRequest[] }) {
  return (
    <ul className="mt-1 divide-y divide-border">
      {items.map((r) => (
        <li
          key={r.id}
          className="flex flex-wrap items-center justify-between gap-3 py-4"
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold tabular-nums text-fg">
                {formatWhenLine(
                  r.starts_at,
                  r.ends_at,
                  r.display_tz_id,
                  r.display_tz_label,
                )}
              </span>
              <Pill variant={STATUS_PILL[r.status]}>{r.status}</Pill>
            </div>
            <p className="mt-1 text-sm text-fg-muted">{r.reason}</p>
            {r.status === "rejected" && r.rejection_note && (
              <p className="mt-1 text-sm text-error">{r.rejection_note}</p>
            )}
          </div>
          {isChangeable(r) && (
            <div className="flex items-center gap-1">
              <a
                href={`/me?edit=${r.id}#time-off`}
                className="rounded-md px-3 py-1.5 text-sm font-semibold text-fg transition-colors hover:bg-pennie-sky-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky dark:hover:bg-accent/15"
              >
                Edit
              </a>
              <form action={cancelMyOoo}>
                <input type="hidden" name="request_id" value={r.id} />
                <button className="rounded-md px-3 py-1.5 text-sm font-semibold text-fg-muted transition-colors hover:bg-error/10 hover:text-error focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky">
                  Cancel
                </button>
              </form>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export default async function MePage({
  searchParams,
}: {
  searchParams: Promise<{
    ooo?: string;
    ooo_error?: string;
    edit?: string;
    t?: string;
  }>;
}) {
  const sp = await searchParams;
  const me = await currentUser();
  if (!me) redirect("/login");

  // OOO-only launch phase: agents see just the time off tool, no scheduling.
  const oooOnly = me.role === "agent" && !agentSchedulingLive();

  const db = supabaseAdmin();
  const { data: schedule } = await db
    .from("availability_schedules")
    .select("id, timezone")
    .eq("user_id", me.id)
    .maybeSingle();
  const sched = schedule as { id: string; timezone: string } | null;

  const { data: rulesData } = sched
    ? await db
        .from("availability_rules")
        .select("weekday, start_minute, end_minute")
        .eq("schedule_id", sched.id)
    : { data: [] };
  const rules = (rulesData ?? []) as {
    weekday: number;
    start_minute: number;
    end_minute: number;
  }[];
  const days = new Set(rules.map((r) => r.weekday));
  const start = rules[0]?.start_minute ?? 540;
  const end = rules[0]?.end_minute ?? 1020;

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
                managerName
                  ? `Need a day off? Request it below and ${managerName} takes it from there.`
                  : "Need a day off? An admin needs to set your manager before you can request."
              ) : summary.pending === 0 && summary.upcomingApproved === 0 ? (
                "Nothing pending. Need another day off? Request it below."
              ) : (
                <>
                  {summary.pending > 0 && (
                    <span>
                      <span className="font-semibold tabular-nums text-pennie-beige">
                        {summary.pending}
                      </span>{" "}
                      waiting on {managerName ?? "your manager"}
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
              <form
                action={setMyWorkingHours}
                className="flex flex-wrap items-end gap-3"
              >
                <div>
                  <label className={labelCls}>Your timezone</label>
                  <input
                    name="timezone"
                    aria-label="Your timezone"
                    defaultValue={sched?.timezone ?? "America/New_York"}
                    className={`${inputCls} w-48`}
                  />
                </div>
                <div>
                  <span className={labelCls}>Days</span>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {(
                      [
                        [1, "M"],
                        [2, "T"],
                        [3, "W"],
                        [4, "T"],
                        [5, "F"],
                        [6, "S"],
                        [7, "S"],
                      ] as [number, string][]
                    ).map(([d, lbl], i) => (
                      <label key={i} className="cursor-pointer">
                        <input
                          type="checkbox"
                          name={`day_${d}`}
                          defaultChecked={rules.length ? days.has(d) : d <= 5}
                          className="peer sr-only"
                        />
                        <span className="flex h-11 w-11 items-center justify-center rounded-full border border-border text-sm font-semibold text-fg-muted transition-colors peer-checked:border-transparent peer-checked:bg-pennie-sky peer-checked:text-pennie-graphite peer-hover:border-fg/40 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--focus-ring)]">
                          {lbl}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <label className={labelCls}>Start</label>
                  <TimeField
                    name="start"
                    ariaLabel="Start"
                    defaultValue={minutesToTime(start)}
                    className="mt-1"
                  />
                </div>
                <div>
                  <label className={labelCls}>End</label>
                  <TimeField
                    name="end"
                    ariaLabel="End"
                    round="up"
                    defaultValue={minutesToTime(end)}
                    className="mt-1"
                  />
                </div>
                <button className={btnCls}>Save</button>
              </form>
              <form action={useMyDefaultHours} className="mt-3">
                <button className="text-xs text-pennie-blue underline dark:text-pennie-sky">
                  Reset to company default hours
                </button>
              </form>
            </section>
          </>
        )}

        {/* Time off (shared by agents and managers viewing their own page) */}
        <section id="time-off" className="scroll-mt-8 space-y-6">
          <header>
            <h2 className="pn-h3">
              {editing ? "Change your request" : "Request time away"}
            </h2>
            <p className="mt-1.5 text-sm text-fg-muted">
              {managerName
                ? `${managerName} signs off on these.`
                : "Ask an admin to set your manager before you can request."}
            </p>
          </header>

          {sp.ooo && (
            <div
              role="status"
              className="pn-confirm-enter flex items-start gap-3 rounded-md bg-pennie-sky-soft px-5 py-4 dark:bg-accent/15"
            >
              <span
                aria-hidden="true"
                className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-pennie-sky text-pennie-graphite"
              >
                <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <div>
                <p className="font-semibold text-fg">Request sent!</p>
                <p className="mt-0.5 text-sm text-fg">{sp.ooo}</p>
              </div>
            </div>
          )}
          {sp.ooo_error && (
            <div
              role="alert"
              className="rounded-md border border-[var(--error)] px-5 py-4 text-sm text-error"
            >
              {sp.ooo_error}
            </div>
          )}

          {editing && (
            <p className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
              <span>
                Changing{" "}
                <span className="font-semibold tabular-nums text-fg">
                  {formatWhenLine(
                    editing.starts_at,
                    editing.ends_at,
                    editing.display_tz_id,
                    editing.display_tz_label,
                  )}
                </span>
                {editing.status === "approved" &&
                  ". Saving sends it back for approval."}
              </span>
            </p>
          )}

          <form
            key={sp.t ?? sp.edit ?? "new"}
            action={editing ? modifyMyOoo : submitMyOoo}
            className="rounded-md bg-surface p-6 shadow-xs dark:border dark:border-border"
          >
            {editing && <input type="hidden" name="request_id" value={editing.id} />}

            <div className="space-y-4">
              <div>
                <label className={formLabelCls}>Start date and time</label>
                <div className="mt-1">
                  <DateTimeField
                    nameDate="start_date"
                    nameTime="start_time"
                    ariaLabel="Start date and time"
                    defaultDate={editStart?.toISODate() ?? undefined}
                    defaultTime={editStart?.toFormat("HH:mm") ?? undefined}
                    min={bounds.minISO}
                    max={bounds.maxISO}
                    todayISO={bounds.todayISO}
                  />
                </div>
              </div>
              <div>
                <label className={formLabelCls}>End date and time</label>
                <div className="mt-1">
                  <DateTimeField
                    nameDate="end_date"
                    nameTime="end_time"
                    ariaLabel="End date and time"
                    round="up"
                    defaultDate={editEnd?.toISODate() ?? undefined}
                    defaultTime={editEnd?.toFormat("HH:mm") ?? undefined}
                    min={bounds.minISO}
                    max={bounds.maxISO}
                    todayISO={bounds.todayISO}
                  />
                </div>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
              <label className="flex min-h-11 items-center gap-2 text-sm text-fg">
                <input type="checkbox" name="all_day" className="accent-pennie-sky" />
                All day
              </label>
              <label className="flex items-center gap-2">
                <span className="pn-eyebrow text-fg-muted">Timezone</span>
                <select
                  name="timezone"
                  aria-label="Timezone"
                  defaultValue={defaultTz}
                  className={tzInputCls}
                >
                  {tzOptions.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz.split("/")[1]?.replace(/_/g, " ") ?? tz} (
                      {normalizeTzLabel(tz)})
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="mt-4">
              <label className={formLabelCls}>Reason</label>
              <input
                name="reason"
                required
                aria-label="Reason"
                placeholder="Vacation, appointment, family"
                defaultValue={editing?.reason ?? ""}
                className={`${fieldBaseCls} mt-1 w-full`}
              />
            </div>
            <div className="mt-4">
              <label className={formLabelCls}>
                Anything your manager should know? (optional)
              </label>
              <input
                name="notes"
                aria-label="Notes for your manager (optional)"
                defaultValue={editing?.notes ?? ""}
                className={`${fieldBaseCls} mt-1 w-full`}
              />
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-4">
              <SubmitButton
                className="pn-btn pn-btn--big pn-btn--primary"
                pendingLabel={editing ? "Sending…" : "Submitting…"}
              >
                {editing ? "Send my changes" : "Request time off"}
              </SubmitButton>
              {editing && (
                <a
                  href="/me#time-off"
                  className="rounded-md px-3 py-1.5 text-sm font-semibold text-fg-muted transition-colors hover:bg-pennie-sky-soft hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky dark:hover:bg-accent/15"
                >
                  Keep it as is
                </a>
              )}
            </div>
          </form>

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
                <RequestList items={upcoming} />
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

import { redirect } from "next/navigation";
import { DateTime } from "luxon";
import { currentUser } from "@/lib/auth";
import { agentSchedulingLive } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { setMyWorkingHours, useMyDefaultHours } from "@/app/admin/actions";
import { cancelMyOoo, modifyMyOoo, submitMyOoo } from "@/app/me/actions";
import { formatWhenLine, normalizeTzLabel } from "@/lib/ooo/core";
import { AppHeader } from "@/components/AppHeader";
import { labelCls, inputCls, btnCls, btnSecondaryCls, cardCls } from "@/components/ui/styles";
import { Pill, type PillVariant } from "@/components/ui/Pill";
import { InfoIcon } from "@/components/icons";
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

// Module scope so the Date.now() call doesn't trip react-hooks/purity in render.
function isChangeable(r: OooRequest): boolean {
  return (
    (r.status === "pending" || r.status === "approved") &&
    Date.parse(r.ends_at) > Date.now()
  );
}

export default async function MePage({
  searchParams,
}: {
  searchParams: Promise<{ ooo?: string; ooo_error?: string; edit?: string }>;
}) {
  const sp = await searchParams;
  const me = await currentUser();
  if (!me) redirect("/login");

  // OOO-only launch phase: agents see just the time off tool, no scheduling
  // (working hours, bookable status, Google reconnect). Managers/admins keep
  // their availability self-service. Flip AGENT_SCHEDULING_LIVE=true to reveal.
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

  const editing =
    sp.edit !== undefined
      ? (oooRequests.find((r) => r.id === sp.edit && isChangeable(r)) ?? null)
      : null;
  const defaultTz = editing?.display_tz_id ?? sched?.timezone ?? "America/New_York";
  const editStart = editing
    ? DateTime.fromISO(editing.starts_at, { zone: editing.display_tz_id })
    : null;
  const editEnd = editing
    ? DateTime.fromISO(editing.ends_at, { zone: editing.display_tz_id })
    : null;

  return (
    <>
    <AppHeader email={me.email} role={me.role} active="me" />
    <main className="mx-auto w-full min-w-0 max-w-xl space-y-6 p-8">
      <div>
        <h1 className="pn-h3">{oooOnly ? "Time off" : "Your availability"}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
          <span>{me.name ?? me.email}</span>
          {!oooOnly && (
            <Pill variant={me.bookable ? "status-ok" : "outline"}>
              {me.bookable ? "Bookable" : "Not bookable yet"}
            </Pill>
          )}
        </p>
      </div>

      {!oooOnly && rules.length === 0 && (
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

      {!oooOnly && (
      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">Working hours</h2>
        <p className="mb-4 text-xs text-fg-muted">
          Set your home timezone and weekly hours. Leads always see times in their
          own timezone.
        </p>
        <form action={setMyWorkingHours} className="flex flex-wrap items-end gap-3">
          <div>
            <label className={labelCls}>Your timezone</label>
            <input
              name="timezone"
              aria-label="Your timezone"
              defaultValue={sched?.timezone ?? "America/New_York"}
              className={`${inputCls} w-48`}
            />
          </div>
          <div className="flex gap-1">
            {[
              [1, "M"],
              [2, "T"],
              [3, "W"],
              [4, "T"],
              [5, "F"],
              [6, "S"],
              [7, "S"],
            ].map(([d, lbl]) => (
              <label
                key={d}
                className="flex flex-col items-center text-xs text-fg-muted"
              >
                {lbl}
                <input
                  type="checkbox"
                  name={`day_${d}`}
                  className="accent-pennie-sky"
                  defaultChecked={
                    rules.length ? days.has(Number(d)) : Number(d) <= 5
                  }
                />
              </label>
            ))}
          </div>
          <div>
            <label className={labelCls}>Start</label>
            <input
              name="start"
              type="time"
              aria-label="Start"
              defaultValue={minutesToTime(start)}
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>End</label>
            <input
              name="end"
              type="time"
              aria-label="End"
              defaultValue={minutesToTime(end)}
              className={inputCls}
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
      )}

      <section id="time-off" className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">Time off</h2>
        <p className="mb-4 text-xs text-fg-muted">
          {manager
            ? `Requests go to ${manager.name ?? manager.email} for approval.${oooOnly ? "" : " Approved time off blocks your booking availability."}`
            : "Ask an admin to set your manager before requesting time off."}
        </p>

        {sp.ooo && (
          <div className="mb-4 flex items-center gap-2.5 rounded-md bg-[var(--pennie-green-wash)] p-4 text-sm text-fg">
            <InfoIcon width={20} height={20} className="shrink-0" />
            {sp.ooo}
          </div>
        )}
        {sp.ooo_error && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-[var(--error)] p-4 text-sm text-error"
          >
            {sp.ooo_error}
          </div>
        )}

        {editing && (
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-fg">
            <Pill variant="status-pending">Editing</Pill>
            <span>
              Changing your request for{" "}
              {formatWhenLine(
                editing.starts_at,
                editing.ends_at,
                editing.display_tz_id,
                editing.display_tz_label,
              )}
              {editing.status === "approved" &&
                ". Saving sends it back to your manager for approval."}
            </span>
            <a href="/me#time-off" className="text-pennie-blue underline dark:text-pennie-sky">
              Keep it as is
            </a>
          </div>
        )}

        <form
          action={editing ? modifyMyOoo : submitMyOoo}
          className="flex flex-wrap items-end gap-3"
        >
          {editing && <input type="hidden" name="request_id" value={editing.id} />}
          <div>
            <label className={labelCls}>First day</label>
            <input
              name="start_date"
              type="date"
              required
              aria-label="First day"
              defaultValue={editStart?.toISODate() ?? undefined}
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>From</label>
            <input
              name="start_time"
              type="time"
              aria-label="From"
              defaultValue={editStart?.toFormat("HH:mm") ?? "09:00"}
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>Last day</label>
            <input
              name="end_date"
              type="date"
              required
              aria-label="Last day"
              defaultValue={editEnd?.toISODate() ?? undefined}
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>Until</label>
            <input
              name="end_time"
              type="time"
              aria-label="Until"
              defaultValue={editEnd?.toFormat("HH:mm") ?? "17:00"}
              className={inputCls}
            />
          </div>
          <label className="flex min-h-11 items-center gap-2 text-sm text-fg">
            <input type="checkbox" name="all_day" className="accent-pennie-sky" />
            All day
          </label>
          <div>
            <label className={labelCls}>Timezone</label>
            <select
              name="timezone"
              aria-label="Timezone"
              defaultValue={defaultTz}
              className={`${inputCls} w-48`}
            >
              {(OOO_TIMEZONES.includes(defaultTz)
                ? OOO_TIMEZONES
                : [defaultTz, ...OOO_TIMEZONES]
              ).map((tz) => (
                <option key={tz} value={tz}>
                  {tz.split("/")[1]?.replace(/_/g, " ") ?? tz} ({normalizeTzLabel(tz)})
                </option>
              ))}
            </select>
          </div>
          <div className="w-full">
            <label className={labelCls}>Reason</label>
            <input
              name="reason"
              required
              aria-label="Reason"
              placeholder="Vacation, appointment, family"
              defaultValue={editing?.reason ?? ""}
              className={inputCls}
            />
          </div>
          <div className="w-full">
            <label className={labelCls}>Notes for your manager (optional)</label>
            <input
              name="notes"
              aria-label="Notes for your manager (optional)"
              defaultValue={editing?.notes ?? ""}
              className={inputCls}
            />
          </div>
          <button className={btnCls}>
            {editing ? "Send my changes" : "Request time off"}
          </button>
        </form>

        {oooRequests.length > 0 && (
          <div className="mt-6 space-y-4">
            <h3 className="text-xs font-semibold text-fg-muted">Your requests</h3>
            {oooRequests.map((r) => (
              <div
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3"
              >
                <div className="min-w-0 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span>
                      {formatWhenLine(
                        r.starts_at,
                        r.ends_at,
                        r.display_tz_id,
                        r.display_tz_label,
                      )}
                    </span>
                    <Pill variant={STATUS_PILL[r.status]}>{r.status}</Pill>
                  </div>
                  <p className="mt-0.5 text-xs text-fg-muted">{r.reason}</p>
                  {r.status === "rejected" && r.rejection_note && (
                    <p className="mt-0.5 text-xs text-error">{r.rejection_note}</p>
                  )}
                </div>
                {isChangeable(r) && (
                  <div className="flex items-center gap-2">
                    <a
                      href={`/me?edit=${r.id}#time-off`}
                      className={btnSecondaryCls}
                    >
                      Edit request
                    </a>
                    <form action={cancelMyOoo}>
                      <input type="hidden" name="request_id" value={r.id} />
                      <button className={btnSecondaryCls}>Cancel request</button>
                    </form>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {!oooOnly && (
        <p className="text-sm text-fg-muted">
          Your manager controls whether you&apos;re bookable and which teams you&apos;re on.
        </p>
      )}
    </main>
    </>
  );
}

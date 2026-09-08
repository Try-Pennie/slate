import { redirect } from "next/navigation";
import { DateTime } from "luxon";
import { currentUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { cancelMyOoo, modifyMyOoo, submitMyOoo } from "@/app/me/actions";
import {
  formatWhenLine,
  normalizeTzLabel,
  oooApproverLine,
  oooRequestIntro,
  stripModifiedMarkers,
  NO_MANAGER_REVIEWER,
  UNNAMED_MANAGER_REVIEWER,
} from "@/lib/ooo/core";
import { UnreadableNotice } from "@/components/ui/UnreadableNotice";
import { proseCls } from "@/components/ui/styles";
import { Pill, type PillVariant } from "@/components/ui/Pill";
import { OooForm } from "@/components/ui/OooForm";
import { RequestActions } from "@/components/ui/RequestActions";
import type { OooRequest, OooStatus, User } from "@/lib/db/types";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";

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

/**
 * My Time Off.
 *
 * Split out of `/me` on 2026-09-08. That page carried this AND the working
 * hours, which are different questions asked at different moments: hours are set
 * when you join and edited when your life changes, time off is asked for the
 * week before a holiday. Stacking them put the hours card below a form most
 * visits did not need.
 *
 * It was also called "My Requests", which named the mechanism and not the
 * subject, so the tab said nothing about what was being requested (Dan,
 * 2026-09-08).
 */
export default async function MeTimeOffPage({
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

  // #1647: every read on this page binds `error`. Each one feeds a surface that
  // either OFFERS A WRITE over what it shows or makes a claim about what is
  // stored, so a dropped error draws exactly the screen a genuinely empty answer
  // draws, and the obvious correction is a request made from a reading that
  // never happened.
  const db = supabaseAdmin();
  const { data: schedule, error: schedErr } = await db
    .from("availability_schedules")
    .select("timezone")
    .eq("user_id", me.id)
    .maybeSingle();
  const sched = schedErr ? null : (schedule as { timezone: string } | null);

  const { data: oooData, error: oooErr } = await db
    .from("ooo_requests")
    .select("*")
    .eq("user_id", me.id)
    .order("created_at", { ascending: false })
    .limit(25);
  // Empty means "you have asked for no time off", on the page somebody opens to
  // ask exactly that, and it also silently turns a CHANGE into a new request: the
  // edit below resolves against this list, so a failed read leaves `editing` null
  // and the change form becomes a fresh submission for the same days.
  const oooUnreadable = oooErr != null;
  const oooRequests = (oooData ?? []) as OooRequest[];

  const { data: managerData, error: managerErr } = me.manager_id
    ? await db.from("users").select("name, email").eq("id", me.manager_id).maybeSingle()
    : { data: null, error: null };
  const manager = managerData as Pick<User, "name" | "email"> | null;
  // Three states, not two. `null` here is read as "no manager of record", which
  // routes the copy to the moderator pool, and saying that to somebody who HAS a
  // manager is a claim the read never measured (L11). This branch is reachable
  // only when `me.manager_id` is set, so a manager provably exists; the reviewer
  // is named generically rather than not at all.
  const reviewerName = managerErr
    ? UNNAMED_MANAGER_REVIEWER
    : (manager?.name ?? manager?.email ?? null);

  const editing =
    sp.edit !== undefined
      ? (oooRequests.find((r) => r.id === sp.edit && isChangeable(r)) ?? null)
      : null;
  // A change was asked for and the list that would resolve it could not be read.
  // Distinct from "that request is not changeable", which is a real answer.
  const editUnresolvable = sp.edit !== undefined && oooUnreadable;
  // The one place an unreadable schedule degrades rather than refusing, and it is
  // the safe class (#1647): this is the zone the time off picker OPENS on, shown
  // as a labelled select the person reads and submits, and nothing here replaces
  // stored hours. Falling back to the roster's canonical zone leaves a visible,
  // correctable default instead of taking time off away over an hours read.
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
      {/* The greeting plus at-a-glance status. #1838 made this the same card
          the console uses; Dan chose to convert /me too, so no navy page
          header survives anywhere in the app. */}
      <AdminPageHeader title={firstName ? `Hi, ${firstName}.` : "Hi there."}>
        <p>
          {oooUnreadable ? (
            // #1647: every other sentence in this band is a count, and a
            // count off a read that never ran is the one thing this greeting
            // must not say. Plain copy rather than the rose notice: the
            // announced version of this lives once, on the list below, so a
            // screen reader is told the same thing once rather than twice.
            "Your time off could not be read just now, so there is nothing summarized here. Reload to try again."
          ) : !hasRequests ? (
            // #1499: no manager of record is not a blocker. It routes to
            // whoever moderates all time off, and the copy says so rather
            // than naming a step nobody can perform (the admin field is read
            // only, because Salesforce owns the link).
            oooRequestIntro(reviewerName)
          ) : summary.pending === 0 && summary.upcomingApproved === 0 ? (
            "Nothing pending. Need another day off? Request it below."
          ) : (
            <>
              {summary.pending > 0 && (
                <span>
                  <span className="font-semibold tabular-nums text-fg">
                    {summary.pending}
                  </span>{" "}
                  waiting on {reviewerName ?? NO_MANAGER_REVIEWER}
                </span>
              )}
              {summary.pending > 0 && summary.upcomingApproved > 0 && (
                <span className="px-2 text-fg-muted">·</span>
              )}
              {summary.upcomingApproved > 0 && (
                <span>
                  <span className="font-semibold tabular-nums text-fg">
                    {summary.upcomingApproved}
                  </span>{" "}
                  approved and coming up
                </span>
              )}
            </>
          )}
        </p>
      </AdminPageHeader>

      <section className="space-y-6">
        <header>
          <h2 className="pn-h3">
            {editing || editUnresolvable
              ? "Change your request"
              : "Request time off"}
          </h2>
          <p className={`mt-1.5 text-sm text-fg-muted ${proseCls}`}>
            {oooApproverLine(reviewerName)}
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

        {editUnresolvable ? (
          /* #1647: a change was asked for and the request it is about could not
             be read. Rendering the form anyway is not a degraded change, it is
             a NEW request: `editing` is null, so the action is submitMyOoo and
             the agent ends up with two requests for the same days. */
          <UnreadableNotice>
            That request could not be read just now, so it cannot be changed
            here yet. Nothing has been altered. Reload to try again.
          </UnreadableNotice>
        ) : (
          <OooForm
            key={sp.t ?? sp.edit ?? "new"}
            action={editing ? modifyMyOoo : submitMyOoo}
            editing={editingForForm}
            managerName={reviewerName}
            defaultTz={defaultTz}
            tzOptions={tzChoices}
            bounds={bounds}
            successMessage={sp.ooo ?? null}
            successKind={sp.ooo_kind ?? null}
          />
        )}

        <div className="space-y-8">
          <div>
            <p className="pn-eyebrow text-fg-muted">
              Upcoming
              {!oooUnreadable && upcoming.length > 0 && (
                <span className="tabular-nums"> ({upcoming.length})</span>
              )}
            </p>
            {oooUnreadable ? (
              /* The empty version of this list answers "have I already asked
                 for these days?" with a wrong no, and the reply to that answer
                 is to ask again. */
              <UnreadableNotice className="mt-3">
                Your time off requests could not be read just now, so none are
                listed. This is not a sign that you have none. Reload to try
                again.
              </UnreadableNotice>
            ) : upcoming.length === 0 ? (
              <p className="mt-3 rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-fg-muted">
                No upcoming time off. Use the form above to request a day.
              </p>
            ) : (
              <RequestList items={upcoming} editingId={editing?.id} />
            )}
          </div>

          {!oooUnreadable && past.length > 0 && (
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-sm [&::-webkit-details-marker]:hidden">
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
    </>
  );
}

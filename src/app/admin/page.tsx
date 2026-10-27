import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { currentUser } from "@/lib/auth";
import { canEditOrgSettings, canManageAgents } from "@/lib/auth/roles";
import { consoleHiddenFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isActive } from "@/lib/active-user";
import { readPublicBookingPaused } from "@/lib/booking/settings";
import { loadLaneHealth } from "@/lib/monitor/lane-health-view";
import { readAllHeartbeatMs } from "@/lib/monitor/heartbeat";
import { cronLanesNote, type LaneHealthRow } from "@/lib/monitor/health";
import { dedupeFailingAgents, type FailingCalendarRow } from "@/lib/notify/alerts";
import { CronLaneHealth, agoPhrase, summariseLanes } from "@/components/CronLaneHealth";
import { SyncHealthPanel, type SyncHealthRow } from "@/components/ui/SyncHealthPanel";
import { UnreadableNotice } from "@/components/ui/UnreadableNotice";
import { AdminPageHeader, AdminDenied } from "@/components/admin/AdminPageHeader";
import { cardCls, proseCls } from "@/components/ui/styles";
import { DRAIN_ALERT_AFTER } from "@/lib/booking/drain-backoff";
import {
  normalizeOutboxRow,
  normalizeReservationRow,
  summarizeStuck,
  type StuckRow,
} from "@/lib/booking/stuck-drain";
import { StuckDeliveriesPanel } from "@/components/admin/StuckDeliveriesPanel";
import type { BookingOutbox, BookingReservation } from "@/lib/db/types";
import type { User } from "@/lib/db/types";
import { realAdvisorsOnly } from "@/lib/advisors/real-advisor";

export const metadata = { title: "Health" };

export const dynamic = "force-dynamic";

/**
 * The console's Overview (#1748), rebuilt by #1767.
 *
 * `/admin` used to be all fifteen sections at once. It is now the one thing that
 * is worth seeing first and cannot wait: how much of the fleet is bookable,
 * whether the push channels are held, which agents' calendars are in a failure
 * streak, and whether the cron lanes are alive.
 *
 * **It states what was CHECKED, not only what is wrong.** Every substantial
 * element used to be conditional on something being broken (the sync panel draws
 * nothing when no calendar is failing, the unreadable notices draw nothing when
 * the reads succeed), so the better the fleet was doing the emptier this page
 * got, and a fully healthy Overview was close to indistinguishable from one that
 * had failed to render its own content. One row per thing the page verifies now,
 * each carrying its own verdict, so an all clear is a positive statement rather
 * than the absence of a warning.
 *
 * Every row keeps the THREE WAY distinction: measured healthy, measured bad, and
 * could-not-measure (#1629, #1646, L530). It is never flattened to a tick or a
 * cross, and a count derived from an unreadable read renders as unknown rather
 * than as a zero nothing measured.
 */

/** The verdict a row carries. Three states, never two. */
type Verdict = "ok" | "attention" | "unmeasured";

interface StatusRow {
  key: string;
  label: string;
  /**
   * What this row is about, in words, always visible under its label (#1872).
   *
   * Dan, clicking through this page: "basically all of this needs explanations,
   * so he and others know what the terms mean." Nothing on it said what Fleet,
   * Calendar push, Calendar sync or Cron lanes were, nor what bookable, on push
   * or a failure streak meant.
   *
   * REQUIRED, not optional, so a row added later cannot ship as a bare label
   * with a number beside it, which is the state this replaced.
   */
  note: string;
  /** What this row measured, in words. May expand in place on a bad day. */
  detail: ReactNode;
  verdict: Verdict;
  /**
   * How old the DATA behind this row is, in ms, or null when no age can be
   * established for it. NOT the age of the render: see `headlineFor` below.
   */
  inputAgeMs: number | null;
}

const VERDICT_LABEL: Record<Verdict, string> = {
  ok: "Checked",
  attention: "Needs attention",
  unmeasured: "Not measured",
};

/**
 * Reinforcement only. `VERDICT_LABEL` is rendered beside every dot, so the colour
 * is decorative under 1.4.11 rather than the signal: measured on the light theme
 * the green is 1.96:1 and the yellow 1.45:1 against the card, which would fail if
 * a reader had to tell the three states apart by colour.
 */
const VERDICT_DOT: Record<Verdict, string> = {
  ok: "bg-pennie-green",
  attention: "bg-pennie-yellow",
  unmeasured: "bg-[var(--pennie-mercury)]",
};

/**
 * The page's own freshness claim, DERIVED from the oldest contributing input.
 *
 * The inputs do not share a freshness. The roster, the calendar rows and the lane
 * heartbeats are all read at request time, so they really are seconds old. The
 * calendar-sync verdict is not: it reads `consecutive_failures` and
 * `last_success_at`, columns the sync and watch lanes write, so it is only as
 * fresh as those lanes' last successful tick. A headline taken from the render
 * clock would claim the whole page was verified seconds ago while one row of it
 * could be an hour stale, which is the page telling a reassuring lie about the one
 * thing it exists to report.
 *
 * So: the oldest MEASURED input sets the age, a row whose age cannot be
 * established stops the page claiming one at all, and a row that was not measured
 * or is not healthy is counted in the sentence rather than averaged away.
 */
function headlineFor(rows: StatusRow[]): string {
  const attention = rows.filter((r) => r.verdict === "attention").length;
  const unmeasured = rows.filter((r) => r.verdict === "unmeasured").length;
  const measured = rows.filter((r) => r.verdict !== "unmeasured");
  const oldestMs =
    measured.length === 0 || measured.some((r) => r.inputAgeMs === null)
      ? null
      : measured.reduce((worst, r) => Math.max(worst, r.inputAgeMs ?? 0), 0);

  if (attention === 0 && unmeasured === 0) {
    return oldestMs === null
      ? "Everything checked out. One of these readings has no age to report."
      : `Everything checked out ${agoPhrase(oldestMs)}.`;
  }

  const parts: string[] = [];
  if (attention > 0) parts.push(`${attention} need${attention === 1 ? "s" : ""} attention`);
  if (unmeasured > 0) parts.push(`${unmeasured} could not be made`);
  const when =
    oldestMs === null
      ? " One of the readings that was made has no age to report."
      : ` Oldest reading ${agoPhrase(oldestMs)}.`;
  return `Of the ${rows.length} checks on this page, ${parts.join(" and ")}.${when}`;
}

/**
 * How fresh the calendar STREAK columns are, which is not how fresh the read of
 * them was. `consecutive_failures` / `last_success_at` are written by the sync and
 * watch lanes, so a lane that last ticked an hour ago means an hour-old reading
 * however recently the row was fetched. Null when that cannot be bounded: a
 * heartbeat read that failed, or a lane with no stamp at all.
 */
const STREAK_WRITER_LANES = ["sync", "watch"] as const;

function streakColumnsAgeMs(rows: LaneHealthRow[], unavailable: boolean): number | null {
  if (unavailable) return null;
  let oldest = 0;
  for (const lane of STREAK_WRITER_LANES) {
    const row = rows.find((r) => r.lane === lane);
    if (!row || row.ageMs === null) return null;
    oldest = Math.max(oldest, row.ageMs);
  }
  return oldest;
}

// Load + classify cron-lane heartbeats against "now". At module scope so the
// Date.now() call doesn't trip react-hooks/purity in render (#288).
function loadLaneHealthNow(read: () => Promise<Record<string, number | null>>) {
  return loadLaneHealth(read, Date.now());
}

// User ids with at least one live (non-expired) calendar watch. At module scope
// for the same reason.
function liveWatchedUserIds(
  rows: { user_id: string; watch_expiration: string | null }[],
): Set<string> {
  const now = Date.now();
  const set = new Set<string>();
  for (const r of rows) {
    if (r.watch_expiration && Date.parse(r.watch_expiration) > now) {
      set.add(r.user_id);
    }
  }
  return set;
}

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return (
    // mark-ok: an OVAL, so its shared component is Pill rather than MarkedLabel
    // (#2112 found this one, #2197 settles it). An oval moves its LABEL down, which
    // puts the word's optical centre where the mark already is, so the pair is
    // centred on each other AND in the oval; moving the mark instead would leave
    // both riding high in it (#2081). Becoming a Pill is a decision about this
    // badge's treatment, not a mechanical conversion: Pill is 13px semibold on
    // every variant but role-agent, and Checked is the commonest verdict on this
    // card, where the quietest treatment for the commonest value is what makes the
    // exceptions visible (L609).
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-xs text-fg-muted">
      <span className={`inline-block size-2 shrink-0 rounded-full ${VERDICT_DOT[verdict]}`} />
      {VERDICT_LABEL[verdict]}
    </span>
  );
}

export default async function AdminHealthPage() {
  const me = await currentUser();
  if (!me) redirect("/login");
  if (consoleHiddenFor(me.role)) redirect("/admin/ooo");
  if (!canManageAgents(me.role)) return <AdminDenied need="a manager or admin" />;
  // The Overview is an admin's page (Dan, 2026-10-02). A manager or team lead who
  // lands here from an old link or a back link goes to the roster, the first
  // entry of their sidebar, rather than to a refusal.
  if (!canEditOrgSettings(me.role)) redirect("/admin/agents");

  const db = supabaseAdmin();
  const [usersRes, calsRes, outboxRes, reservationRes] = await Promise.all([
    // Real advisors only (#396, #4201): no smoke-test agent or placeholder in any count here.
    realAdvisorsOnly(db.from("users").select("*").eq("org_id", me.org_id)),
    db
      .from("agent_calendars")
      .select(
        // One literal, deliberately: supabase-js infers the row type from this
        // string, and a concatenation collapses it to GenericStringError[].
        "user_id, watch_expiration, consecutive_failures, last_success_at, last_sync_error, watch_consecutive_failures, watch_last_success_at, watch_last_error",
      ),
    // #1960: the two drains, moved here from their own route. Both are filtered
    // to rows that have ALREADY crossed the alert threshold, so they are empty
    // on any ordinary day. They run in the SAME wave as the reads above rather
    // than after them, so folding a page in costs no extra round trip on the
    // landing page (#1847 is about that request path).
    db
      // cap-safe: only rows past the alert threshold and still pending; a bounded
      // page (200 wedged rows is itself an emergency, not normal volume).
      .from("booking_outbox")
      .select("*")
      .eq("status", "pending")
      .gte("attempts", DRAIN_ALERT_AFTER)
      .order("attempts", { ascending: false })
      .limit(200),
    db
      // cap-safe: same bound, over the reservation (crash recovered create) drain.
      .from("booking_reservations")
      .select("*")
      .eq("status", "pending")
      .gte("attempts", DRAIN_ALERT_AFTER)
      .order("attempts", { ascending: false })
      .limit(200),
  ]);

  // A read error here must not look like "nothing is stuck", which is a false
  // all clear on the one panel somebody opens after being paged.
  const stuckReadError =
    outboxRes.error?.message ?? reservationRes.error?.message ?? null;
  const stuckRows: StuckRow[] = [
    ...((outboxRes.data ?? []) as BookingOutbox[]).map(normalizeOutboxRow),
    ...((reservationRes.data ?? []) as BookingReservation[]).map(normalizeReservationRow),
  ].sort((a, b) => b.attempts - a.attempts);
  const stuckSummary = summarizeStuck(stuckRows);
  // #1629: an unreadable read and an empty one draw the same picture, and on this
  // page that picture is the fleet being gone rather than a query having failed.
  // Each read is classified explicitly and every count derived from an unreadable
  // one renders as unknown rather than as a zero it never measured.
  const users = (usersRes.data ?? []) as User[];
  const rosterUnreadable = usersRes.error != null;
  const calendarsUnreadable = calsRes.error != null;

  // Push health: how many bookable agents have at least one live Google watch
  // channel across their calendars. A shortfall means external calendar edits
  // for those agents only reach the cache via the cron backstop, not push.
  // `null` when either input could not be read: "0 of 97 on push" off a failed
  // calendar read is a fleet-wide push outage that is not happening, and "97 of
  // 97" off a failed roster read is a reassurance nothing measured.
  const watchedUserIds = liveWatchedUserIds(
    (calsRes.data ?? []) as { user_id: string; watch_expiration: string | null }[],
  );
  const bookableAgents = users.filter((u) => u.bookable && isActive(u));
  // #1810: the fleet line's two halves have to count ONE population. The
  // numerator was already filtered by isActive and the denominator was every non
  // test row, so it mixed people who work here with people who used to and
  // advertised a total the roster page can never reach (L16). Measured on live
  // data 2026-09-03: 136 rows, 117 still on the roster, so 19 departed employees
  // were being counted as fleet. A departed employee is not a staffing gap.
  const rosterAgents = users.filter(isActive);
  const watchedCount =
    calendarsUnreadable || rosterUnreadable
      ? null
      : bookableAgents.filter((u) => watchedUserIds.has(u.id)).length;

  // Per-lane cron health (#288): reuse the dead-man's-switch heartbeats so a
  // silently-wedged lane is visible in-app. readAllHeartbeatMs THROWS on a read
  // error by design (an empty map would read as "all lanes dead"); catch it and
  // say the read failed rather than reporting a misleading all-fine.
  const { rows: laneHealth, unavailable: laneHealthUnavailable } =
    await loadLaneHealthNow(readAllHeartbeatMs);
  const lanes = summariseLanes(laneHealth, laneHealthUnavailable);

  // Per-agent sync health (#273 Phase 1.3): which agents have a calendar in a
  // failure streak, deduped to one entry per agent (worst calendar kept) so the
  // operator can act without hand-querying the DB. Same logic as the named alert.
  const calDiag = (calsRes.data ?? []) as {
    user_id: string;
    consecutive_failures: number | null;
    last_success_at: string | null;
    last_sync_error: string | null;
    watch_consecutive_failures: number | null;
    watch_last_success_at: string | null;
    watch_last_error: string | null;
  }[];
  const userById = new Map(users.map((u) => [u.id, u]));
  const nameByEmail = new Map(users.map((u) => [u.email, u.name]));
  // #1150: both lanes, deduped independently. The watch lane keeps its own
  // counter now, so reading only the sync columns (as this did) would show a
  // calendar that syncs fine but cannot renew its push channel as fully healthy.
  // Deduped per lane rather than across both, because an agent can legitimately
  // be failing one and not the other, and collapsing them would hide whichever
  // had the shorter streak.
  const laneRows = (lane: "sync" | "watch") => {
    const failing: FailingCalendarRow[] = calDiag
      .filter((c) => ((lane === "watch" ? c.watch_consecutive_failures : c.consecutive_failures) ?? 0) > 0)
      .map((c) => {
        const u = userById.get(c.user_id);
        return {
          consecutive_failures:
            (lane === "watch" ? c.watch_consecutive_failures : c.consecutive_failures) ?? 0,
          last_success_at: lane === "watch" ? c.watch_last_success_at : c.last_success_at,
          last_sync_error: lane === "watch" ? c.watch_last_error : c.last_sync_error,
          email: u?.email ?? null,
          bookable: u?.bookable ?? false,
          deactivated_at: u?.deactivated_at ?? null,
        };
      });
    return dedupeFailingAgents(failing).map(
      (a): SyncHealthRow => ({
        email: a.email,
        name: nameByEmail.get(a.email) ?? null,
        consecutiveFailures: a.consecutiveFailures,
        lastSuccessAt: a.lastSuccessAt,
        error: a.error,
        lane,
      }),
    );
  };
  const syncHealthRows: SyncHealthRow[] = [...laneRows("sync"), ...laneRows("watch")];

  // #2297: whether the kill switch is on. A hand-set suppression nobody can see is
  // the one that gets forgotten (L523), and a forgotten pause is a booker silently
  // taking nothing while every other row on this page reads healthy. The switch
  // deliberately does NOT lift itself, so this statement is the whole remedy.
  const publicBookingPaused = await readPublicBookingPaused();

  // #2699 pointed a manager at an admin here, because the switch lives on Hours
  // and a manager cannot open it. Since 2026-10-02 only an admin reaches this
  // page (the guard above sends a manager to the roster), and Hours is an admin
  // page, so everybody reading this row can open it.
  const rows: StatusRow[] = [
    {
      key: "public-booking",
      label: "Online booking",
      note:
        "Whether a lead can book a call at all. It is stopped by hand, on the Hours " +
        "screen, and nothing starts it again on its own.",
      verdict:
        publicBookingPaused === null ? "unmeasured" : publicBookingPaused ? "attention" : "ok",
      detail:
        publicBookingPaused === null ? (
          "Could not read the setting. While it cannot be read, the booker refuses rather than guessing, so leads cannot book."
        ) : publicBookingPaused ? (
          <>
            Stopped by hand. Leads cannot book a call.{" "}
            <Link href="/admin/business-hours">Start it again on Hours</Link>
          </>
        ) : (
          "Running. Leads can book a call."
        ),
      inputAgeMs: publicBookingPaused === null ? null : 0,
    },
    {
      key: "fleet",
      label: "Fleet",
      note:
        "Everyone Slate can route a lead to. Bookable means they are in the rotation " +
        "right now; the rest are on the roster but receiving nothing.",
      verdict: rosterUnreadable ? "unmeasured" : "ok",
      // #1629: this is the first number read on the page. An unreadable roster
      // used to report a confident "0 bookable of 0 agents", which is the fleet
      // being gone rather than a query having failed.
      detail: rosterUnreadable ? (
        "The roster could not be read, so there is no count to show here yet."
      ) : (
        <span className="tabular-nums">
          {`${bookableAgents.length} bookable of ${rosterAgents.length} agents`}
        </span>
      ),
      inputAgeMs: rosterUnreadable ? null : 0,
    },
    {
      key: "push",
      label: "Calendar push",
      note:
        "Google telling Slate the moment a calendar changes, instead of Slate asking. " +
        "On push means that subscription is live for an agent. Anyone not on it is " +
        "still covered by the every minute sync, just a little later.",
      verdict:
        watchedCount === null
          ? "unmeasured"
          : bookableAgents.length === 0 || watchedCount === bookableAgents.length
            ? "ok"
            : "attention",
      // The figure appears HERE and nowhere else (#1767 defect 1). It counts
      // bookable agents holding a live Google push watch channel; it does not
      // measure whether anything is syncing, which is the failure streak below.
      detail:
        watchedCount === null ? (
          "Push health unavailable: it could not be read, so it is not being reported. It has not been measured as bad."
        ) : bookableAgents.length === 0 ? (
          "No agent is bookable, so there is no push channel to hold."
        ) : (
          <span className="tabular-nums">
            {`${watchedCount} of ${bookableAgents.length} bookable agents on push`}
            {watchedCount === bookableAgents.length
              ? ""
              : ". The rest rely on the backup cron sync instead."}
          </span>
        ),
      inputAgeMs: watchedCount === null ? null : 0,
    },
    {
      key: "sync",
      label: "Calendar sync",
      note:
        "Whether Slate can actually read each agent's calendar. A failure streak is " +
        "how many times in a row one agent's calendar read has failed, which is what " +
        "separates a passing Google wobble from an account that needs fixing.",
      verdict:
        calendarsUnreadable || rosterUnreadable
          ? "unmeasured"
          : syncHealthRows.length > 0
            ? "attention"
            : "ok",
      // On a bad day this row expands in place: the existing panel and notices do
      // that work and keep their current wording, which is careful about the
      // difference between measured healthy, measured bad, and could not measure.
      // ONE word changed, and only because the layout made it untrue: the notice
      // said "no agent is listed BELOW as failing" when it sat above the panel,
      // and it is now the row's own body with nothing below it. Keeping a word
      // that points at empty space would preserve the sentence and lose the fact.
      //
      // An empty sync-health panel is a real all-clear ("no agent is in a failure
      // streak"), so it may only be drawn from a calendar read that actually
      // happened.
      // #1646: and from a ROSTER read that actually happened. The rows are a JOIN
      // of the two (`agent_calendars` for the streak, `users` for whose calendar
      // it is), and `dedupeFailingAgents` drops every row with no email, so an
      // unreadable roster empties the panel just as completely as an unreadable
      // calendar read does, with the difference that nothing said so: the roster
      // notice explains the agent count, not this (L530). Distinct causes get
      // distinct sentences (L11), because "the calendar read failed" and "we
      // cannot say whose calendar it is" point at different things to go and look
      // at.
      detail:
        calendarsUnreadable || rosterUnreadable ? (
          <UnreadableNotice>
            {calendarsUnreadable
              ? "Calendar sync health could not be read, so no agent is listed here as failing."
              : "The roster could not be read, so a failing calendar cannot be matched to the agent it belongs to, and no agent is listed here as failing."}{" "}
            That is not the same as none of them failing.
          </UnreadableNotice>
        ) : syncHealthRows.length > 0 ? (
          <SyncHealthPanel agents={syncHealthRows} />
        ) : (
          "No agent is in a failure streak."
        ),
      inputAgeMs:
        calendarsUnreadable || rosterUnreadable
          ? null
          : streakColumnsAgeMs(laneHealth, laneHealthUnavailable),
    },
    {
      key: "stuck",
      label: "Stuck deliveries",
      note:
        `A booking's side effects and its crash recovered creates each retry on their own. ` +
        `A row appears here only once it has failed ${DRAIN_ALERT_AFTER} times, which is the ` +
        `same point an alert fires, so this is empty on an ordinary day.`,
      // Unreadable is NOT ok: on this panel a silent empty is a false all clear.
      verdict: stuckReadError ? "unmeasured" : stuckRows.length > 0 ? "attention" : "ok",
      detail: (
        <StuckDeliveriesPanel
          rows={stuckRows}
          gaveUp={stuckSummary.gaveUp}
          readError={stuckReadError}
        />
      ),
      inputAgeMs: stuckReadError ? null : 0,
    },
    {
      key: "lanes",
      label: "Cron lanes",
      note: cronLanesNote(),
      verdict: lanes.verdict,
      detail: <CronLaneHealth rows={laneHealth} unavailable={laneHealthUnavailable} />,
      inputAgeMs: laneHealthUnavailable ? null : 0,
    },
  ];

  return (
    <>
      {/* The header owns its own spacing and prose treatment, like every other
          console page, so the headline is handed over as words rather than as a
          paragraph carrying a second copy of both. */}
      <AdminPageHeader title="Health">{headlineFor(rows)}</AdminPageHeader>
      {/* One card holding one row per thing this page verifies. The spacing is
          the page's (the console layout's `space-y-8` between top-level children,
          the list's own divider between rows) rather than an `mb-4` per element. */}
      <section className={cardCls}>
        <h2 className="sr-only">What this page checked</h2>
        <dl className="divide-y divide-border">
          {rows.map((row) => (
            <div
              key={row.key}
              className="grid gap-x-4 gap-y-2 py-4 first:pt-0 last:pb-0 sm:grid-cols-[9rem_1fr_auto] sm:items-start"
            >
              <dt className="text-sm font-semibold text-fg">{row.label}</dt>
              <dd className="min-w-0 text-sm text-fg-muted">
                {row.detail}
                {/* #1872: always visible, never a tooltip. A `title` appears on
                    neither keyboard focus nor touch and vanishes when the pointer
                    moves, so it meets none of WCAG 1.4.13's three requirements,
                    and a conforming tooltip would add an interactive target per
                    row to a page whose whole purpose is explaining state.

                    In the WIDE column, under the measurement, rather than under
                    the label: the label column is 9rem, so a paragraph there is
                    set six lines deep in a gutter, which is the same premature
                    wrapping #1888 was about. The measurement leads and the
                    explanation follows it. */}
                <p className={`mt-1.5 text-xs ${proseCls}`}>{row.note}</p>
              </dd>
              <dd className="sm:justify-self-end">
                <VerdictBadge verdict={row.verdict} />
              </dd>
            </div>
          ))}
        </dl>
        {/* #1872: the three badge words, explained once for the whole card rather
            than three times or not at all. "Not measured" is the one that matters:
            it is not a pass, and it never means the thing is fine. */}
        <p className={`mt-6 border-t border-border pt-4 text-xs text-fg-muted ${proseCls}`}>
          Checked means Slate measured it and it looks right. Needs attention means it
          measured it and something is off. Not measured means the reading itself failed,
          which is not the same as a clean result.
        </p>
      </section>
    </>
  );
}

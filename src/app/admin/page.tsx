import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { canManageAgents } from "@/lib/auth/roles";
import { oooOnlyFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isActive } from "@/lib/active-user";
import { loadLaneHealth } from "@/lib/monitor/lane-health-view";
import { readAllHeartbeatMs } from "@/lib/monitor/heartbeat";
import { dedupeFailingAgents, type FailingCalendarRow } from "@/lib/notify/alerts";
import { CronLaneHealth } from "@/components/CronLaneHealth";
import { SyncHealthPanel, type SyncHealthRow } from "@/components/ui/SyncHealthPanel";
import { UnreadableNotice } from "@/components/ui/UnreadableNotice";
import { AdminPageHeader, AdminDenied } from "@/components/admin/AdminPageHeader";
import { cardCls } from "@/components/ui/styles";
import type { User } from "@/lib/db/types";

export const dynamic = "force-dynamic";

/**
 * The console's Overview (#1748).
 *
 * `/admin` used to be all fifteen sections at once. It is now the one thing that
 * is worth seeing first and cannot wait: how much of the fleet is bookable, which
 * cron lanes are alive, and which agents' calendars are in a failure streak.
 * Everything else is its own route behind the sidebar.
 */

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

export default async function AdminHealthPage() {
  const me = await currentUser();
  if (!me) redirect("/login");
  if (!canManageAgents(me.role)) return <AdminDenied need="a manager or admin" />;
  if (oooOnlyFor(me.role)) redirect("/admin/ooo");

  const db = supabaseAdmin();
  const [usersRes, calsRes] = await Promise.all([
    // Exclude the synthetic smoke-test agent (#396) from every count here.
    db.from("users").select("*").eq("org_id", me.org_id).eq("is_test", false),
    db
      .from("agent_calendars")
      .select(
        // One literal, deliberately: supabase-js infers the row type from this
        // string, and a concatenation collapses it to GenericStringError[].
        "user_id, watch_expiration, consecutive_failures, last_success_at, last_sync_error, watch_consecutive_failures, watch_last_success_at, watch_last_error",
      ),
  ]);
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
  // `null` when either input could not be read: "0 of 97 watched" off a failed
  // calendar read is a fleet-wide push outage that is not happening, and "97 of
  // 97" off a failed roster read is a reassurance nothing measured.
  const watchedUserIds = liveWatchedUserIds(
    (calsRes.data ?? []) as { user_id: string; watch_expiration: string | null }[],
  );
  const bookableAgents = users.filter((u) => u.bookable && isActive(u));
  const watchedCount =
    calendarsUnreadable || rosterUnreadable
      ? null
      : bookableAgents.filter((u) => watchedUserIds.has(u.id)).length;
  const pushHealthy =
    watchedCount !== null && bookableAgents.length > 0 && watchedCount === bookableAgents.length;

  // Per-lane cron health strip (#288): reuse the dead-man's-switch heartbeats so a
  // silently-wedged lane is visible in-app. readAllHeartbeatMs THROWS on a read
  // error by design (an empty map would read as "all lanes dead"); catch it and
  // show an explicit "unavailable" strip rather than a misleading all-fine one.
  const { rows: laneHealth, unavailable: laneHealthUnavailable } =
    await loadLaneHealthNow(readAllHeartbeatMs);

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

  return (
    <>
      <AdminPageHeader title="Slate admin">
        {/* #1629: the hero states the roster in numbers, and this is the first
            thing read on the page. An unreadable roster or calendar read used to
            report a confident "0 bookable of 0 agents", which is the fleet being
            gone rather than a query having failed. */}
        {rosterUnreadable ? (
          <p className="mt-2 text-pennie-beige/75">
            The roster could not be read, so there is no count to show here yet.
          </p>
        ) : (
          <p className="mt-2 text-pennie-beige/75">
            <span className="font-semibold tabular-nums text-pennie-beige">
              {bookableAgents.length}
            </span>{" "}
            bookable of{" "}
            <span className="tabular-nums">{users.length}</span> agents ·{" "}
            {watchedCount === null ? (
              <span>an unknown number of</span>
            ) : (
              <span className="tabular-nums">
                {watchedCount}/{bookableAgents.length}
              </span>
            )}{" "}
            calendars syncing
          </p>
        )}
      </AdminPageHeader>
      {/* #1629: the push pill is a health verdict, so it never renders off a read
          that failed. "push 0/97 watched" beside a grey dot is a fleet wide push
          outage, and it was what a failed calendar read drew. */}
      <section className={cardCls}>
        <h2 className="mb-2 text-sm font-semibold">Calendar push</h2>
        {watchedCount === null ? (
          <span
            className="inline-flex items-center gap-1.5 text-xs text-fg-muted"
            title="Push health could not be read, so it is not being reported. It has not been measured as bad."
          >
            <span className="inline-block h-2 w-2 rounded-full bg-[var(--pennie-mercury)]" />
            push health unavailable
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1.5 text-xs text-fg-muted tabular-nums"
            title="Bookable agents with a live Google Calendar push watch channel. A shortfall means those agents rely on the backup cron sync instead of push."
          >
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                pushHealthy
                  ? "bg-pennie-green"
                  : watchedCount > 0
                    ? "bg-pennie-yellow"
                    : "bg-[var(--pennie-mercury)]"
              }`}
            />
            push {watchedCount}/{bookableAgents.length} watched
          </span>
        )}
      </section>
      {/* Per-lane cron liveness (#288), beside the push-health pill above. */}
      <div className="mb-4">
        <CronLaneHealth rows={laneHealth} unavailable={laneHealthUnavailable} />
      </div>
      {/* An empty sync-health panel is a real all-clear ("no calendar is in a
          failure streak"), so it may only be drawn from a calendar read that
          actually happened.
          #1646: and from a ROSTER read that actually happened. The rows are a
          JOIN of the two (`agent_calendars` for the streak, `users` for whose
          calendar it is), and `dedupeFailingAgents` drops every row with no
          email, so an unreadable roster empties the panel just as completely as
          an unreadable calendar read does, with the difference that nothing
          said so: the roster notice above explains the agent list, not this
          (L530). Distinct causes get distinct sentences (L11), because "the
          calendar read failed" and "we cannot say whose calendar it is" point
          at different things to go and look at. */}
      {calendarsUnreadable || rosterUnreadable ? (
        <UnreadableNotice className="mb-4">
          {calendarsUnreadable
            ? "Calendar sync health could not be read, so no agent is listed below as failing."
            : "The roster could not be read, so a failing calendar cannot be matched to the agent it belongs to, and no agent is listed below as failing."}{" "}
          That is not the same as none of them failing.
        </UnreadableNotice>
      ) : (
        syncHealthRows.length > 0 && (
          <div className="mb-4">
            <SyncHealthPanel agents={syncHealthRows} />
          </div>
        )
      )}
    </>
  );
}

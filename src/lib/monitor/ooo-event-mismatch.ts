import { recordConsecutiveStreak, clearFailureStreak } from "@/lib/notify/streak";
import { sendThrottledAlert, resolveAlert, firingFamilyMembers } from "@/lib/notify/dispatch";
import { logAlertSendFailure, logResolveFailure } from "@/lib/notify/send-failure";
import { eventWindow, isBusyEvent } from "@/lib/google/sync-core";
import type { GoogleEvent } from "@/lib/google/calendar";
import { judgeEventCoverage } from "@/lib/ooo/event-coverage";
import {
  oooEventMismatchAlert,
  oooEventMismatchRecovery,
  type OooEventMismatch,
} from "@/lib/ooo/alert-copy";
import { log } from "@/lib/log";

/**
 * An agent's Google Calendar disagrees with their approved time off (#3360).
 *
 * Since #3360 the approved window is held by a Slate written block the calendar sync
 * never rewrites, so an edit in Google can no longer open approved hours to
 * bookings. It can still leave the record and the calendar disagreeing, and only a
 * person can say which is true, so the disagreement is REPORTED, never repaired.
 *
 * Two halves, one judge (`judgeEventCoverage`), one key per agent:
 *
 *  - `noticeSyncedOooEvents` runs inside the calendar sync, so the page goes out at
 *    the moment the sync sees an edited event, which is what #3360 decided. It pages
 *    only a SHORTENED event. A deleted or cancelled one is left to the monitor lane,
 *    because Slate's own cancel and change delete the event BEFORE they flip the
 *    request's status, so the sync can see that deletion against a request still
 *    reading approved.
 *  - `runOooEventMismatchCheck` runs on the monitor lane every 5 minutes over every
 *    approved future request, judged against the event's own mirror row in the busy
 *    cache. It pages what the sync could not see (a deleted event, a disagreement
 *    already standing when this shipped) once it has held for two ticks, and it is
 *    the ONLY place the all-clear is decided, off a measured read.
 *
 * Keyed per agent (`ooo_event_mismatch:<user id>`), a suffix the roster bounds,
 * rather than per request, which would grow `alert_state` without limit; and not one
 * fleet wide key, whose cooldown would let one agent's page silence another's (L707).
 */

export const OOO_EVENT_MISMATCH_FAMILY = "ooo_event_mismatch";

export function oooEventMismatchKey(agentId: string): string {
  return `${OOO_EVENT_MISMATCH_FAMILY}:${agentId}`;
}

/**
 * How often a standing disagreement is repeated. It asks a person to reconcile two
 * records while the approved window stays blocked, so it is not urgent by the hour;
 * four hours keeps it in view through a working day without becoming wallpaper.
 */
export const OOO_EVENT_MISMATCH_COOLDOWN_MS = 4 * 60 * 60_000;

/**
 * Consecutive monitor ticks before the lane pages. Two, for the one transient that
 * produces this state honestly: Slate's own cancel or change deletes the agent's
 * event first and flips the request's status a moment later, and a tick landing in
 * between sees an approved request whose event is gone.
 */
export const OOO_EVENT_MISMATCH_ALERT_AFTER_TICKS = 2;

/** Longer than two 5 minute ticks with slack, so consecutive ticks share a window. */
export const OOO_EVENT_MISMATCH_WINDOW_SECONDS = 30 * 60;

/** One approved, not yet finished request, as the monitor reads it. */
export interface ApprovedEventRequest {
  id: string;
  userId: string;
  agentName: string | null;
  agentEmail: string | null;
  startsAt: string;
  endsAt: string;
  displayTzId: string;
  displayTzLabel: string | null;
  /** The event Slate created on the agent's own calendar. */
  agentEventId: string | null;
  /**
   * Bookable and not deactivated. An agent out of the pool has no synced calendar
   * (the pool exit prunes their mirror rows), so a missing mirror there measures
   * nothing, and nobody can be booked with them anyway.
   */
  inPool: boolean;
}

/** One cached mirror of a calendar event (a source='gcal' busy block). */
export interface EventMirror {
  userId: string;
  gcalEventId: string;
  startsAt: string;
  endsAt: string;
}

const nameOf = (r: Pick<ApprovedEventRequest, "agentName" | "agentEmail" | "userId">) =>
  r.agentName?.trim() || r.agentEmail || r.userId;

function finding(
  r: ApprovedEventRequest,
  coverage: OooEventMismatch["coverage"],
): OooEventMismatch {
  return {
    requestId: r.id,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    displayTzId: r.displayTzId,
    displayTzLabel: r.displayTzLabel,
    coverage,
  };
}

/**
 * Which agents' approved windows the calendar no longer covers, judged against the
 * event's own mirror rows. Pure. A request with no event is skipped (the fallback
 * page owns it), as is an agent out of the pool; a missing mirror for an in pool
 * agent is the calendar blocking nothing, never agreement.
 */
export function eventMismatchesByAgent(
  requests: ApprovedEventRequest[],
  mirrors: EventMirror[],
  nowMs: number,
): Map<string, { agentName: string; found: OooEventMismatch[] }> {
  return judgeEventsByAgent(requests, mirrors, nowMs).found;
}

/**
 * The same judgement, also naming the agents with a window that could not be READ.
 * An unreadable stamp is "could not tell", never agreement (L11), so the all-clear
 * must hold those agents back rather than read their absence from `found` as health.
 */
function judgeEventsByAgent(
  requests: ApprovedEventRequest[],
  mirrors: EventMirror[],
  nowMs: number,
): { found: Map<string, { agentName: string; found: OooEventMismatch[] }>; unmeasured: Set<string> } {
  const unmeasured = new Set<string>();
  const byEvent = new Map<string, EventMirror[]>();
  for (const m of mirrors) {
    const k = `${m.userId}\u0000${m.gcalEventId}`;
    const list = byEvent.get(k) ?? [];
    list.push(m);
    byEvent.set(k, list);
  }
  const out = new Map<string, { agentName: string; found: OooEventMismatch[] }>();
  for (const r of requests) {
    if (!r.agentEventId || !r.inPool) continue;
    const cover = byEvent.get(`${r.userId}\u0000${r.agentEventId}`) ?? null;
    const verdict = judgeEventCoverage({ startsAt: r.startsAt, endsAt: r.endsAt, nowMs, cover });
    if (verdict.kind === "unreadable") unmeasured.add(r.userId);
    if (verdict.kind !== "uncovered" && verdict.kind !== "not-blocking") continue;
    const entry = out.get(r.userId) ?? { agentName: nameOf(r), found: [] };
    entry.found.push(finding(r, verdict));
    out.set(r.userId, entry);
  }
  return { found: out, unmeasured };
}

export interface OooEventMismatchResult {
  status: "clear" | "mismatched" | "unreadable";
  scanned: number;
  mismatchedAgents: number;
  /** Agents whose earlier page was ended this tick. */
  cleared: number;
  /** The read succeeded, so this tick answered the question (#1394). */
  reachedVerdict: boolean;
}

/**
 * One monitor tick. A failed read pages nothing and clears nothing: an unread list
 * comes back empty, and an empty list here would read as "everything agrees"
 * (#1134, #1152). A failed read of the firing markers still lets the pages go out;
 * it only defers the all-clears to the next tick.
 */
export async function runOooEventMismatchCheck(deps: {
  load: () => Promise<{ requests: ApprovedEventRequest[]; mirrors: EventMirror[] }>;
  /** Names for paged agents who no longer appear in the approved set. */
  loadAgentNames: (ids: string[]) => Promise<Map<string, string>>;
  nowMs: number;
  appBaseUrl: string;
  log?: (fields: Record<string, unknown>) => void;
}): Promise<OooEventMismatchResult> {
  let requests: ApprovedEventRequest[];
  let mirrors: EventMirror[];
  try {
    ({ requests, mirrors } = await deps.load());
  } catch (err) {
    log.error("ooo-event-mismatch", { msg: "approved time off read failed" }, err);
    deps.log?.({ status: "unreadable" });
    return { status: "unreadable", scanned: 0, mismatchedAgents: 0, cleared: 0, reachedVerdict: false };
  }

  const { found, unmeasured } = judgeEventsByAgent(requests, mirrors, deps.nowMs);

  for (const [agentId, { agentName, found: list }] of found) {
    const key = oooEventMismatchKey(agentId);
    const sustained = await recordConsecutiveStreak(
      key,
      OOO_EVENT_MISMATCH_WINDOW_SECONDS,
      OOO_EVENT_MISMATCH_ALERT_AFTER_TICKS,
    );
    if (!sustained) continue;
    // alert-key: ooo_event_mismatch:*
    await sendThrottledAlert(
      key,
      OOO_EVENT_MISMATCH_COOLDOWN_MS,
      oooEventMismatchAlert(agentName, list, deps.appBaseUrl),
    ).catch(logAlertSendFailure(key));
  }

  // The all-clear, only for agents with an outstanding page and only off this
  // tick's measured read: nothing approved ahead for them disagrees any more.
  let cleared = 0;
  let firing: string[] = [];
  try {
    firing = await firingFamilyMembers(OOO_EVENT_MISMATCH_FAMILY);
  } catch (err) {
    log.warn("ooo-event-mismatch", { msg: "firing markers unreadable; all-clears deferred" }, err);
  }
  // An agent with any window this tick could not read measured nothing, so it is
  // neither disagreeing nor recovered: its page stands until a later tick reads it.
  const recovered = firing.filter((id) => !found.has(id) && !unmeasured.has(id));
  if (recovered.length > 0) {
    const known = new Map(requests.map((r) => [r.userId, nameOf(r)]));
    const missing = recovered.filter((id) => !known.has(id));
    const looked = missing.length > 0
      ? await deps.loadAgentNames(missing).catch((err) => {
          log.warn("ooo-event-mismatch", { msg: "agent names unreadable" }, err);
          return new Map<string, string>();
        })
      : new Map<string, string>();
    for (const id of recovered) {
      const key = oooEventMismatchKey(id);
      const name = known.get(id) ?? looked.get(id) ?? "An agent";
      // alert-key: ooo_event_mismatch:*
      const sent = await resolveAlert(key, oooEventMismatchRecovery(name)).catch(
        logResolveFailure(key),
      );
      if (sent) {
        cleared++;
        await clearFailureStreak(key);
      }
    }
  }

  const status = found.size > 0 ? "mismatched" : "clear";
  deps.log?.({ status, scanned: requests.length, mismatched_agents: found.size, cleared });
  return { status, scanned: requests.length, mismatchedAgents: found.size, cleared, reachedVerdict: true };
}

/** One approved request the sync may hold an event for. */
export type SyncedApprovedRequest = Omit<ApprovedEventRequest, "inPool" | "agentName" | "agentEmail">;

/**
 * The page at the moment the sync sees an edited time off event (#3360). Reads
 * nothing for an empty batch, and asks for the agent's name only when there is
 * something to say. Pages a SHORTENED event only (see the module header for why a
 * deleted one waits for the monitor lane), and never clears: the all-clear needs
 * every approved request of the agent judged, which only the monitor lane does.
 * Returns how many requests it paged about. Throws on a failed read; the sync's
 * wrapper contains it so a detector can never fail the sync it rides on.
 */
export async function noticeSyncedOooEvents(deps: {
  userId: string;
  events: GoogleEvent[];
  timeZone: string;
  nowMs: number;
  appBaseUrl: string;
  loadApproved: (userId: string) => Promise<SyncedApprovedRequest[]>;
  loadAgentName: (userId: string) => Promise<string>;
}): Promise<number> {
  if (deps.events.length === 0) return 0;
  const approved = await deps.loadApproved(deps.userId);
  if (approved.length === 0) return 0;
  const byEvent = new Map<string, GoogleEvent>();
  for (const ev of deps.events) if (ev.id) byEvent.set(ev.id, ev);
  const found: OooEventMismatch[] = [];
  for (const r of approved) {
    const ev = r.agentEventId ? byEvent.get(r.agentEventId) : undefined;
    if (!ev || !isBusyEvent(ev)) continue;
    const win = eventWindow(ev, deps.timeZone);
    if (!win) continue;
    const verdict = judgeEventCoverage({
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      nowMs: deps.nowMs,
      cover: [{ startsAt: win.start, endsAt: win.end }],
    });
    if (verdict.kind === "uncovered") {
      found.push({
        requestId: r.id,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        displayTzId: r.displayTzId,
        displayTzLabel: r.displayTzLabel,
        coverage: verdict,
      });
    }
  }
  if (found.length === 0) return 0;
  const key = oooEventMismatchKey(deps.userId);
  const name = await deps.loadAgentName(deps.userId);
  // alert-key: ooo_event_mismatch:*
  await sendThrottledAlert(
    key,
    OOO_EVENT_MISMATCH_COOLDOWN_MS,
    oooEventMismatchAlert(name, found, deps.appBaseUrl),
  ).catch(logAlertSendFailure(key));
  return found.length;
}

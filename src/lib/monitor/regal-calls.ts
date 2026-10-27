/**
 * Somebody placing calls in Regal while Slate will not route bookings to them
 * (#2090).
 *
 * That state means the routing pool is silently a person short: the roster thinks
 * somebody is working, Slate is not offering them, and the only symptom is thinner
 * availability that reads as an ordinary quiet day. #2085 is the prevention (Slate
 * tells Regal who is bookable); this is the detection, and it is independent of it
 * in the way that matters (L345): it reads Regal's own call events rather than the
 * trait Slate sent, so it does not fall silent exactly when #2085 fails.
 *
 * WHO IS FLAGGED: a caller in the recent window who is a Slate user, is not
 * routable (`isRoutable`, the one shipped definition, the same one #2085 uses), and
 * carries none of five exemptions, each reported under its own name:
 *
 *   routable      Slate routes to them, which is healthy.
 *   role          any role but `agent`, derived from the Role union below.
 *   test          a test user.
 *   ignored       on the admin managed ignore list, with a reason.
 *   redistribute  Twilio carries the `Redistribute` tag and their bookable switch
 *                 is off (#2724). Those agents take calls in Regal and must not get
 *                 booked calls (Dan, 2026-09-08 and 2026-09-25), so a call from one
 *                 is the expected state. Read from `redistribute_tagged`, which the
 *                 roster sync mirrors for EVERY tagged worker, never from Slate's own
 *                 `redistribute` mark, which misses anybody already out of the pool
 *                 when the tag appeared. It does NOT cover a deactivated agent: the
 *                 tag explains a switch being off, not somebody having left, and the
 *                 sync stops writing a deactivated row, so its value is frozen.
 *                 Nor does it cover an agent the last roster sync found NO Twilio
 *                 worker for (#2735): the sync keeps their stored tag rather than
 *                 clearing it on what may be a partial read (L214), so the tag is
 *                 what Twilio said LAST, and a worker that has gone for good would
 *                 otherwise stay exempt for ever. The sync records the absence as
 *                 `twilio_worker_missing_since` and the exemption is refused on it,
 *                 with a page worded for that case rather than the untagged one.
 *
 * plus `not-in-slate` for an address that resolved at the edge and has no user now.
 *
 * FIRST EVENT, NOT A STREAK, and the opposite of what #1215 chose, for a reason
 * worth keeping: agents cannot change their own bookable status. Every
 * `bookable = false` is somebody's decision (an admin, the Bearer keyed roster
 * API, or the Salesforce sync, which only ever flips somebody ON), so a call from
 * that person is anomalous from the first one. One page per agent per cooldown
 * (24 hours by default, tunable on /admin/alerts), and the `alert_state` row is the
 * record of who was paged and when.
 *
 * A CONDITION, so it ends, and two of its endings must never share wording (L11):
 * becoming routable is a recovery; being added to the ignore list is a
 * SUPPRESSION, which still closes the page so it does not hang, and says that
 * nothing was fixed.
 *
 * Pure apart from the injected reads and the dispatcher, so the node suite drives
 * every branch (scripts/test-regal-call-detector.ts).
 */
import { logAlertSendFailure, logResolveFailure } from "../notify/send-failure.ts";
import { DateTime } from "luxon";
import { normalizeEmail } from "@/lib/auth/email";
import { formatClockTime } from "@/lib/date/parse";
import { BUSINESS_ZONE } from "@/lib/booking/business-hours";
import { isRoutable } from "@/lib/routing/staffing-depth";
import {
  carriesRedistributeTag,
  twilioWorkerMissing,
  twilioWorkerMissingSinceMs,
} from "@/lib/twilio/roster-plan";
import type { Attributes, Role } from "@/lib/db/types";
import type { AlertResolve, ThrottledNotify } from "./alert-deps";

/** The alert_state family: `regal_call_unroutable:<user id>`. */
export const REGAL_CALL_ALERT_PREFIX = "regal_call_unroutable";

export const regalCallAlertKey = (userId: string): string => `${REGAL_CALL_ALERT_PREFIX}:${userId}`;

/**
 * How far back each tick reads, on ARRIVAL. The lane runs every five minutes, so
 * this is six ticks: a late tick, or a couple of failed ones, still sees every call
 * that arrived since the last one that read. Rereading the same call is free, since
 * the per agent cooldown is what decides whether a page goes out.
 *
 * It is deliberately short rather than a day. The window is "calls placed while
 * the person is NOT routable", and nothing records when somebody's bookable flag
 * changed, so a long window would page about a call made before an admin switched
 * the person off.
 */
export const REGAL_CALL_WINDOW_MS = 30 * 60_000;

/**
 * Which roles are exempt, as a table over the Role union rather than the
 * `role !== "agent"` it amounts to today. The difference only shows the day a
 * sixth role is added: the comparison would silently exempt it, and this makes
 * `tsc` refuse the build until somebody decides (L113). `regal-calls.type-test.ts`
 * holds that property.
 *
 * `team_lead` confirmed exempt by Dan on 2026-09-08: they are among the people
 * correctly not bookable in Slate, and leaving them in would page on them daily.
 * The cost, stated: somebody with a non agent role who genuinely should be taking
 * bookings is silently exempt.
 */
export const REGAL_ROLE_EXEMPT: Record<Role, boolean> = {
  super_admin: true,
  admin: true,
  manager: true,
  team_lead: true,
  agent: false,
};

/** The columns this check needs off a `users` row. */
export interface RegalCaller {
  id: string;
  name: string | null;
  email: string;
  role: Role;
  bookable: boolean;
  deactivated_at: string | null;
  is_test: boolean;
  /** The placeholder advisor (#4201): never bookable, so exempt under its own name. */
  is_placeholder: boolean;
  /** Read for `redistribute_tagged` (#2724). */
  attributes: Attributes | null;
}

/**
 * Switched off (not deactivated) and carrying the stored tag. Whether the tag can
 * be TRUSTED is the separate question below; this is only whether it would apply.
 */
function redistributeWouldApply(u: RegalCaller): boolean {
  return !isRoutable(u) && u.deactivated_at === null && carriesRedistributeTag(u.attributes);
}

/**
 * The tag would exempt them, and the last roster sync found no Twilio worker to
 * vouch for it (#2735), so it does not.
 */
function redistributeUnvouched(u: RegalCaller): boolean {
  return redistributeWouldApply(u) && twilioWorkerMissing(u.attributes);
}

/**
 * The redistribute exemption, in ONE place so the judgement and the ending cannot
 * disagree: switched off (not deactivated), tagged at the last roster sync, and
 * that sync found their Twilio worker.
 */
function redistributeExempt(u: RegalCaller): boolean {
  return redistributeWouldApply(u) && !twilioWorkerMissing(u.attributes);
}

/** One candidate row from `regal_call_events`. */
export interface RegalCandidate {
  agent_email: string;
  occurred_at: string | null;
}

/** One entry on the ignore list. */
export interface RegalIgnore {
  user_id: string;
  reason: string;
}

export type RegalExemption =
  | "routable"
  | "role"
  | "test"
  | "placeholder"
  | "ignored"
  | "redistribute"
  | "not-in-slate";

export interface RegalCallerVerdict {
  email: string;
  user: RegalCaller | null;
  calls: number;
  /** The latest call's instant; null when none of its instants could be read. */
  lastCallMs: number | null;
  /** Every exemption that holds. Flagged exactly when this is empty. */
  exemptions: RegalExemption[];
  /** Why Slate will not route to them, or null when it will. */
  axis: "deactivated" | "not-bookable" | null;
  /**
   * They carry the Redistribute tag, which would have exempted them, and the last
   * roster sync found no Twilio worker for them, so it did not (#2735). The page
   * says so rather than reading as if the tag were never there.
   */
  unvouchedRedistribute: boolean;
}

function instantMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = DateTime.fromISO(iso).toMillis();
  return Number.isFinite(ms) ? ms : null;
}

/** Group the window's calls by person and decide each one. */
export function judgeRegalCallers(
  candidates: RegalCandidate[],
  users: RegalCaller[],
  ignores: RegalIgnore[],
): RegalCallerVerdict[] {
  const byEmail = new Map(users.map((u) => [normalizeEmail(u.email), u]));
  const ignored = new Set(ignores.map((i) => i.user_id));
  const grouped = new Map<string, { calls: number; lastCallMs: number | null }>();
  for (const c of candidates) {
    const email = normalizeEmail(c.agent_email);
    const g = grouped.get(email) ?? { calls: 0, lastCallMs: null };
    g.calls += 1;
    const ms = instantMs(c.occurred_at);
    if (ms !== null && (g.lastCallMs === null || ms > g.lastCallMs)) g.lastCallMs = ms;
    grouped.set(email, g);
  }

  const out: RegalCallerVerdict[] = [];
  for (const [email, g] of grouped) {
    const u = byEmail.get(email) ?? null;
    if (!u) {
      out.push({ email, user: null, ...g, exemptions: ["not-in-slate"], axis: null, unvouchedRedistribute: false });
      continue;
    }
    const exemptions: RegalExemption[] = [];
    const routable = isRoutable(u);
    if (routable) exemptions.push("routable");
    if (REGAL_ROLE_EXEMPT[u.role] === true) exemptions.push("role");
    if (u.is_test) exemptions.push("test");
    if (u.is_placeholder) exemptions.push("placeholder");
    if (ignored.has(u.id)) exemptions.push("ignored");
    if (redistributeExempt(u)) exemptions.push("redistribute");
    const axis = routable ? null : u.deactivated_at !== null ? "deactivated" : "not-bookable";
    out.push({ email, user: u, ...g, exemptions, axis, unvouchedRedistribute: redistributeUnvouched(u) });
  }
  return out.sort((a, b) => a.email.localeCompare(b.email));
}

// ---------------------------------------------------------------- endings

export type RegalCallEnding =
  | "routable"
  | "ignored"
  | "exempt-role"
  | "exempt-test"
  | "exempt-placeholder"
  | "exempt-redistribute"
  | "gone";

export interface RegalCallSettlement {
  userId: string;
  ending: RegalCallEnding;
  user: RegalCaller | null;
  ignoreReason: string | null;
  text: string;
}

/**
 * Which open pages have ENDED, and how. A page whose person is still not routable
 * and carries no exemption is left open, whether or not they called this tick:
 * the condition is the state, and the call is only how it was noticed.
 *
 * Routable is checked first, because a person who is both bookable again and on
 * the list has been FIXED, and the recovery is the more useful thing to say.
 */
export function settleRegalCallAlerts(
  firingUserIds: string[],
  users: RegalCaller[],
  ignores: RegalIgnore[],
): RegalCallSettlement[] {
  const byId = new Map(users.map((u) => [u.id, u]));
  const reasonById = new Map(ignores.map((i) => [i.user_id, i.reason]));
  const out: RegalCallSettlement[] = [];
  for (const userId of firingUserIds) {
    const u = byId.get(userId) ?? null;
    let ending: RegalCallEnding | null = null;
    if (!u) ending = "gone";
    else if (isRoutable(u)) ending = "routable";
    else if (reasonById.has(u.id)) ending = "ignored";
    else if (REGAL_ROLE_EXEMPT[u.role] === true) ending = "exempt-role";
    else if (u.is_test) ending = "exempt-test";
    else if (u.is_placeholder) ending = "exempt-placeholder";
    else if (redistributeExempt(u)) ending = "exempt-redistribute";
    if (ending === null) continue;
    const settlement = { userId, ending, user: u, ignoreReason: u ? (reasonById.get(u.id) ?? null) : null };
    out.push({ ...settlement, text: formatRegalCallEnding(settlement) });
  }
  return out;
}

// ------------------------------------------------------------------- copy

function who(u: RegalCaller | null, email: string): string {
  const name = u?.name?.trim();
  return name ? `${name} (${email})` : email;
}

function callTime(ms: number | null): string {
  const time = ms === null ? null : formatClockTime(DateTime.fromMillis(ms, { zone: BUSINESS_ZONE }));
  if (time === null) return "in the last half hour, at a time Regal did not send readably";
  return `at ${time} ET`;
}

/**
 * The page. What it costs, who, which of the two axes, and both remedies, because
 * which one is right is somebody's decision rather than ours to assume.
 */
export function formatRegalCallAlert(v: RegalCallerVerdict): string {
  const person = who(v.user, v.email);
  const calls =
    v.calls === 1
      ? `a call in Regal ${callTime(v.lastCallMs)}`
      : `${v.calls} calls in Regal, the last ${callTime(v.lastCallMs)}`;
  if (v.axis === "not-bookable" && v.unvouchedRedistribute) {
    const sinceMs = twilioWorkerMissingSinceMs(v.user?.attributes);
    const since =
      sinceMs === null
        ? "the roster sync found no Twilio worker for their address"
        : `the roster sync has found no Twilio worker for their address since ` +
          `${DateTime.fromMillis(sinceMs, { zone: BUSINESS_ZONE }).toFormat("MMM d")}`;
    return (
      `${person} placed ${calls}, while their bookable switch is off in Slate. They carry the ` +
      `Redistribute tag, which would explain that, but ${since}, so the tag is what Twilio said ` +
      `last and no longer counts. If they have left, deactivate them under admin > agents and shut ` +
      `off their Regal seat. If their Twilio worker was removed or its email changed, restore it with ` +
      `this address and this stops within the hour. If neither fits, add them to the Regal call ` +
      `ignore list under admin > alerts with the reason.`
    );
  }
  if (v.axis === "deactivated") {
    return (
      `${person} placed ${calls}, and is deactivated in Slate, ` +
      `so no booking is routed to them. If they have left, their Regal seat is still live and should be ` +
      `shut off. If they are back, reactivate them under admin > agents. If neither is right, add them to ` +
      `the Regal call ignore list under admin > alerts with the reason.`
    );
  }
  return (
    `${person} placed ${calls}, while their bookable switch ` +
    `is off in Slate, so the routing pool is a person short while they work. If they should be taking ` +
    `bookings, turn bookable on under admin > agents. If they should take calls but not bookings, tag ` +
    `them Redistribute in Twilio and this stops within the hour. If neither fits, add them to the Regal ` +
    `call ignore list under admin > alerts with the reason.`
  );
}

/** How a page ended. Six distinct sentences, never one "resolved" (L11). */
export function formatRegalCallEnding(s: Omit<RegalCallSettlement, "text">): string {
  const person = s.user ? who(s.user, s.user.email) : "The person this alert named";
  switch (s.ending) {
    case "routable":
      return `${person} is routable again, so Slate is offering bookings to them while they take calls in Regal.`;
    case "ignored":
      return (
        `${person} was added to the Regal call ignore list ("${s.ignoreReason ?? ""}"), so their calls ` +
        `are no longer reported. This is a suppression, not a fix: Slate still routes no bookings to them.`
      );
    case "exempt-role":
      return (
        `${person} now has a role other than agent, so their calls in Regal are no longer reported. ` +
        `Slate still routes no bookings to them, which is expected for that role.`
      );
    case "exempt-test":
      return (
        `${person} is now marked as a test user, so their calls in Regal are no longer reported. ` +
        `Slate still routes no bookings to them.`
      );
    case "exempt-placeholder":
      return (
        `${person} is now the placeholder advisor, which holds stacked calls and is never bookable, ` +
        `so their calls in Regal are no longer reported.`
      );
    case "exempt-redistribute":
      return (
        `${person} carries the Redistribute tag in Twilio, so their calls in Regal are no longer ` +
        `reported. This is a suppression, not a recovery: Slate still routes no bookings to them, which ` +
        `is what the tag asks for.`
      );
    case "gone":
      return `The person this alert named (user ${s.userId}) is no longer in Slate, so there is nobody left to report on.`;
  }
}

// ----------------------------------------------------------------- runner

export type RegalCallResult =
  /** A read failed: nothing measured, nothing paged, nothing cleared. */
  | { status: "unreadable"; error: string }
  /** Measured, and no candidate call arrived in the window. NOT a verdict: a feed
   *  nobody posts to reads exactly like this. */
  | { status: "no-calls"; settled: RegalCallEnding[] }
  /** Measured: at least one real call judged. `paged` is false while disarmed. */
  | {
      status: "checked";
      callers: number;
      flagged: RegalCallerVerdict[];
      exempt: Record<RegalExemption, number>;
      paged: boolean;
      settled: RegalCallEnding[];
    };

export interface RegalCallDeps {
  /** Candidate rows received at or after `sinceIso`. THROWS on a read error. */
  loadCandidates: (sinceIso: string) => Promise<RegalCandidate[]>;
  /** The whole roster (roster bounded). THROWS on a read error. */
  loadUsers: () => Promise<RegalCaller[]>;
  /** The ignore list. THROWS on a read error: an empty list is "nobody ignored". */
  loadIgnores: () => Promise<RegalIgnore[]>;
  /** User ids with an open page in this family. THROWS on a read error. */
  loadFiringUserIds: () => Promise<string[]>;
  /** The `regal_calls_armed` setting (#2695). False: measure and log, send and clear nothing. */
  armed: boolean;
  notify: ThrottledNotify;
  /** REQUIRED, so a caller cannot wire a condition with no way to end it (#1151). */
  resolve: AlertResolve<unknown>;
  cooldownMs: number;
  nowMs: number;
}

/**
 * The monitor lane step. Every read happens before anything is sent or cleared, so
 * a read that fails leaves the tick unmeasured with nothing half done. A notify or
 * resolve that fails is swallowed per agent: a flaky Slack must not skip the next
 * agent or fail the tick, and the cooldown and firing markers make the next tick
 * retry it.
 */
export async function runRegalCallCheck(deps: RegalCallDeps): Promise<RegalCallResult> {
  const sinceIso = new Date(deps.nowMs - REGAL_CALL_WINDOW_MS).toISOString();
  let candidates: RegalCandidate[];
  let users: RegalCaller[];
  let ignores: RegalIgnore[];
  let firing: string[];
  try {
    [candidates, users, ignores, firing] = await Promise.all([
      deps.loadCandidates(sinceIso),
      deps.loadUsers(),
      deps.loadIgnores(),
      deps.loadFiringUserIds(),
    ]);
  } catch (err) {
    return { status: "unreadable", error: err instanceof Error ? err.message : String(err) };
  }

  // Endings first, from the measured state, so a person paged and since made
  // bookable is told about before anything new is sent. Disarmed clears nothing:
  // silence chosen by a switch is not a measurement of health.
  const settlements = settleRegalCallAlerts(firing, users, ignores);
  if (deps.armed) {
    for (const s of settlements) {
      await deps.resolve(regalCallAlertKey(s.userId), s.text).catch(logResolveFailure(regalCallAlertKey(s.userId)));
    }
  }
  const settled = settlements.map((s) => s.ending);

  if (candidates.length === 0) return { status: "no-calls", settled };

  const verdicts = judgeRegalCallers(candidates, users, ignores);
  const flagged = verdicts.filter((v) => v.exemptions.length === 0);
  const exempt: Record<RegalExemption, number> = {
    routable: 0,
    role: 0,
    test: 0,
    placeholder: 0,
    ignored: 0,
    redistribute: 0,
    "not-in-slate": 0,
  };
  for (const v of verdicts) for (const e of v.exemptions) exempt[e] += 1;

  if (deps.armed) {
    for (const v of flagged) {
      if (!v.user) continue;
      await deps.notify(regalCallAlertKey(v.user.id), deps.cooldownMs, formatRegalCallAlert(v)).catch(logAlertSendFailure(regalCallAlertKey(v.user.id)));
    }
  }
  return { status: "checked", callers: verdicts.length, flagged, exempt, paged: deps.armed, settled };
}

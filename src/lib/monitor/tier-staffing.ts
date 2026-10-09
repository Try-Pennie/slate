/**
 * The debt tier staffing alarm (#2505).
 *
 * WHAT IT ASKS, and why it is not the question the old one asked. The empty
 * bucket sweep judged a BUCKET: sixty codes, fifteen pools, each paged about on
 * its own. Dan, 2026-09-17: "I only want to be paged if there are literally no
 * (for example) ultra high agents staffed. or no medium agents, etc." A bucket or
 * a backend with nobody in it is not a customer problem while the rest of its
 * debt tier can take the lead, and since #2486 the ladder tries every bucket in
 * the tier before dropping one, so it does take them.
 *
 * AND IT ASKS IT IN SLOTS, NOT IN ROSTERED HOURS. Dan, same day: "maybe it
 * doesn't matter if nobody is staffed at a specific point because we just don't
 * offer that time slot. Maybe we need to rethink this and only alert if there are
 * no slots in the next 24 hours/business day (like obviously there would be no
 * slots on sunday)." An hours gap is not a fault: if nobody works Saturday, Slate
 * offers no Saturday and the lead books Monday. An alarm on it would be red on
 * the healthy day, which is how a gate stops being read (L36). So the trigger is
 * what a LEAD CAN ACTUALLY GET: does this debt tier offer a bookable time inside
 * the days the booker shows?
 *
 * THOSE DAYS ARE THE BOOKER'S OWN (#3559). The window was the rest of today plus
 * the next open day, which paged Low at 8:11am on Friday 2026-10-09 while it had
 * times on Monday, a day every lead was being shown. Dan, that morning: judge "the
 * next x days, x being the number of days shown the booker at the time of the
 * check". So each tier is judged over `offeredWindowFor`, the function the booker
 * cuts its strip with, from that tier's own pool notice, and a change to the
 * number of offered days moves this alarm with it.
 *
 * PER TIER, IGNORING THE LADDER, and that is load bearing rather than an
 * oversight. After #2486 a lead whose tier is dry falls to a lower one, so "can
 * this lead book" is almost always yes, and a ladder aware question would mute
 * exactly the Ultra High case this exists to report. The ladder question stays
 * where it belongs, on the per bucket finding that is now muted.
 *
 * TWO FINDINGS, NEVER ONE MESSAGE (L11). "No times" has two opposite repairs:
 * nobody is assigned to the tier at all (hire somebody, or tag them in Twilio),
 * against the tier has agents and none of them has an opening (a schedule, a
 * calendar, or capacity). One sentence covering both sends half its readers to do
 * the wrong thing.
 *
 * IT WILL BE SILENT FROM THE DAY IT SHIPS, and that is the main risk rather than
 * a reassurance. Measured 2026-09-17: every debt tier is staffed (Low 75, Medium
 * 66, High 43, Very High 19, Ultra High 5) and every tier offers times. A
 * detector that has never once fired is indistinguishable from a broken one
 * (#1394, L557), which is why the lane stamps `verdict:tier-staffing` only on a
 * MEASURED verdict and why every branch here is driven in both directions by
 * `scripts/test-tier-staffing.ts`.
 *
 * Pure, and no `@/` imports, so the node suite drives it directly. The reads (the
 * roster, the cached slot rows, the org's week) belong to the monitor lane.
 */
import { DateTime } from "luxon";
import { formatSlotDay, formatSlotTime } from "../booking/slot-label.ts";
import type { DayTally, TierCauseReading } from "./tier-cause.ts";
import type { AlertResolve } from "./alert-deps";

/** alert_state row key prefix. ONE constant, so the sender, the catalog and the
 *  preview cannot drift onto different keys. */
export const TIER_STAFFING_ALERT_KEY = "empty_tier";

/**
 * The key one debt tier pages on.
 *
 * A debt tier is a single digit and a bucket code is three, so this key space can
 * never collide with the retired `empty_buckets:<code>` family and can never
 * clear one of its pages by accident.
 */
export function tierStaffingKey(tier: string): string {
  return `${TIER_STAFFING_ALERT_KEY}:${tier}`;
}

/**
 * How many agents the tier has, AND whether that was measured, as one value.
 *
 * A bare `number | null` puts the reading and the fact of having read it in two
 * places and lets a caller treat null as zero, which is the whole defect class
 * this file exists inside (L215, L544). Zero agents pages; an unreadable roster
 * concludes nothing.
 */
export type AgentReading = { measured: false } | { measured: true; count: number };

/**
 * The earliest bookable time the tier is offering, and whether it was measured.
 *
 * `firstSlotMs: null` on a MEASURED read means the tier is offering nothing,
 * which is a finding. `measured: false` means the slot rows could not be read,
 * which is not.
 */
export type SlotReading =
  | { measured: false }
  | {
      measured: true;
      firstSlotMs: number | null;
      /** Every distinct time the tier is offering, in time order (#3227), from the
       *  same served list as `firstSlotMs`. The all clear counts the ones inside
       *  the window. */
      offeredMs: number[];
    };

/**
 * The days the booker shows a lead in this tier, and where they end, or that they
 * could not be worked out (#3559). From `offeredWindowFor` over the tier pool's
 * own minimum notice, so the alarm judges exactly the strip a lead sees.
 */
export type WindowReading = { measured: false } | { measured: true; endMs: number; days: string[] };

export interface TierReading {
  /** The first XBC digit, "1" to "5". */
  tier: string;
  /** The tier in words, from the shared routing vocabulary, never typed out here. */
  label: string;
  agents: AgentReading;
  slots: SlotReading;
  window: WindowReading;
}

export type TierVerdict =
  /** A lead in this tier can get a time inside the window. Nothing to page.
   *  `openTimes` is how many distinct times it offers inside the window, which
   *  decides whether an open page may be cleared (#3227). */
  | { kind: "serving"; openTimes: number }
  /** Nobody is assigned to the tier at all. */
  | { kind: "unstaffed" }
  /** The tier has agents and is offering no time inside the window. */
  | { kind: "no-slots"; agents: number; firstSlotMs: number | null }
  /** A read failed, so this tier is excluded from every conclusion. */
  | { kind: "unmeasured"; why: string };

/**
 * Judge one debt tier against its window.
 *
 * The order is deliberate. A tier OFFERING a time inside the window is `serving`
 * before anything else is asked, including when the roster read says it has
 * nobody. Those two disagreeing is a real fault, but it is not one a lead is
 * suffering from, and paging about it in a sentence that says a tier cannot take
 * a call would be an alarm about our own bookkeeping dressed as a customer
 * outage (L11).
 */
export function judgeTier(r: TierReading): TierVerdict {
  const unread: string[] = [];
  if (!r.agents.measured) unread.push("the roster");
  if (!r.slots.measured) unread.push("the offered times");
  if (!r.window.measured) unread.push("the booker's window");
  // EVERY unread input, not just the first: naming one sends the reader back for
  // a second tick to discover the rest (L679).
  if (unread.length > 0) {
    return { kind: "unmeasured", why: `could not read ${unread.join(" or ")}` };
  }
  // Narrowed by the guard above; restated so the compiler can see it.
  const slots = r.slots as { measured: true; firstSlotMs: number | null; offeredMs: number[] };
  const agents = r.agents as { measured: true; count: number };
  const { endMs: windowEndMs } = r.window as { measured: true; endMs: number; days: string[] };
  if (slots.firstSlotMs !== null && slots.firstSlotMs <= windowEndMs) {
    return { kind: "serving", openTimes: slots.offeredMs.filter((ms) => ms <= windowEndMs).length };
  }
  // `<= 0` rather than `=== 0`: a nonsense negative count is not evidence that
  // somebody is staffed, and it is the reading that would otherwise fall through
  // to the softer of the two findings.
  if (agents.count <= 0) return { kind: "unstaffed" };
  return { kind: "no-slots", agents: agents.count, firstSlotMs: slots.firstSlotMs };
}

/** One tier's page, carrying what it is so the sender picks the right sentence. */
export interface TierPage {
  tier: string;
  label: string;
  kind: "unstaffed" | "no-slots";
  /** Agents on the tier; 0 for an unstaffed one. */
  agents: number;
  /** The tier's first offered time past the window (#3037), or null when it is
   *  offering nothing at all. Always null on an unstaffed page. */
  firstSlotMs: number | null;
  /** The days the tier was judged over, which the copy names (#3559). */
  days: string[];
  /** Where that window ends, which the diagnosis reads to. */
  windowEndMs: number;
}

export interface TierAlertPlan {
  /** Tiers to page, each with which of the two findings it is. */
  page: TierPage[];
  /** Tiers MEASURED healthy, so their page may be cleared. Named `recovered`
   *  rather than `clear` because that is what the list IS: the tiers this tick
   *  will announce a recovery for, and the vocabulary the monitor lane already
   *  uses for the same thing (`stepVerdict.recovered`). */
  recovered: { tier: string; label: string; openTimes: number }[];
  /** Tiers a read failed for, named in the log and excluded from both lists. */
  unmeasured: string[];
  /**
   * Whether this run concluded about ANY tier.
   *
   * The lane stamps its verdict lane off this and nothing else, because a run
   * that measured nothing has not concluded, and a stamp written anyway would
   * keep a blind detector's verdict looking fresh forever, which is the exact
   * state #1394 exists to notice.
   */
  measuredAny: boolean;
}

/**
 * What one tick should send.
 *
 * The clear list is driven by the MEASURED healthy result, never by "we did not
 * page this tier". A tier whose reads failed is in neither list: clearing it
 * would announce a recovery off a run that never looked, which is #1134 and
 * #1152, and paging it would accuse a tier that may be perfectly well.
 */
export function planTierAlerts(readings: TierReading[]): TierAlertPlan {
  const page: TierPage[] = [];
  const recovered: { tier: string; label: string; openTimes: number }[] = [];
  const unmeasured: string[] = [];
  for (const r of readings) {
    const v = judgeTier(r);
    if (v.kind === "unmeasured") {
      unmeasured.push(r.tier);
      continue;
    }
    if (v.kind === "serving") {
      recovered.push({ tier: r.tier, label: r.label, openTimes: v.openTimes });
      continue;
    }
    // Measured by the guard in `judgeTier`, so the window is there.
    const w = r.window as { measured: true; endMs: number; days: string[] };
    const where = { days: w.days, windowEndMs: w.endMs };
    if (v.kind === "unstaffed")
      page.push({ tier: r.tier, label: r.label, kind: "unstaffed", agents: 0, firstSlotMs: null, ...where });
    else page.push({ tier: r.tier, label: r.label, kind: "no-slots", agents: v.agents, firstSlotMs: v.firstSlotMs, ...where });
  }
  return { page, recovered, unmeasured, measuredAny: page.length + recovered.length > 0 };
}

// --------------------------------------------------------- when a page may end

/**
 * When an open page may be cleared (#3227). Both are set on the monitor settings
 * screen beside the `empty_tier` cooldown.
 *
 * Paging still happens only at ZERO offered times, so these change when a page
 * ENDS, never when it starts. On 2026-10-04 Low paged, one cancelled call opened a
 * single Monday time, and the all clear went out. Because an all clear also resets
 * the cooldown (`resolveAlert`, so a genuinely new incident pages at once), the
 * next booking of that one time paged again at once: page, all clear, page, all
 * clear, on a day when nothing was wrong. L160: a condition is over only after a
 * re-arm window of health, never on the first good sample.
 */
export interface TierRecoveryPolicy {
  /** How many distinct times inside the window a tier must offer to count as recovered. */
  minOpenTimes: number;
  /** How long it must stay at that many before the all clear goes out. */
  holdMs: number;
}

/**
 * The `alert_state` row that holds WHEN a paged tier first measured at the
 * recovered count. Its own prefix, so it can never be read as the page's cooldown
 * (`empty_tier:<digit>`) or its firing marker (`alert_firing:empty_tier:<digit>`).
 */
export function tierHoldKey(tier: string): string {
  return `${TIER_STAFFING_ALERT_KEY}_healthy_since:${tier}`;
}

/**
 * What the lane knows about each tier's open page and its hold, or that it could
 * not read it. Unreadable concludes nothing for any tier: it starts no hold,
 * resets none, and clears nothing (#1134, #1152).
 */
export type TierAlertState =
  | { readable: false }
  | {
      readable: true;
      /** Tiers with a delivered page still open. */
      firing: Set<string>;
      /** Tier to the moment its hold began. A tier with no entry is not holding. */
      holdSinceMs: Map<string, number>;
    };

export interface TierRecoveryPlan {
  /** Tiers whose all clear goes out now. Their hold is cleared once it is delivered. */
  allClear: { tier: string; label: string }[];
  /** Tiers whose hold begins now. */
  startHold: string[];
  /** Tiers whose hold is dropped now: below the count, back at zero, or no page open. */
  clearHold: string[];
  /** Tiers holding, for the log: how many times they offer and how long they have held. */
  holding: { tier: string; openTimes: number; heldMs: number }[];
  /** Tiers with a page open and fewer than the recovered count, for the log. */
  short: { tier: string; openTimes: number }[];
}

/**
 * What one tick does about ENDING each tier's page.
 *
 * A tier whose reads failed is in no list of the plan, so nothing here touches it,
 * which is the whole rule: an unmeasured tick neither advances a hold, nor resets
 * it, nor clears a page. The hold is a moment rather than a count of ticks, so a
 * blind tick in the middle neither adds to it nor takes from it; what the all
 * clear requires is that THIS tick measured the count and the moment is old enough.
 */
export function planTierRecovery(
  plan: TierAlertPlan,
  state: TierAlertState,
  policy: TierRecoveryPolicy,
  nowMs: number,
): TierRecoveryPlan {
  const out: TierRecoveryPlan = { allClear: [], startHold: [], clearHold: [], holding: [], short: [] };
  if (!state.readable) return out;
  // Back at zero: the page is open (or about to be), so any hold is over.
  for (const p of plan.page) if (state.holdSinceMs.has(p.tier)) out.clearHold.push(p.tier);
  for (const r of plan.recovered) {
    const since = state.holdSinceMs.get(r.tier);
    if (!state.firing.has(r.tier)) {
      // No page open: nothing to clear, and a hold left behind is stale.
      if (since !== undefined) out.clearHold.push(r.tier);
      continue;
    }
    if (r.openTimes < policy.minOpenTimes) {
      out.short.push({ tier: r.tier, openTimes: r.openTimes });
      if (since !== undefined) out.clearHold.push(r.tier);
      continue;
    }
    const start = since ?? nowMs;
    if (since === undefined) out.startHold.push(r.tier);
    const heldMs = nowMs - start;
    if (heldMs >= policy.holdMs) out.allClear.push({ tier: r.tier, label: r.label });
    else out.holding.push({ tier: r.tier, openTimes: r.openTimes, heldMs });
  }
  return out;
}

/** What `settleTierRecovery` reaches outside itself, so every failure is driven in the node suite. */
export interface TierRecoveryDeps {
  /** One read of every tier's open page and hold. Throws on a refused read. */
  loadState: () => Promise<TierAlertState>;
  startHolds: (tiers: string[], nowMs: number) => Promise<void>;
  clearHolds: (tiers: string[]) => Promise<void>;
  /** Sends the all clear for one key; true only when the notice went out. */
  resolve: AlertResolve;
  warn: (msg: string, err?: unknown) => void;
}

/**
 * The lane's half of ending a page (#3227): read the state once, start and drop
 * holds, send each all clear, and drop a tier's hold only once its notice was
 * delivered, so a notice that failed is retried on the next tick.
 *
 * A run that measured no tier spends no read on the state, and a state that could
 * not be read concludes nothing for any tier (#1134, #1152).
 */
export async function settleTierRecovery(
  plan: TierAlertPlan,
  policy: TierRecoveryPolicy,
  nowMs: number,
  deps: TierRecoveryDeps,
): Promise<{ recovery: TierRecoveryPlan; cleared: string[] }> {
  const state: TierAlertState =
    plan.recovered.length + plan.page.length === 0
      ? { readable: false }
      : await deps.loadState().catch((err) => {
          deps.warn("tier alert state unreadable; recovery deferred", err);
          return { readable: false } as const;
        });
  const recovery = planTierRecovery(plan, state, policy, nowMs);
  await deps.startHolds(recovery.startHold, nowMs);
  await deps.clearHolds(recovery.clearHold);
  const cleared: string[] = [];
  for (const t of recovery.allClear) {
    const sent = await deps.resolve(tierStaffingKey(t.tier), tierRecoveredMessage(t)).catch((err) => {
      deps.warn(`recovery notice failed for ${tierStaffingKey(t.tier)}`, err);
      return false;
    });
    if (sent) cleared.push(t.tier);
  }
  await deps.clearHolds(cleared);
  return { recovery, cleared };
}

// ------------------------------------------------------------------ the copy

/**
 * Nobody is assigned to the tier.
 *
 * The urgency is set by what the reader must DO and how soon (L112): every lead
 * in this tier is being served by a LOWER tier right now, which is a real
 * degradation nobody outside Slate can see, and the repair is a person being
 * given the tier rather than anything in the product.
 */
export function tierUnstaffedMessage(t: { tier: string; label: string }): string {
  // No indefinite article in front of the tier name: the labels begin with both
  // vowels and consonants ("Ultra High", "Very High", "Low"), so a fixed "a"
  // renders "a Ultra High call". The preview is what caught it, which is the
  // whole reason this copy is read before it ships rather than asserted by
  // substring.
  return (
    `No agent is assigned to the ${t.label} debt tier, so nobody can take a call ` +
    `at that tier. Every lead asking for it is being served by a lower tier ` +
    `instead, which still books them but with an agent the routing did not intend. ` +
    `Give somebody the ${t.label} tier in Twilio, or check whether the last one ` +
    `left the pool.`
  );
}

/** The zone a page renders a time in, named in the text as ET, as the other
 *  monitor pages do. */
const ALERT_ZONE = "America/New_York";

/** "Mon, Oct 5 at 11:30am ET", the house spelling the other pages use. */
function etWhen(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${formatSlotDay(iso, ALERT_ZONE)} at ${formatSlotTime(iso, ALERT_ZONE)} ET`;
}

/** "Fri, Sat or Mon": the days a tier was judged over, as a lead's strip names
 *  them. The dates are the org's own, so the weekday needs no zone. */
function dayList(days: string[]): string {
  const names = days.map((iso) => DateTime.fromISO(iso).toFormat("ccc"));
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/** What each state of an agent's day is called, after "are" or after a comma. */
const STATE_WORDS = {
  slate: "booked with Slate calls",
  outside: "held by other meetings and time off",
  off: "not working those days",
  open: "showing openings the offered times do not have yet",
} as const;
type DayState = keyof typeof STATE_WORDS;

/**
 * The cause over the WHOLE window, in a few words (Dan, 2026-10-09: one total,
 * not a sentence per day). Counted in agent days: every state holding at least a
 * quarter of them is named, largest first, so the word that leads is what most
 * of the window was lost to. "mostly" only when the named states leave some out,
 * and "all" when one state is the whole of it. Null when no agent day was judged.
 */
function causeSummary(days: DayTally[], agents: number): string | null {
  const totals: Record<DayState, number> = { slate: 0, outside: 0, off: 0, open: 0 };
  for (const d of days) for (const k of Object.keys(totals) as DayState[]) totals[k] += d[k];
  const sum = Object.values(totals).reduce((a, b) => a + b, 0);
  if (sum === 0) return null;
  const ranked = (Object.keys(totals) as DayState[])
    .filter((k) => totals[k] > 0)
    .sort((a, b) => totals[b] - totals[a]);
  const named = ranked.filter((k, i) => i === 0 || totals[k] * 4 >= sum);
  const phrases = named.map((k) => STATE_WORDS[k]);
  const words =
    phrases.length <= 2 ? phrases.join(" or ") : `${phrases.slice(0, -1).join(", ")} or ${phrases[phrases.length - 1]}`;
  if (named.length === ranked.length) {
    if (named.length > 1 || agents === 1) return words;
    // "all not working" reads as a typo; nobody working is said as that.
    return named[0] === "off" ? "none working those days" : `all ${words}`;
  }
  return `mostly ${words}`;
}

/**
 * The tier has agents and none of them is offering a time.
 *
 * A different repair from an unstaffed tier entirely, so a different sentence
 * (L11). Since #3037 it names the cause that ACTUALLY applies over the window,
 * worked out by `diagnoseTierCause` from reads the lane makes only on a tick
 * about to page. Since #3559 it is short: the days a lead can see, the next
 * offered time, and the cause in one clause over the whole window. A stopped
 * calendar sync LEADS (Dan, 2026-10-09: "it's buried right now"), because it is
 * the one cause with its own repair and it makes the rest of the page unreliable.
 *
 * When those reads failed, the cause is UNMEASURED and the page keeps the three
 * possibilities, plus one clause saying which applies could not be read. Never
 * silence, and never a guessed cause (L215, L11). `cause` is required so `tsc`
 * names every site that builds this page.
 */
export function tierNoSlotsMessage(
  t: { tier: string; label: string; agents: number; firstSlotMs: number | null; days: string[] },
  cause: TierCauseReading,
): string {
  // Every clause agrees with the count, including the ones several words away. A
  // shared sentence with "their calendars" in it reads as a plural claim about
  // one person, which is the "1 of 97 bookable agent" defect wearing a different
  // hat (L11, and the 2026-07-28 page this rule comes from).
  const one = t.agents === 1;
  const who = one ? "1 agent" : `${t.agents} agents`;
  const none =
    t.firstSlotMs === null
      ? `The ${t.label} debt tier has no booking times on ${dayList(t.days)}, and none later either.`
      : `The ${t.label} debt tier has no booking times on ${dayList(t.days)}. The next is ${etWhen(t.firstSlotMs)}.`;
  const tail = `Leads asking for ${t.label} go to a lower tier until it clears.`;
  if (!cause.measured) {
    const whose = one ? "their calendar is full, their" : "their calendars are full, their";
    return (
      `${none} It has ${who}, so this is not a staffing gap: ${whose} working hours ` +
      `do not reach those days, or their calendar sync has stopped. Which of those ` +
      `applies could not be read on this tick. ${tail}`
    );
  }
  const c = cause.cause;
  const sentences: string[] = [];
  if (c.syncStopped > 0) {
    let whom: string;
    if (c.syncStopped < c.total) whom = `${c.syncStopped} of the ${c.total} ${t.label} agents`;
    else whom = c.total === 1 ? `the only ${t.label} agent` : `all ${c.total} ${t.label} agents`;
    sentences.push(`Calendar sync has stopped for ${whom}, so their busy times are out of date. Fix that first.`);
  }
  sentences.push(none);
  const rest = c.total - c.syncStopped;
  const summary = rest > 0 ? causeSummary(c.days, rest) : null;
  if (summary === null) sentences.push(`It has ${who}.`);
  else if (c.syncStopped > 0)
    sentences.push(`It has ${who}; ${rest === 1 ? "the other one is" : `the other ${rest} are`} ${summary}.`);
  else sentences.push(`It has ${who}, ${summary}.`);
  if (c.days.some((d) => d.open > 0)) {
    sentences.push("Some calendars show openings, so the offered times are behind and the next recompute should bring them back.");
  }
  sentences.push(tail);
  return sentences.join(" ");
}

/**
 * The all clear (L151: a condition owes the reader an end).
 *
 * It carries NO remediation, because the page it clears already said what to do
 * and repeating it would send somebody to investigate a fault that is over. It
 * also does not claim anybody was hired: the two ways this ends (somebody was
 * given the tier, or the existing agents freed up) are both just "a lead can book
 * again", which is the fact the reader actually needs.
 */
export function tierRecoveredMessage(t: { tier: string; label: string }): string {
  return (
    `The ${t.label} debt tier is offering booking times again, so leads asking ` +
    `for it are being served by ${t.label} agents rather than falling to a lower ` +
    `tier. The earlier page about it is cleared. No action is needed.`
  );
}

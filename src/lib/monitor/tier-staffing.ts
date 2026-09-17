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
 * the next open business day?
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
export type SlotReading = { measured: false } | { measured: true; firstSlotMs: number | null };

export interface TierReading {
  /** The first XBC digit, "1" to "5". */
  tier: string;
  /** The tier in words, from the shared routing vocabulary, never typed out here. */
  label: string;
  agents: AgentReading;
  slots: SlotReading;
}

export type TierVerdict =
  /** A lead in this tier can get a time inside the window. Nothing to say. */
  | { kind: "serving" }
  /** Nobody is assigned to the tier at all. */
  | { kind: "unstaffed" }
  /** The tier has agents and is offering no time inside the window. */
  | { kind: "no-slots"; agents: number }
  /** A read failed, so this tier is excluded from every conclusion. */
  | { kind: "unmeasured"; why: string };

/**
 * Judge one debt tier against the window.
 *
 * The order is deliberate. A tier OFFERING a time inside the window is `serving`
 * before anything else is asked, including when the roster read says it has
 * nobody. Those two disagreeing is a real fault, but it is not one a lead is
 * suffering from, and paging about it in a sentence that says a tier cannot take
 * a call would be an alarm about our own bookkeeping dressed as a customer
 * outage (L11).
 */
export function judgeTier(r: TierReading, windowEndMs: number): TierVerdict {
  const unread: string[] = [];
  if (!r.agents.measured) unread.push("the roster");
  if (!r.slots.measured) unread.push("the offered times");
  // EVERY unread input, not just the first: naming one sends the reader back for
  // a second tick to discover the rest (L679).
  if (unread.length > 0) {
    return { kind: "unmeasured", why: `could not read ${unread.join(" or ")}` };
  }
  // Narrowed by the guard above; restated so the compiler can see it.
  const slots = r.slots as { measured: true; firstSlotMs: number | null };
  const agents = r.agents as { measured: true; count: number };
  if (slots.firstSlotMs !== null && slots.firstSlotMs <= windowEndMs) return { kind: "serving" };
  // `<= 0` rather than `=== 0`: a nonsense negative count is not evidence that
  // somebody is staffed, and it is the reading that would otherwise fall through
  // to the softer of the two findings.
  if (agents.count <= 0) return { kind: "unstaffed" };
  return { kind: "no-slots", agents: agents.count };
}

/** One tier's page, carrying what it is so the sender picks the right sentence. */
export interface TierPage {
  tier: string;
  label: string;
  kind: "unstaffed" | "no-slots";
  /** Agents on the tier; 0 for an unstaffed one. */
  agents: number;
}

export interface TierAlertPlan {
  /** Tiers to page, each with which of the two findings it is. */
  page: TierPage[];
  /** Tiers MEASURED healthy, so their page may be cleared. Named `recovered`
   *  rather than `clear` because that is what the list IS: the tiers this tick
   *  will announce a recovery for, and the vocabulary the monitor lane already
   *  uses for the same thing (`stepVerdict.recovered`). */
  recovered: { tier: string; label: string }[];
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
export function planTierAlerts(readings: TierReading[], windowEndMs: number): TierAlertPlan {
  const page: TierPage[] = [];
  const recovered: { tier: string; label: string }[] = [];
  const unmeasured: string[] = [];
  for (const r of readings) {
    const v = judgeTier(r, windowEndMs);
    if (v.kind === "unmeasured") unmeasured.push(r.tier);
    else if (v.kind === "serving") recovered.push({ tier: r.tier, label: r.label });
    else if (v.kind === "unstaffed") page.push({ tier: r.tier, label: r.label, kind: "unstaffed", agents: 0 });
    else page.push({ tier: r.tier, label: r.label, kind: "no-slots", agents: v.agents });
  }
  return { page, recovered, unmeasured, measuredAny: page.length + recovered.length > 0 };
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

/**
 * The tier has agents and none of them is offering a time.
 *
 * A different repair entirely, so a different sentence (L11). It names the count,
 * because one agent with a full calendar and nineteen with full calendars are not
 * the same problem.
 */
export function tierNoSlotsMessage(t: { tier: string; label: string; agents: number }): string {
  // Every clause agrees with the count, including the ones several words away. A
  // shared sentence with "their calendars" in it reads as a plural claim about
  // one person, which is the "1 of 97 bookable agent" defect wearing a different
  // hat (L11, and the 2026-07-28 page this rule comes from).
  const one = t.agents === 1;
  const who = one ? "1 agent" : `${t.agents} agents`;
  const whose = one ? "their calendar is full, their" : "their calendars are full, their";
  return (
    `The ${t.label} debt tier is offering no booking times before the end of the ` +
    `next working day. It has ${who}, so this is not a staffing gap: ${whose} ` +
    `working hours do not reach the window, or their calendar sync has stopped. ` +
    `Leads asking for ${t.label} are being served by a lower tier until it clears.`
  );
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

/**
 * What a burst driver reads from the deployment for the judge (#3429), and how the
 * judge reads it back. Pure: no network, no clock.
 *
 * TWO readings, both taken by the driver because they are facts about the deployment
 * that answered the burst, and recorded in the burst's own files so they are paired
 * with it by being in it (L420):
 *
 * **The confirm crowd rule** (`/api/smoke/version`, `confirmCrowdRule`). A crowd behind
 * a one deep rung with a staffed rung below it ends one way on a build that stops at
 * the rung (#3338) and another on a build that walks the ladder (#3437), so the judge
 * holds each burst to the rule the deployment SAYS it runs rather than guessing which
 * build it measured.
 *
 * **The slot's bookable probe** (`/api/bookings/bookable`), sent once the burst has
 * settled. `checkBookable` runs the same per slot routing a real book runs, read only,
 * and it is a reading the crowd's SLOT_TAKEN answers never consulted: a follower is
 * told the slot is taken by its leader's verdict through the confirm line, never by a
 * routing pass of its own (L721). So a SLOT_TAKEN the slot still answers available
 * for is the line refusing a lead the routing would have booked, which is #3338.
 *
 * Every way of learning nothing is its own non answer, never a value (L98): a probe
 * not recorded, refused, unreadable, or sent before the burst settled, and a rule the
 * deployment did not state.
 */
import { CONFIRM_CROWD_RULES, type ConfirmCrowdRule } from "../../src/lib/confirm-crowd-rule.ts";

/** What one driver read of the deployment's confirm crowd rule. */
export type CrowdRuleReading =
  | { state: "read"; value: ConfirmCrowdRule }
  /** The deployment answered and did not say, which a build before #3429 does. */
  | { state: "absent"; why: string }
  | { state: "unreadable"; why: string };

/** The rule from one `/api/smoke/version` answer. */
export function readCrowdRule(status: number, body: unknown): CrowdRuleReading {
  if (status !== 200) return { state: "unreadable", why: `/api/smoke/version answered ${status}` };
  if (typeof body !== "object" || body === null) {
    return { state: "unreadable", why: "/api/smoke/version answered with something that is not an object" };
  }
  const raw = (body as { confirmCrowdRule?: unknown }).confirmCrowdRule;
  if (raw === undefined) {
    return {
      state: "absent",
      why: "the deployment's version answer carries no confirmCrowdRule, so it predates #3429 or is not a load test build",
    };
  }
  if (typeof raw === "string" && (CONFIRM_CROWD_RULES as readonly string[]).includes(raw)) {
    return { state: "read", value: raw as ConfirmCrowdRule };
  }
  return { state: "unreadable", why: `the deployment declared a crowd rule this does not know: ${JSON.stringify(raw)}` };
}

/** The rule one burst was answered under, from every driver's reading of it. */
export type CrowdRuleVerdict = { state: "read"; value: ConfirmCrowdRule } | { state: "unknown"; why: string };

/**
 * One rule for one burst. A driver that could not read it does not stop the others'
 * reading counting, and two DIFFERENT values from one deployment conclude nothing:
 * which one answered the burst cannot be known (L11).
 */
export function burstCrowdRule(readings: readonly (CrowdRuleReading | undefined)[]): CrowdRuleVerdict {
  const byValue = new Map<ConfirmCrowdRule, number>();
  const reasons = new Set<string>();
  for (const r of readings) {
    if (r === undefined) reasons.add("not recorded in the burst's file");
    else if (r.state === "read") byValue.set(r.value, (byValue.get(r.value) ?? 0) + 1);
    else reasons.add(r.why);
  }
  if (byValue.size > 1) {
    const told = [...byValue.entries()].map(([v, n]) => `${v} by ${n}`).join(", ");
    return { state: "unknown", why: `the burst's drivers were told different crowd rules (${told})` };
  }
  const only = [...byValue.keys()][0];
  if (only !== undefined) return { state: "read", value: only };
  return {
    state: "unknown",
    why:
      readings.length === 0
        ? "no burst file recorded the deployment's crowd rule"
        : `no driver read the deployment's crowd rule (${[...reasons].join("; ")})`,
  };
}

/** One probe of the burst's slot, as one driver recorded it. */
export type BurstProbe =
  | {
      kind: "read";
      code: string;
      /** When the driver sent it, epoch ms on the driver's clock. */
      sentAtMs: number;
      bookable: boolean;
      /** The route's own reason: available, slot_taken, closed, no_eligible_agents. */
      reason: string;
      /** How many rungs below the requested one would take it; 0 when not bookable. */
      rungsDropped: number;
      effectiveCode: string | null;
    }
  | { kind: "unreadable"; code: string; sentAtMs: number; why: string };

/**
 * One `/api/bookings/bookable` answer. A 503 is a verify outage and never a confident
 * no (the route says so), and a field missing or of the wrong type is unreadable,
 * never defaulted: a missing rung count read as 0 would turn an available slot one
 * rung down into one available on the requested rung, which accuses a different
 * defect.
 */
export function readBurstProbe(input: { code: string; sentAtMs: number; status: number; body: unknown }): BurstProbe {
  const { code, sentAtMs } = input;
  const unreadable = (why: string): BurstProbe => ({ kind: "unreadable", code, sentAtMs, why });
  const b = typeof input.body === "object" && input.body !== null ? (input.body as Record<string, unknown>) : null;
  if (input.status !== 200) {
    const said = typeof b?.code === "string" ? ` ${b.code}` : "";
    return unreadable(`the bookable check answered ${input.status}${said}`);
  }
  if (b === null) return unreadable("the bookable check answered 200 with no readable body");
  if (typeof b.bookable !== "boolean") return unreadable(`its bookable was ${JSON.stringify(b.bookable)}, not true or false`);
  if (typeof b.reason !== "string" || b.reason === "") return unreadable(`its reason was ${JSON.stringify(b.reason)}, not a word`);
  const rung = b.rungsDropped;
  if (typeof rung !== "number" || !Number.isInteger(rung) || rung < 0) {
    return unreadable(`its rungsDropped was ${JSON.stringify(rung)}, not a count`);
  }
  const effective = b.effectiveBucketCode;
  return {
    kind: "read",
    code,
    sentAtMs,
    bookable: b.bookable,
    reason: b.reason,
    rungsDropped: rung,
    effectiveCode: typeof effective === "string" ? effective : null,
  };
}

/** The burst's probes judged together. */
export type ProbeVerdict =
  | {
      kind: "read";
      bookable: boolean;
      reason: string;
      /** The highest rung still free across the readings that said available. */
      rungsDropped: number;
      effectiveCode: string | null;
      /** Probes that were read and sent after the burst settled. */
      readings: number;
      /** Why each other probe could not be used, so a thin reading is visible as thin. */
      unusable: string[];
    }
  | { kind: "unconcluded"; why: string };

/**
 * The slot's state after the burst, from every driver's probe of it.
 *
 * Only a probe READ and sent once the burst SETTLED counts: one sent while confirms
 * were still walking the ladder could see a free advisor the next confirm was about to
 * take, and accuse an honest refusal. Probes that disagree about whether the slot is
 * bookable, or about WHY it is not, conclude nothing rather than one of them being picked. When every usable
 * probe says available, the highest rung still free is kept, because "the requested
 * rung itself still had somebody" is the stronger accusation and the one #3338 does
 * not explain.
 */
export function burstProbeVerdict(probes: readonly (BurstProbe | undefined)[], settleAtMs: number): ProbeVerdict {
  const unusable: string[] = [];
  const usable: Extract<BurstProbe, { kind: "read" }>[] = [];
  for (const p of probes) {
    if (p === undefined) unusable.push("not recorded in the burst's file");
    else if (p.kind === "unreadable") unusable.push(`${p.code}: ${p.why}`);
    else if (p.sentAtMs < settleAtMs) {
      unusable.push(`${p.code}: sent ${settleAtMs - p.sentAtMs}ms before the burst settled`);
    } else usable.push(p);
  }
  if (usable.length === 0) {
    return {
      kind: "unconcluded",
      why:
        probes.length === 0
          ? "no burst file recorded a probe of the slot"
          : `no probe of the slot could be used once the burst settled (${unusable.join("; ")})`,
    };
  }
  const available = usable.filter((p) => p.bookable);
  if (available.length > 0 && available.length < usable.length) {
    return {
      kind: "unconcluded",
      why:
        `the probes disagree: ${available.length} answered available and ${usable.length - available.length} ` +
        `answered ${[...new Set(usable.filter((p) => !p.bookable).map((p) => p.reason))].join(", ")}`,
    };
  }
  // #3459 review (L11): all not bookable, but for different reasons. Only one reason
  // proves a refusal honest, so picking one would decide the question by arrival order.
  const notBookableReasons = [...new Set(usable.filter((p) => !p.bookable).map((p) => p.reason))].sort();
  if (available.length === 0 && notBookableReasons.length > 1) {
    return {
      kind: "unconcluded",
      why: `the probes disagree on why the slot is not bookable: ${notBookableReasons.join(", ")}`,
    };
  }
  const top = (available.length > 0 ? available : usable).slice().sort((a, b) => a.rungsDropped - b.rungsDropped)[0]!;
  return {
    kind: "read",
    bookable: top.bookable,
    reason: top.reason,
    rungsDropped: top.rungsDropped,
    effectiveCode: top.effectiveCode,
    readings: usable.length,
    unusable,
  };
}

/**
 * The verdict on one booking path load run (#2244). Pure: no network, no clock,
 * no database. `scripts/test-judge-booking-run.ts` drives every bar with a fixture
 * per failure and a passing one.
 *
 * THE FIRST THING IT DOES IS REFUSE TO JUDGE AN INCOMPLETE RUN, and that is the
 * decision the whole file rests on. A judge handed three driver files out of four,
 * or a sampler that stopped after two minutes, can compute every rate below and
 * every one of them will look plausible: the p95 of a short run is lower, the
 * confirmed-per-minute of a missing driver is a quarter down, and nothing in the
 * numbers says which. A run that half happened must be reported as a run that half
 * happened, never as a run with a verdict (L288).
 */
import type { BookingAttempt, DriverResult } from "./book-plan.ts";
import type { SoakSample } from "./invariants.ts";

/** A booking row the run created, as the judge needs it. */
export interface JudgedBooking {
  id: string;
  external_id: string | null;
  idempotency_key: string | null;
  assigned_user_id: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
}

/** What the platform's own analytics reported over the run's window. */
export interface PlatformReading {
  /**
   * Invocations the analytics API counted. It is the CONTROL: the run knows how
   * many requests it made, so a count far below that says the pipeline had not
   * caught up rather than that the Worker was idle, and the CPU and subrequest
   * numbers beside it are about a window that is not the one being judged.
   */
  invocations: number | null;
  cpuMsP99: number | null;
  /**
   * The `$workers.outcome` histogram over the window.
   *
   * SUBREQUESTS ARE NOT HERE, and their absence is deliberate rather than an
   * omission. Cloudflare's observability exposes NO subrequest counter
   * (docs/cloudflare-platform-notes.md), so a "subrequests in one invocation" bar
   * could never be measured and would leave this judge permanently unable to
   * conclude: a check that can only ever report `unmeasured` is the shape #2240's
   * first cal.com probe shipped in. What IS measurable is the breach, which
   * arrives here as an outcome other than `ok`, so that is what is judged.
   *
   * The same reading covers a CPU kill (`exceededCpu`), which is the other way the
   * platform stops an invocation mid flight and the reason the lanes that had not
   * finished simply did not run.
   */
  outcomes: Record<string, number> | null;
}

export interface JudgeInput {
  runId: string;
  target: { drivers: number; perDriverPerMinute: number; minutes: number };
  /** One per steady driver. Fewer than `target.drivers` is incomplete. */
  driverResults: DriverResult[];
  /** One per burst driver, or empty when the run had no burst leg. */
  burstResults: DriverResult[];
  /** One a minute for the whole window. */
  freshnessSamples: SoakSample[];
  /** Every booking the run created, read through a PAGINATING list. */
  bookings: JudgedBooking[];
  /** Booking ids that have at least one `busy_blocks` row. */
  bookingIdsWithBusyBlock: string[];
  /** Whether `bookings_active_slot_uniq` was seen to REFUSE a planted duplicate. */
  slotUniqueIndexPresent: boolean;
  /**
   * Whether `bookings_active_no_overlap` was seen to REFUSE a planted OVERLAP
   * (#2274).
   *
   * A separate flag because it is a separate guarantee, and the run's headline bar
   * rests on both. Uniqueness catches a second booking at the same START;
   * appointments are longer than the grid they are offered on (20 minutes every 10
   * in production), so adjacent offered times overlap and the second booking has a
   * DIFFERENT start, which uniqueness cannot see. A branch carrying one and not the
   * other produces a clean looking run that proves nothing about the half it lost.
   */
  overlapConstraintPresent: boolean;
  /** The separate 61-in-one-window step: how many were sent, and the 1-based
   *  position of the first refusal, or null when none was refused. */
  ipCeilingControl: { sent: number; firstRefusedAt: number | null };
  platform: PlatformReading;
  /** The fault pass, when one ran. */
  faultPass?: { attempts: number; fiveXx: number; faultPct: number };
  /**
   * Which legs this run was CONFIGURED to have, so a leg that was asked for and
   * never arrived is incomplete rather than silently skipped (#2262).
   *
   * Required, so `tsc` names every construction site. Without it the burst bar was
   * gated on `burstResults.length > 0`, which cannot tell "this run had no burst
   * leg" from "the burst leg ran and its artifact never got here": the judge read
   * both as the first and published a report with its most important control
   * quietly absent (L98, L11). A hand run with no burst passes zeroes and the bars
   * are skipped exactly as before.
   */
  expectedLegs: { burstDrivers: number; faultPct: number };
  /** The Worker CPU budget the reading is judged against. */
  budgets: { cpuMsP99: number };
}

export interface Finding {
  /** What was measured, in the words a reader acts on. */
  bar: string;
  detail: string;
}

export type JudgeVerdict = "pass" | "incomplete" | "unmeasured" | "fail";

/**
 * Every way the judge can end, each on its own code.
 *
 * `incomplete` and `unmeasured` are deliberately NOT failures and deliberately not
 * passes. One says the run did not happen as asked, the other says the platform
 * could not tell us what it did; both mean nobody learned whether the booking path
 * holds up, and reporting either as a pass or a failure is a claim the run cannot
 * support (L98, L11).
 */
export const JUDGE_EXIT = {
  pass: 0,
  incomplete: 2,
  unmeasured: 3,
  fail: 4,
} as const;

/** p50, p95 and max over a set of durations. Empty gives nulls, never zeros: a
 *  zero p95 reads as instant rather than as nothing measured. */
export function percentiles(values: number[]): { p50: number; p95: number; max: number } | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return { p50: at(0.5), p95: at(0.95), max: s[s.length - 1]! };
}

/** Two windows overlap when each starts before the other ends: the half-open
 *  `[starts_at, ends_at)` comparison, so back-to-back calls do not read as a clash. */
export function overlaps(a: JudgedBooking, b: JudgedBooking): boolean {
  const as = Date.parse(a.starts_at);
  const ae = Date.parse(a.ends_at);
  const bs = Date.parse(b.starts_at);
  const be = Date.parse(b.ends_at);
  // An unreadable bound reads as OVERLAPPING, never as clear. This is the one
  // comparison in the file whose permissive answer would hide a double booking,
  // which is the worst thing this run can find (L50).
  if (![as, ae, bs, be].every(Number.isFinite)) return true;
  return as < be && bs < ae;
}

/** Statuses that hold a slot, so two of them on one agent at one time is a clash. */
const ACTIVE = new Set(["confirmed", "rescheduled", "completed"]);

function attemptsOf(results: DriverResult[]): BookingAttempt[] {
  return results.flatMap((r) => r.attempts);
}

/**
 * Why this run cannot be judged, or null.
 *
 * Checked BEFORE anything is computed, because every rate below is computable from
 * a partial run and every one of them looks plausible.
 */
export function incompleteness(input: JudgeInput): string[] {
  const why: string[] = [];
  const expectedPerDriver = input.target.perDriverPerMinute * input.target.minutes;

  if (input.driverResults.length !== input.target.drivers) {
    why.push(
      `${input.driverResults.length} driver result files, expected ${input.target.drivers}. ` +
        "A missing driver lowers every rate by a quarter and nothing in the numbers says so.",
    );
  }
  const seen = new Set(input.driverResults.map((r) => r.driver));
  if (seen.size !== input.driverResults.length) {
    why.push("two driver files claim the same driver number, so one driver's run is missing");
  }
  for (const r of input.driverResults) {
    if (r.runId !== input.runId) {
      why.push(`driver ${r.driver}'s file is from run ${r.runId}, not ${input.runId}`);
    }
    if (r.attempts.length !== expectedPerDriver) {
      why.push(
        `driver ${r.driver} recorded ${r.attempts.length} attempts, expected ${expectedPerDriver}`,
      );
    }
  }
  if (input.freshnessSamples.length !== input.target.minutes) {
    why.push(
      `${input.freshnessSamples.length} freshness samples, expected one a minute for ` +
        `${input.target.minutes} minutes. A short sample never reaches the age a full window does.`,
    );
  }
  // A burst driver that missed its moment is incomplete rather than failed: it
  // recorded nothing, so there is no contention to judge and "exactly one 200"
  // would be answered by however many drivers happened to arrive (L11).
  for (const b of input.burstResults) {
    if (b.burstSkipped) {
      why.push(
        `burst driver ${b.driver} did not fire (${b.burstSkipped}), so the burst was not simultaneous`,
      );
    }
  }
  // A leg the run was configured to have and did not get. Counted here rather than
  // left to the bar below, because the bar's own question ("was there exactly one
  // winner") cannot be asked of a leg whose file never arrived, and answering it
  // over nothing is how a missing control reads as a passing one.
  const wantBurst = input.expectedLegs.burstDrivers;
  if (wantBurst > 0 && input.burstResults.length !== wantBurst) {
    why.push(
      `${input.burstResults.length} burst driver files, expected ${wantBurst}. A burst judged on ` +
        `fewer drivers than fired is not the contention the control counts.`,
    );
  }
  const seenBurst = new Set(input.burstResults.map((b) => b.driver));
  if (seenBurst.size !== input.burstResults.length) {
    why.push("two burst driver files claim the same driver number, so one driver's burst is missing");
  }
  for (const b of input.burstResults) {
    if (b.runId !== input.runId) {
      why.push(`burst driver ${b.driver}'s file is from run ${b.runId}, not ${input.runId}`);
    }
    if (!b.burstSkipped && b.attempts.length !== b.planned) {
      why.push(
        `burst driver ${b.driver} fired ${b.attempts.length} of ${b.planned} planned requests, so ` +
          `the burst was smaller than the one being judged`,
      );
    }
  }
  const wantFault = input.expectedLegs.faultPct;
  if (wantFault > 0) {
    if (!input.faultPass) {
      why.push(
        `the run was configured with a fault pass at ${wantFault} percent and no fault result ` +
          `arrived, so the bar was never asked`,
      );
    } else if (input.faultPass.faultPct !== wantFault) {
      // The deployment's own reading, not the job's intention. A pass driven
      // against a deployment running a DIFFERENT percentage measured something
      // nobody configured, and zero is the case that matters: it answers every
      // request perfectly and satisfies the bar with no fault ever injected.
      why.push(
        `the fault pass ran against a deployment reporting ${input.faultPass.faultPct} percent, ` +
          `not the ${wantFault} it was configured for`,
      );
    }
  }
  return why;
}

/** What the run measured, once it is known to be complete. */
export interface RunMeasurements {
  attempts: number;
  confirmed: number;
  confirmedPerMinute: number;
  targetPerMinute: number;
  outcomes: Record<string, number>;
  /** Over EVERY response, whatever its status. */
  all: ReturnType<typeof percentiles>;
  /** Over the 200s alone, which is what the latency bar is about. */
  ok: ReturnType<typeof percentiles>;
  fiveXx: number;
  /** Requests that never got a reply at all, kept apart from a 5xx. */
  noReply: number;
  writeRefusals: number;
  /** Write refusals grouped by the address Slate said it saw. */
  refusalsByIp: Record<string, number>;
  freshnessMaxSec: number;
}

export function measure(input: JudgeInput): RunMeasurements {
  const attempts = attemptsOf(input.driverResults);
  const outcomes: Record<string, number> = {};
  for (const a of attempts) {
    const key = a.status === 200 ? (a.outcome ?? "ok") : `${a.status} ${a.outcome ?? ""}`.trim();
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }
  const refusalsByIp: Record<string, number> = {};
  for (const a of attempts) {
    if (a.status !== 429) continue;
    // An attempt with no echoed address is counted under a NAMED bucket rather
    // than dropped: a run whose echo header never arrived would otherwise report
    // no refusals at all and read as never having met the ceiling.
    const ip = a.seenIp ?? "(not echoed)";
    refusalsByIp[ip] = (refusalsByIp[ip] ?? 0) + 1;
  }
  const confirmed = attempts.filter((a) => a.status === 200).length;
  return {
    attempts: attempts.length,
    confirmed,
    confirmedPerMinute: input.target.minutes === 0 ? 0 : confirmed / input.target.minutes,
    targetPerMinute: input.target.drivers * input.target.perDriverPerMinute,
    outcomes,
    all: percentiles(attempts.map((a) => a.wallMs)),
    ok: percentiles(attempts.filter((a) => a.status === 200).map((a) => a.wallMs)),
    fiveXx: attempts.filter((a) => a.status >= 500).length,
    noReply: attempts.filter((a) => a.status === 0 && a.outcome !== "no-slots-offered").length,
    writeRefusals: attempts.filter((a) => a.status === 429).length,
    refusalsByIp,
    freshnessMaxSec: Math.max(0, ...input.freshnessSamples.map((s) => s.maxAgeSec)),
  };
}

/** The bars, in the order a reader should meet them. */
export const CONFIRMED_RATE_FLOOR = 0.8;
export const OK_P95_MS = 5000;
export const FRESHNESS_MAX_SEC = 6 * 60;
/** How far the platform's invocation count may sit below the run's own before its
 *  numbers are about a different window. */
export const INVOCATION_CONTROL_FLOOR = 0.5;

export interface JudgeResult {
  verdict: JudgeVerdict;
  exit: number;
  findings: Finding[];
  measurements: RunMeasurements | null;
  incomplete: string[];
}

export function judgeBookingRun(input: JudgeInput): JudgeResult {
  const incomplete = incompleteness(input);
  if (incomplete.length > 0) {
    return {
      verdict: "incomplete",
      exit: JUDGE_EXIT.incomplete,
      findings: [],
      measurements: null,
      incomplete,
    };
  }

  const m = measure(input);
  const findings: Finding[] = [];
  const fail = (bar: string, detail: string) => findings.push({ bar, detail });

  // --- throughput -------------------------------------------------------------
  const floor = m.targetPerMinute * CONFIRMED_RATE_FLOOR;
  if (m.confirmedPerMinute < floor) {
    fail(
      "confirmed bookings per minute",
      `${m.confirmedPerMinute.toFixed(1)} a minute against a target of ${m.targetPerMinute} ` +
        `(floor ${floor.toFixed(1)}). Outcome mix: ${JSON.stringify(m.outcomes)}`,
    );
  }

  // --- latency ----------------------------------------------------------------
  if (m.ok === null) {
    fail("latency of successful bookings", "not one request succeeded, so there is no p95 to judge");
  } else if (m.ok.p95 > OK_P95_MS) {
    fail(
      "latency of successful bookings",
      `p95 ${m.ok.p95}ms over the ${OK_P95_MS}ms bar (p50 ${m.ok.p50}ms, max ${m.ok.max}ms)`,
    );
  }
  // 5xx and no-reply are reported separately and BOTH fail. A request the
  // deployment answered badly and one it never answered send two different people
  // to two different places (L11).
  if (m.fiveXx > 0) fail("server errors", `${m.fiveXx} responses were 5xx`);
  if (m.noReply > 0) fail("unanswered requests", `${m.noReply} requests got no reply at all`);

  // --- the invariant the whole run exists to protect --------------------------
  // BOTH guards, reported separately: they send a reader to two different
  // migrations, and one message answering for the other is how somebody looks in
  // the wrong place (L11).
  if (!input.slotUniqueIndexPresent) {
    fail(
      "bookings_active_slot_uniq",
      "the index that makes two bookings on one agent at the SAME TIME impossible is NOT enforcing " +
        "on the branch, so an absence of overlaps below proves nothing about production",
    );
  }
  if (!input.overlapConstraintPresent) {
    fail(
      "bookings_active_no_overlap",
      "the constraint that makes two OVERLAPPING bookings on one agent impossible is NOT enforcing " +
        "on the branch. Appointments are longer than the grid they are offered on, so adjacent " +
        "offered times overlap and uniqueness cannot see them: an absence of overlaps below " +
        "proves nothing about the case this run exists to find",
    );
  }
  const byAgent = new Map<string, JudgedBooking[]>();
  for (const b of input.bookings) {
    if (!ACTIVE.has(b.status) || !b.assigned_user_id) continue;
    const list = byAgent.get(b.assigned_user_id) ?? [];
    list.push(b);
    byAgent.set(b.assigned_user_id, list);
  }
  const clashes: string[] = [];
  for (const [agent, list] of byAgent) {
    const sorted = [...list].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
    for (let i = 1; i < sorted.length; i++) {
      if (overlaps(sorted[i - 1]!, sorted[i]!)) {
        clashes.push(`${agent}: ${sorted[i - 1]!.id} and ${sorted[i]!.id}`);
      }
    }
  }
  if (clashes.length > 0) {
    fail(
      "double bookings",
      `${clashes.length} pairs of active bookings overlap on one agent: ${clashes.slice(0, 5).join("; ")}`,
    );
  }

  // --- every 200 left a row behind --------------------------------------------
  const bookedIds = new Set(input.bookings.map((b) => b.external_id ?? ""));
  const missingRow = attemptsOf(input.driverResults).filter(
    (a) => a.status === 200 && !bookedIds.has(a.externalId),
  );
  if (missingRow.length > 0) {
    fail(
      "a 200 with no booking row",
      `${missingRow.length} requests were answered 200 and no booking carries their external id ` +
        `(first: ${missingRow[0]!.externalId})`,
    );
  }
  const noKey = input.bookings.filter((b) => !b.idempotency_key);
  if (noKey.length > 0) {
    fail("idempotency key", `${noKey.length} booking rows carry no idempotency key`);
  }
  const withBlock = new Set(input.bookingIdsWithBusyBlock);
  const noBlock = input.bookings.filter((b) => ACTIVE.has(b.status) && !withBlock.has(b.id));
  if (noBlock.length > 0) {
    fail(
      "busy_blocks write-through",
      `${noBlock.length} active bookings have no busy_blocks row, so their slot still reads free`,
    );
  }

  // --- the burst --------------------------------------------------------------
  if (input.burstResults.length > 0) {
    const burst = attemptsOf(input.burstResults);
    const won = burst.filter((a) => a.status === 200);
    // The invariant is ONE WINNER PER AGENT, not one winner (#2261).
    //
    // "Exactly one" was a proxy for the burst code's pool being one agent deep,
    // which the seed does not guarantee and did not deliver: the first real run
    // answered TWO 200s at one slot, and they went to two DIFFERENT agents, which
    // is `bookings_active_slot_uniq` working exactly as specified. A bar that
    // failed on it would be red for a property of the roster rather than for
    // anything the booking path did, which is how a check stops being read (L36).
    //
    // What the index actually promises is that no AGENT holds two active bookings
    // at one slot, so that is what is asked. It is the stronger reading as well as
    // the truer one: at a pool of one it is the original control unchanged, and at
    // any depth it still catches the double booking the control existed to find.
    const agentOf = new Map(input.bookings.map((b) => [b.external_id ?? "", b.assigned_user_id]));
    const winningAgents = won.map((a) => agentOf.get(a.externalId) ?? null);
    const namedAgents = winningAgents.filter((id): id is string => id !== null);
    const distinct = new Set(namedAgents);
    if (won.length === 0) {
      fail(
        "the burst",
        `none of the ${burst.length} burst requests was answered 200, so the slot was already ` +
          "taken before the burst fired and nothing about contention was measured",
      );
    } else if (distinct.size < namedAgents.length) {
      fail(
        "the burst's winners",
        `${won.length} of ${burst.length} burst requests were answered 200 and they resolve to ` +
          `only ${distinct.size} agent(s), so an agent holds two active bookings at one slot`,
      );
    } else if (namedAgents.length < won.length) {
      fail(
        "the burst's winners",
        `${won.length - namedAgents.length} of the ${won.length} burst requests answered 200 have ` +
          "no booking row naming an agent, so the SLOT_TAKEN answers point at nothing",
      );
    }
    const taken = burst.filter((a) => a.status === 409 && a.outcome === "SLOT_TAKEN");
    const otherRefusals = burst.filter((a) => a.status !== 200 && a.outcome !== "SLOT_TAKEN");
    if (otherRefusals.length > 0) {
      fail(
        "the burst's losers",
        `${otherRefusals.length} burst requests were refused for a reason other than the slot being ` +
          `taken (${[...new Set(otherRefusals.map((a) => `${a.status} ${a.outcome}`))].join(", ")})`,
      );
    }
    // `taken` is read for the count above and deliberately not asserted on
    // separately: every non-winner is already required to be SLOT_TAKEN by the
    // `otherRefusals` bar, and whether each winner has a booking row is what the
    // agent lookup above measures.
    void taken;
  }

  // --- freshness --------------------------------------------------------------
  if (m.freshnessMaxSec > FRESHNESS_MAX_SEC) {
    fail(
      "recompute freshness under load",
      `the oldest bucket reached ${m.freshnessMaxSec}s, over the ${FRESHNESS_MAX_SEC}s bar`,
    );
  }

  // --- the per address ceiling, proved by its own step ------------------------
  const c = input.ipCeilingControl;
  if (c.sent === 0) {
    // The control did not RUN. Said in its own words rather than folded into
    // "nothing was refused": one sends somebody to look at why the ceiling is off,
    // the other to look at why a job did not produce its file, and a message may
    // claim only what its check measured (L11).
    fail(
      "the per address write ceiling",
      "the control sent no writes at all, so the ceiling was never exercised and every 429 the " +
        "run attributed is unattributed",
    );
  } else if (c.firstRefusedAt === null) {
    fail(
      "the per address write ceiling",
      `${c.sent} writes were sent from one address in one window and none was refused, so the ` +
        "ceiling is not applying. Every 429 the run attributed below means something else.",
    );
  } else if (c.firstRefusedAt <= c.sent - 1) {
    // Refusing EARLY is a finding too: the ceiling is tighter than the app says,
    // and the run's own pacing sits on that number.
    fail(
      "the per address write ceiling",
      `the ceiling refused at request ${c.firstRefusedAt} of ${c.sent}, earlier than the ` +
        "configured limit, so the run was pacing against a number that is not the real one",
    );
  }

  // --- the fault pass ---------------------------------------------------------
  if (input.faultPass) {
    if (input.faultPass.attempts === 0) {
      fail(
        "the fault pass",
        `it was configured at ${input.faultPass.faultPct} percent and made no requests, so it ` +
          "proved nothing",
      );
    } else if (input.faultPass.fiveXx > 0) {
      fail(
        "the fault pass",
        `${input.faultPass.fiveXx} of ${input.faultPass.attempts} requests were 5xx with Google ` +
          `failing ${input.faultPass.faultPct} percent of reads; the path must degrade, not error`,
      );
    }
  }


  // The fault pass is judged BEFORE the platform read, and the ordering is load
  // bearing (#2261). The platform section is the only one that can RETURN early,
  // and while this sat below it an unreadable analytics window skipped this bar
  // entirely: the first real run answered three 500s under fault and the report
  // never mentioned them. Anything measurable from the run's OWN files belongs
  // above the one check that depends on somebody else's pipeline.
  // --- the platform's own numbers ---------------------------------------------
  const p = input.platform;
  const expectedInvocations = m.attempts;
  if (p.invocations === null || p.cpuMsP99 === null || p.outcomes === null) {
    return unmeasured(
      m,
      "the analytics API did not report CPU, outcomes or invocations for the window",
      findings,
    );
  }
  if (p.invocations < expectedInvocations * INVOCATION_CONTROL_FLOOR) {
    // The CONTROL. A count far under what the run itself made says the pipeline
    // had not caught up (it has lagged three hours), so the CPU and subrequest
    // numbers beside it describe a window that is not this one. Reported as
    // unmeasured rather than as a pass, because a low reading from a lagging
    // pipeline looks exactly like a cheap run (#1533, L98).
    return unmeasured(
      m,
      `the analytics API counted ${p.invocations} invocations against the ${expectedInvocations} ` +
        "this run made, so its CPU and subrequest numbers are about a different window",
      findings,
    );
  }
  if (p.cpuMsP99 > input.budgets.cpuMsP99) {
    fail("Worker CPU", `p99 ${p.cpuMsP99}ms over the ${input.budgets.cpuMsP99}ms budget`);
  }
  // Every outcome other than `ok` is a finding, and they are named rather than
  // summed: `exceededCpu` (Cloudflare killed the invocation mid flight),
  // `exceededMemory` and a subrequest breach each mean a different thing to fix,
  // and a single "N invocations exceeded a limit" would send one person to look at
  // three different problems (L11).
  const bad = Object.entries(p.outcomes).filter(([outcome]) => outcome !== "ok");
  for (const [outcome, n] of bad) {
    if (n > 0) fail("platform outcome", `${n} invocations ended as ${outcome} rather than ok`);
  }
  if (Object.keys(p.outcomes).length === 0) {
    // An empty histogram is not "every invocation was fine": it is a reading that
    // found nothing, and the control above cannot catch it because invocations are
    // counted separately.
    return unmeasured(
      m,
      "the analytics API reported no invocation outcomes at all for the window",
      findings,
    );
  }

  return {
    verdict: findings.length === 0 ? "pass" : "fail",
    exit: findings.length === 0 ? JUDGE_EXIT.pass : JUDGE_EXIT.fail,
    findings,
    measurements: m,
    incomplete: [],
  };
}

/**
 * The platform half could not be read, and the rest of the run still happened.
 *
 * It CARRIES the findings the other bars already produced (#2261). Returning only
 * the platform one discarded them, and the first real run proved how much that
 * costs: a burst with two winners and a fault pass that answered three 500s were
 * both measured, both real, and both silently dropped, so the report said nothing
 * but "the analytics API did not report" while the run held two genuine defects.
 * Cloudflare's pipeline having lagged says nothing whatever about bars that were
 * measured from the run's own files.
 *
 * So the VERDICT depends on what those bars found. A measured failure is a failure
 * whatever the analytics did, and calling that `unmeasured` would file a red run
 * under "could not conclude", which is how a finding stops being read (L11).
 * `unmeasured` is reserved for the case where the platform half is the ONLY thing
 * with anything to say.
 */
function unmeasured(m: RunMeasurements, why: string, findings: Finding[]): JudgeResult {
  const measuredFailures = findings.length > 0;
  return {
    verdict: measuredFailures ? "fail" : "unmeasured",
    exit: measuredFailures ? JUDGE_EXIT.fail : JUDGE_EXIT.unmeasured,
    findings: [...findings, { bar: "platform limits", detail: why }],
    measurements: m,
    incomplete: [],
  };
}

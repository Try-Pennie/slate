/**
 * The probe behind `pnpm verify:confirm-line` (#3340): does the shared confirm line
 * (#3325) answer the confirm path's own client the way its rules say, in production?
 *
 * WHY THERE IS A PROBE AT ALL. The confirm path falls back to the isolate's own line
 * whenever the shared one cannot be used, deliberately, because correctness never rests
 * on the line. The cost of that choice is that a `CONFIRM_LINE` object which is bound
 * and does not answer reads as healthy on every surface until a crowd for one slot
 * arrives, every isolate forms its own line again, and fifty leaders saturate the
 * database together (load run 37333201026). Between load runs nothing asked the object
 * anything, which is a check that has never once concluded (L557).
 *
 * WHAT IT DRIVES. The PRODUCTION client, `makeSharedConfirmLine`, over the PRODUCTION
 * transport (`durableLineNamespace`, wired by the route), so a fault in either is a
 * fault here. A fake object would agree with our assumptions by construction (L52).
 * Each participant below is its own client, as two isolates would hold two.
 *
 * WHAT IT CHECKS, each answering on its own named outcome (L11), and each in both
 * directions, because a line hard wired to one answer passes a check that asks only
 * one question (L1):
 *
 *  - `full`: B, queued behind A, is REFUSED as taken once A reports a full verdict, and
 *    receives A's settlement intact.
 *  - `notFull`: B LEADS once A reports a not full verdict, within one call of it, so a
 *    hand on by the verdict is told apart from one by a lease running out.
 *  - `abandoned`: A takes the lead and never acknowledges it (its client's every call
 *    after the enter is lost, as when an answer never reaches its caller), and B leads
 *    within the acknowledgement window rather than after the whole lease.
 *  - `nothingHeld`: afterwards, a newcomer on each instant the probe used leads at
 *    once, so the probe is MEASURED to have left nothing held, not assumed to.
 *
 * WHAT IT CANNOT PROVE, stated so nobody reads more into a pass: every participant runs
 * in ONE isolate, the route's. A pass proves the object answers and keeps the rules; it
 * cannot prove that two isolates reach the SAME object. Only a load run, whose confirms
 * spread across isolates, can show that.
 *
 * WHERE IT WRITES. One object, the verification group's, which no real line key can
 * name (`scripts/test-confirm-line-live-control.ts` walks the one constructor every real
 * key comes from), and only fresh instants within it, minted per run, so two runs never
 * meet and no run ever meets a real confirm.
 *
 * Pure apart from what it is handed, with relative imports only, so the node test drives
 * it against the real object host on a virtual clock.
 */
import { makeSharedConfirmLine, CONFIRM_LINE_CALL_MS, type LineNamespace, type LineServed, type SwitchReading } from "../booking/shared-confirm-line.ts";
import { makeConfirmQueue, isolateLine, type LineKey, type LineTurn, type LeaderVerdict } from "../booking/confirm-queue.ts";
import { CONFIRM_LINE_ACK_MS, CONFIRM_LINE_LEASE_MS } from "../booking/confirm-line-object.ts";
import { shortErrorReason } from "../notify/error-text.ts";
import type { ScheduleTimer } from "../read-within-deadline.ts";

/**
 * The line group the probe writes into, and the entire reason it cannot touch a real
 * line. A real group is `link:`, `code:` or `ladder:` and then something
 * (`confirmQueueKey`, `ladderGroupOf`), and the object is named from the whole group, so
 * the prefix is the separation. `keyKindOf` reads this one as `none`.
 */
export const CONFIRM_LINE_VERIFY_GROUP = "monitor:confirm-line-verify";

/** What the endpoint says happened, as a machine reason rather than prose (L156). */
export const CONFIRM_LINE_PROBE_REASON = {
  /** The probe ran; each check's outcome is in the reply. */
  checked: "checked",
  /** The Worker could not read its own context, so nothing was looked up. */
  contextUnreadable: "context-unreadable",
  /** The context read fine and `CONFIRM_LINE` is not in it. */
  bindingMissing: "binding-missing",
} as const;

export const CONFIRM_LINE_CHECKS = ["full", "notFull", "abandoned", "nothingHeld"] as const;
export type ConfirmLineCheck = (typeof CONFIRM_LINE_CHECKS)[number];

export const CHECK_OUTCOMES = [
  "passed",
  /** A participant could not use the object and fell back to its isolate's own line. */
  "unreachable",
  /** The probe's own code threw; never a finding about the object. */
  "errored",
  /** The first confirm on an instant nobody had used was not given the lead. */
  "idle-not-led",
  /** The second confirm led while the first still held the line. */
  "led-beside",
  /** A full verdict did not refuse the follower as taken with the settlement intact. */
  "not-settled",
  /** A not full verdict did not hand the follower the lead within one call. */
  "not-handed-on",
  /** An abandoned lead was freed, but only after its acknowledgement window. */
  "freed-late",
  /** An abandoned lead was never freed inside the follower's whole wait. */
  "not-freed",
  /** An instant the probe used was still held after it finished. */
  "held",
] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

/** Which outcomes each check can end on. A reader refuses any other (L98). */
export const CHECK_CAN_END_ON: Record<ConfirmLineCheck, readonly CheckOutcome[]> = {
  full: ["passed", "unreachable", "errored", "idle-not-led", "led-beside", "not-settled"],
  notFull: ["passed", "unreachable", "errored", "idle-not-led", "led-beside", "not-handed-on"],
  abandoned: ["passed", "unreachable", "errored", "idle-not-led", "led-beside", "freed-late", "not-freed"],
  nothingHeld: ["passed", "unreachable", "errored", "held"],
};

export interface CheckResult {
  outcome: CheckOutcome;
  /** What the check saw, in words a reader can act on. Never contact data. */
  detail: string;
}
export type ProbeReport = Record<ConfirmLineCheck, CheckResult>;

/**
 * How long a follower waits in line. Past the whole lease plus a call, so a lead freed
 * only by its lease is SEEN as freed late, rather than the follower giving up first and
 * reporting it as never freed.
 */
export const PROBE_FOLLOWER_WAIT_MS = CONFIRM_LINE_LEASE_MS + 2_000;

/**
 * The latest an abandoned lead may be freed and still count as freed by its
 * acknowledgement window: the window, plus one call's deadline for the answer to travel.
 * Well short of the lease, which is what frees it when the window is not enforced.
 */
export const ABANDONED_LEAD_FREED_WITHIN_MS = CONFIRM_LINE_ACK_MS + CONFIRM_LINE_CALL_MS;

/** How soon after a leader's report the follower must have its answer: one call. */
export const VERDICT_REACHES_FOLLOWER_WITHIN_MS = CONFIRM_LINE_CALL_MS;

/**
 * The switch reading every participant is given. The stored switch decides whether REAL
 * confirms use the shared line; it says nothing about whether the object answers, and a
 * probe that stood down while it was off would prove nothing for exactly as long as the
 * line is not yet relied on.
 */
export const PROBE_SWITCH: SwitchReading = { on: true, source: "read" };

export interface ConfirmLineProbeDeps {
  namespace: LineNamespace;
  now: () => number;
  timer: ScheduleTimer;
  newId: () => string;
}

/** One call a participant made, as its transport saw it. `kind` is null for a call that failed. */
interface Seen {
  op: string;
  kind: string | null;
  sentAt: number;
  at: number;
}

/** Why the abandoned leader's calls after its enter never arrive. */
const SEVERED = "the probe's abandoned leader sends nothing after its enter";

type Turn = LineTurn<unknown>;

/** A client of the shared line as one isolate would hold it, with its calls recorded. */
function participant(deps: ConfirmLineProbeDeps, opts: { severAfterEnter?: boolean } = {}) {
  const seen: Seen[] = [];
  const watching: { want: (s: Seen) => boolean; found: (s: Seen) => void }[] = [];
  let served: LineServed | null = null;
  let reach = "";
  const note = (s: Seen) => {
    seen.push(s);
    for (const w of watching.splice(0)) {
      if (w.want(s)) w.found(s);
      else watching.push(w);
    }
  };
  const namespace: LineNamespace = {
    stubFor(group) {
      const stub = deps.namespace.stubFor(group);
      return {
        async send(message) {
          const op = String(message.op);
          const sentAt = deps.now();
          if (opts.severAfterEnter && op !== "enter") {
            note({ op, kind: null, sentAt, at: sentAt });
            throw new Error(SEVERED);
          }
          try {
            const answer = await stub.send(message);
            const kind = typeof answer.kind === "string" ? answer.kind : answer.ok === true ? "ok" : "unknown";
            note({ op, kind, sentAt, at: deps.now() });
            return answer;
          } catch (err) {
            note({ op, kind: null, sentAt, at: deps.now() });
            throw err;
          }
        },
      };
    },
  };
  const line = makeSharedConfirmLine<unknown>({
    namespace,
    // Its own throwaway line, never the module's: a participant that falls back must not
    // queue behind another participant in the isolate, or a fallback would read as a wait.
    fallback: isolateLine(makeConfirmQueue<unknown>({ timer: deps.timer, leaseTimer: deps.timer, now: deps.now })),
    enabled: async () => PROBE_SWITCH,
    record: (s) => {
      served = { ...s };
    },
    onReachFailure: (reason, err) => {
      reach = err ? `${reason}, ${shortErrorReason(err)}` : reason;
    },
    now: deps.now,
    timer: deps.timer,
    newId: deps.newId,
    trace: null,
  });
  return {
    line,
    seen,
    /** Why it fell back to its isolate's own line, or null while it is on the shared one. */
    fellBack(): string | null {
      const s = served as LineServed | null;
      if (s === null || s.line === "shared") return null;
      return reach || `${s.line}, ${s.reason}`;
    },
    /** The first call matching `want`, made already or still to come. */
    first(want: (s: Seen) => boolean): Promise<Seen> {
      const found = seen.find(want);
      if (found) return Promise.resolve(found);
      return new Promise((resolve) => watching.push({ want, found: resolve }));
    },
  };
}
type Participant = ReturnType<typeof participant>;

/**
 * Every turn a check takes, so every lead it is handed is reported before the check
 * returns, whichever way it ends. A turn still in flight is awaited first: each one is
 * bounded by its own wait, so this cannot hang.
 */
function holdings() {
  const pending: Promise<Turn>[] = [];
  const reported = new WeakSet<object>();
  return {
    track(turn: Promise<Turn>): Promise<Turn> {
      pending.push(turn);
      return turn;
    },
    async report(turn: Turn, verdict: LeaderVerdict<unknown>): Promise<void> {
      if (turn.kind !== "lead" || reported.has(turn)) return;
      reported.add(turn);
      await turn.done(verdict);
    },
    async releaseAll(): Promise<void> {
      for (const p of pending) {
        const turn = await p.catch(() => null);
        if (turn?.kind === "lead" && !reported.has(turn)) {
          reported.add(turn);
          await turn.done({ full: false });
        }
      }
    },
  };
}

const passed = (detail: string): CheckResult => ({ outcome: "passed", detail });
const unreachable = (who: string, why: string): CheckResult => ({
  outcome: "unreachable",
  detail: `${who} could not use the shared line and fell back to its isolate's own (${why})`,
});
const describe = (turn: Turn): string =>
  turn.kind === "refused" ? `refused as ${turn.refusal}` : turn.kind === "lead" ? "the lead" : "nothing, its wait ran out";
const isLeadAnswer = (s: Seen) => (s.op === "enter" || s.op === "poll") && s.kind === "lead";

/** The leader's turn on a fresh instant, or why the check cannot go on. */
function leaderBlocked(a: Participant, turn: Turn): CheckResult | null {
  const fell = a.fellBack();
  if (fell) return unreachable("The first confirm", fell);
  if (turn.kind !== "lead") {
    return {
      outcome: "idle-not-led",
      detail: `The first confirm on an instant nobody had used was answered ${describe(turn)}, so something already held it`,
    };
  }
  return null;
}

/**
 * B enters behind a leader. Resolves once the object has answered B's enter with a
 * ticket or a lead, or B has stopped trying (it fell back, or its client gave up).
 */
async function followerEntered(b: Participant, follower: Promise<Turn>): Promise<Seen | null> {
  return Promise.race([
    b.first((s) => s.op === "enter" && (s.kind === "wait" || s.kind === "lead")),
    follower.then(() => null),
  ]);
}

function keyFor(run: string, check: ConfirmLineCheck): LineKey {
  return { group: CONFIRM_LINE_VERIFY_GROUP, instant: `${run}:${check}` };
}

/**
 * The front half both verdict checks share: A leads on a fresh instant and B queues
 * behind it. Answers the queued pair, or the result that ends the check before any
 * verdict is reported (A could not lead, B fell back, or B led beside A).
 */
async function queuedBehindLeader(
  deps: ConfirmLineProbeDeps,
  key: LineKey,
  held: ReturnType<typeof holdings>,
): Promise<CheckResult | { lead: Turn; follower: Promise<Turn>; b: Participant }> {
  const a = participant(deps);
  const b = participant(deps);
  const lead = await held.track(a.line.enter(key, 0));
  const blocked = leaderBlocked(a, lead);
  if (blocked) return blocked;
  const follower = held.track(b.line.enter(key, PROBE_FOLLOWER_WAIT_MS));
  const entered = await followerEntered(b, follower);
  const fell = b.fellBack();
  if (fell) return unreachable("The second confirm", fell);
  if (entered?.kind === "lead") {
    return { outcome: "led-beside", detail: "The second confirm was given the lead while the first still held the line, so the line excluded nobody" };
  }
  return { lead, follower, b };
}

async function checkFull(deps: ConfirmLineProbeDeps, key: LineKey, run: string): Promise<CheckResult> {
  const held = holdings();
  try {
    const queued = await queuedBehindLeader(deps, key, held);
    if ("outcome" in queued) return queued;
    const settlement = { probe: "confirm-line", run };
    await held.report(queued.lead, { full: true, refusal: "taken", settled: settlement });
    const turn = await queued.follower;
    const late = queued.b.fellBack();
    if (late) return unreachable("The second confirm", late);
    if (turn.kind !== "refused" || turn.refusal !== "taken") {
      return { outcome: "not-settled", detail: `After the first confirm reported the slot full, the one waiting behind it was given ${describe(turn)} rather than refused as taken` };
    }
    if (JSON.stringify(turn.settled) !== JSON.stringify(settlement)) {
      return { outcome: "not-settled", detail: "The waiting confirm was refused as taken, but the settlement the leader handed on did not arrive intact" };
    }
    return passed("The confirm waiting behind a full verdict was refused as taken and handed the leader's settlement intact");
  } finally {
    await held.releaseAll();
  }
}

async function checkNotFull(deps: ConfirmLineProbeDeps, key: LineKey): Promise<CheckResult> {
  const held = holdings();
  try {
    const queued = await queuedBehindLeader(deps, key, held);
    if ("outcome" in queued) return queued;
    await held.report(queued.lead, { full: false });
    const reportedAt = deps.now();
    const turn = await queued.follower;
    const late = queued.b.fellBack();
    if (late) return unreachable("The second confirm", late);
    const led = queued.b.seen.find(isLeadAnswer);
    if (turn.kind !== "lead" || !led) {
      return { outcome: "not-handed-on", detail: `After the first confirm reported the slot NOT full, the one waiting behind it was given ${describe(turn)} rather than the lead` };
    }
    const afterMs = Math.max(0, led.at - reportedAt);
    if (afterMs > VERDICT_REACHES_FOLLOWER_WITHIN_MS) {
      return {
        outcome: "not-handed-on",
        detail: `The waiting confirm led only ${afterMs}ms after the not full report, which is a lease running out rather than the verdict handing the line on`,
      };
    }
    return passed(`The confirm waiting behind a not full verdict was handed the lead ${afterMs}ms after the report`);
  } finally {
    await held.releaseAll();
  }
}

async function checkAbandoned(deps: ConfirmLineProbeDeps, key: LineKey): Promise<CheckResult> {
  const a = participant(deps, { severAfterEnter: true });
  const b = participant(deps);
  const held = holdings();
  try {
    const lead = await held.track(a.line.enter(key, 0));
    const blocked = leaderBlocked(a, lead);
    if (blocked) return blocked;
    const granted = a.seen.find((s) => s.op === "enter" && s.kind === "lead");
    if (!granted) {
      return { outcome: "idle-not-led", detail: "The first confirm reported the lead without the object having answered its enter with one" };
    }
    const follower = held.track(b.line.enter(key, PROBE_FOLLOWER_WAIT_MS));
    const entered = await followerEntered(b, follower);
    const fell = b.fellBack();
    if (fell) return unreachable("The second confirm", fell);
    // The object started the window before its answer reached A, by up to A's own round
    // trip, so only an answer this early is certainly inside the window.
    const surelyInside = CONFIRM_LINE_ACK_MS - (granted.at - granted.sentAt);
    if (entered?.kind === "lead" && entered.at - granted.at <= surelyInside) {
      return {
        outcome: "led-beside",
        detail: "The second confirm was given the lead while the first was still inside its acknowledgement window, so an unacknowledged lead held nothing",
      };
    }
    const turn = await follower;
    const late = b.fellBack();
    if (late) return unreachable("The second confirm", late);
    const led = b.seen.find(isLeadAnswer);
    if (turn.kind !== "lead" || !led) {
      return {
        outcome: "not-freed",
        detail: `Behind a lead nobody acknowledged, the waiting confirm was given ${describe(turn)} after waiting ${PROBE_FOLLOWER_WAIT_MS}ms, so an abandoned leader holds the line`,
      };
    }
    const elapsedMs = led.at - granted.at;
    if (elapsedMs > ABANDONED_LEAD_FREED_WITHIN_MS) {
      return {
        outcome: "freed-late",
        detail: `Behind a lead nobody acknowledged, the waiting confirm led only ${elapsedMs}ms later, past the ${CONFIRM_LINE_ACK_MS}ms acknowledgement window, so only the lease freed it`,
      };
    }
    return passed(`Behind a lead nobody acknowledged, the waiting confirm led ${elapsedMs}ms later, inside the acknowledgement window`);
  } finally {
    await held.releaseAll();
  }
}

async function checkNothingHeld(deps: ConfirmLineProbeDeps, keys: readonly LineKey[]): Promise<CheckResult> {
  // Never a pass over nothing (L98). Each check claims its instant before it starts, so
  // this would mean the probe changed shape, which is a fault in this file.
  if (keys.length === 0) return { outcome: "errored", detail: "No instant was used, so there was nothing to find held" };
  const stillHeld: string[] = [];
  for (const key of keys) {
    const c = participant(deps);
    const held = holdings();
    try {
      const turn = await held.track(c.line.enter(key, 0));
      const fell = c.fellBack();
      if (fell) return unreachable("A newcomer after the checks", fell);
      if (turn.kind !== "lead") stillHeld.push(key.instant.slice(key.instant.lastIndexOf(":") + 1));
    } finally {
      await held.releaseAll();
    }
  }
  if (stillHeld.length > 0) {
    return { outcome: "held", detail: `After the checks, the instant used by ${stillHeld.join(" and ")} was still held, so a newcomer there could not lead at once` };
  }
  return passed(`After the checks, a newcomer led at once on each of the ${keys.length} instants they used`);
}

/** A check that threw is the probe's own fault, said as such and never as the object's. */
async function guarded(work: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await work();
  } catch (err) {
    return { outcome: "errored", detail: `The probe itself failed before the check could answer: ${shortErrorReason(err)}` };
  }
}

/** Run every check, in order, each on its own fresh instant of the verification group. */
export async function runConfirmLineProbe(deps: ConfirmLineProbeDeps): Promise<ProbeReport> {
  const run = deps.newId();
  const used: LineKey[] = [];
  const claim = (check: ConfirmLineCheck) => {
    const key = keyFor(run, check);
    used.push(key);
    return key;
  };
  const full = await guarded(() => checkFull(deps, claim("full"), run));
  const notFull = await guarded(() => checkNotFull(deps, claim("notFull")));
  const abandoned = await guarded(() => checkAbandoned(deps, claim("abandoned")));
  const nothingHeld = await guarded(() => checkNothingHeld(deps, used));
  return { full, notFull, abandoned, nothingHeld };
}

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
 *  - `notFull`: B LEADS once A reports a not full verdict, within the report's own two
 *    calls (it is retried once) of the report leaving A, so a hand on by the verdict is
 *    told apart from one by a lease running out.
 *  - `abandoned`: A takes the lead and never acknowledges it (its client's every call
 *    after the enter is lost, as when an answer never reaches its caller), and B leads
 *    within the acknowledgement window rather than after the whole lease.
 *  - `nothingHeld`: afterwards, a newcomer on each instant the probe used leads at
 *    once, so the probe is MEASURED to have left nothing held, not assumed to.
 *  - `directory` (#3460): the pool grouping DIRECTORY, a reserved instance of the same
 *    class, stores a put and hands it back, keeps the newest over an older put (both
 *    directions, on the probe's OWN directory), and the LIVE directory holds a grouping
 *    a cold server would install: this build's format, well formed, and read within
 *    `PROBE_GROUPING_MAX_AGE_MS`. The live one is only ever READ, so the proof can never
 *    put a grouping in front of a real confirm.
 *  - `directoryWake` (#3481): the probe's own directory, left idle past the platform's
 *    hibernation window, hands back the grouping it stored, answered FROM STORAGE. #3479
 *    keeps the snapshot in the object's storage because the platform discards an idle
 *    object's memory after ten seconds; the tests can show that only with a stand in
 *    (L52, L82), so this is the check that it still holds on the real platform. Its two
 *    endings that are not a pass are kept apart: the grouping gone after the wait is a
 *    failure, and every read answering from memory is a wake the probe could not SEE,
 *    which is never a pass (L98, L159) and never called a failure of storage either.
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
import {
  POOL_GROUPING_DIRECTORY,
  POOL_GROUPING_FORMAT,
  POOL_GROUPING_VERIFY_DIRECTORY,
  groupingGetMessage,
  groupingPutMessage,
  groupingSnapshotOf,
  readGroupingSnapshot,
  type DirectoryStub,
  type GroupingAnsweredFrom,
  type GroupingSnapshot,
} from "../booking/pool-grouping.ts";
import { shortErrorReason } from "../notify/error-text.ts";
import { readWithinDeadline, type ScheduleTimer } from "../read-within-deadline.ts";

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

export const CONFIRM_LINE_CHECKS = ["full", "notFull", "abandoned", "nothingHeld", "directory", "directoryWake"] as const;
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
  /** A not full verdict did not hand the follower the lead within the report's two calls. */
  "not-handed-on",
  /** An abandoned lead was freed, but only after its acknowledgement window. */
  "freed-late",
  /** An abandoned lead was never freed inside the follower's whole wait. */
  "not-freed",
  /** An instant the probe used was still held after it finished. */
  "held",
  /** #3460: the pool grouping directory did not answer within a call. */
  "directory-unreachable",
  /** The directory did not store a fresh put, or handed back something else. */
  "not-stored",
  /** An older put replaced the newer snapshot. */
  "older-won",
  /** The live directory holds no grouping: nothing has published since it started. */
  "no-grouping",
  /** The live grouping would be refused by a cold server: another format, malformed, or stale. */
  "grouping-unusable",
  /** #3481: left idle past the hibernation window, the directory no longer handed back the grouping it stored. */
  "lost-after-idle",
  /** Every read after the wait was answered from memory, or without saying where from, so no wake was seen. */
  "wake-unobserved",
] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

/** Which outcomes each check can end on. A reader refuses any other (L98). */
export const CHECK_CAN_END_ON: Record<ConfirmLineCheck, readonly CheckOutcome[]> = {
  full: ["passed", "unreachable", "errored", "idle-not-led", "led-beside", "not-settled"],
  notFull: ["passed", "unreachable", "errored", "idle-not-led", "led-beside", "not-handed-on"],
  abandoned: ["passed", "unreachable", "errored", "idle-not-led", "led-beside", "freed-late", "not-freed"],
  nothingHeld: ["passed", "unreachable", "errored", "held"],
  directory: ["passed", "errored", "directory-unreachable", "not-stored", "older-won", "no-grouping", "grouping-unusable"],
  directoryWake: ["passed", "errored", "directory-unreachable", "not-stored", "lost-after-idle", "wake-unobserved"],
};

/**
 * How old the LIVE grouping may be before the proof calls it stale (#3460): three of the
 * recompute lane's one minute publishes. Looser than the minute a server holds a grouping for,
 * because the proof runs once a day at a moment that can fall in a minute's gap between
 * one snapshot expiring and the next landing; three missed publishes is a publisher that
 * has stopped, which the `pool-grouping` heartbeat also pages on.
 */
export const PROBE_GROUPING_MAX_AGE_MS = 3 * 60_000;

/**
 * How long an idle Durable Object stays in memory before the platform hibernates it and
 * discards that memory: "currently, it is after 10 seconds of inactivity" (the Durable
 * Object lifecycle docs, read 2026-10-07), for an object with no timers, no unfinished
 * I/O and no request in flight, which the directory's instance is between calls. The
 * platform's own number, not ours, and the reason the directory keeps its snapshot in
 * storage (#3479).
 */
export const PLATFORM_HIBERNATE_AFTER_MS = 10_000;
/**
 * #3481: how long the probe leaves its own directory idle before each read. Every read is
 * a call, and a call resets the object's idle clock, so each spell must on its own be past
 * the window, or the probe's polling is what keeps the object awake. Twice the documented
 * window, because the runtime decides when it acts and says only what it does currently.
 */
export const PROBE_WAKE_IDLE_MS = 2 * PLATFORM_HIBERNATE_AFTER_MS;
/**
 * How many spells the probe waits through for a read answered from storage before it says
 * it could not see a wake. More than one, so a single spell the runtime happened to stretch
 * is not the day's verdict; few, because every spell is time the daily request is held
 * open, and an object that is still awake after a minute idle is not hibernating the way
 * the directory's design assumes, which is itself the thing to say.
 */
export const PROBE_WAKE_READS = 3;

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

/**
 * How soon after a leader's report LEAVES it the follower must have the lead: the report's
 * own two calls, because the client retries a report it got no answer to, so a verdict
 * whose first send was lost still hands the line on by the verdict. Below the earliest a
 * lease can end after the report leaves (the lease less one heartbeat, since the last
 * renewal can be a heartbeat before the report), so a lease is never read as the verdict.
 */
export const VERDICT_REACHES_FOLLOWER_WITHIN_MS = 2 * CONFIRM_LINE_CALL_MS;

/**
 * The switch reading every participant is given. The stored switch decides whether REAL
 * confirms use the shared line; it says nothing about whether the object answers, and a
 * probe that stood down while it was off would prove nothing for exactly as long as the
 * line is not yet relied on.
 */
export const PROBE_SWITCH: SwitchReading = { on: true, source: "read" };

export interface ConfirmLineProbeDeps {
  namespace: LineNamespace;
  /** #3460: a pool grouping directory's stub by name, the production directory transport. */
  directory: (name: string) => DirectoryStub;
  now: () => number;
  timer: ScheduleTimer;
  /** #3481: how the probe waits out an idle spell. Injected, so no test waits for real (L524). */
  sleep: (ms: number) => Promise<void>;
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
  /** When each call left, in order, recorded before it is answered or given up on. */
  const sends: { op: string; at: number }[] = [];
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
          sends.push({ op, at: sentAt });
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
    /** When the first call of `op` left this client, or null when none was sent. */
    firstSent(op: string): number | null {
      return sends.find((s) => s.op === op)?.at ?? null;
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
): Promise<CheckResult | { lead: Turn; follower: Promise<Turn>; a: Participant; b: Participant }> {
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
  return { lead, follower, a, b };
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
    const asked = deps.now();
    await held.report(queued.lead, { full: false });
    const turn = await queued.follower;
    const late = queued.b.fellBack();
    if (late) return unreachable("The second confirm", late);
    const led = queued.b.seen.find(isLeadAnswer);
    if (turn.kind !== "lead" || !led) {
      return { outcome: "not-handed-on", detail: `After the first confirm reported the slot NOT full, the one waiting behind it was given ${describe(turn)} rather than the lead` };
    }
    // Timed from when the report LEFT the leader, never from when the report call returned:
    // the client retries a report not answered within one call, so the call can return long
    // after the line was handed on, and timing from there reads a slow hand on as instant.
    // A leader whose client sent no report at all (it had already lost its turn) is timed
    // from the moment it was asked to.
    return judgeHandOn(led.at, queued.a.firstSent("done") ?? asked);
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

/**
 * Was the follower handed the lead BY the not full verdict? `ledAt` is when its lead
 * answer arrived and `reportSentAt` when the leader's report left. Within the report's two
 * calls is the verdict; later is a lease running out. EARLIER is not clamped to zero: a
 * follower led before the report even left was led while the first still held the line,
 * which no verdict explains.
 */
export function judgeHandOn(ledAt: number, reportSentAt: number): CheckResult {
  const afterMs = ledAt - reportSentAt;
  if (afterMs < 0) {
    return {
      outcome: "led-beside",
      detail: `The waiting confirm was handed the lead ${-afterMs}ms before the first confirm's not full report had even been sent, so the line let it lead while the first still held it`,
    };
  }
  if (afterMs > VERDICT_REACHES_FOLLOWER_WITHIN_MS) {
    return {
      outcome: "not-handed-on",
      detail: `The waiting confirm led only ${afterMs}ms after the not full report was sent, which is a lease running out rather than the verdict handing the line on`,
    };
  }
  return passed(`The confirm waiting behind a not full verdict was handed the lead ${afterMs}ms after the report was sent`);
}

/** A directory answer's kind, in words, for a detail line. */
const kindOf = (a: Record<string, unknown>): string => (typeof a.kind === "string" ? `a ${a.kind} answer` : "an unreadable answer");

/** The snapshot a get answered, when it is exactly the one expected. */
function holds(answer: Record<string, unknown>, expected: GroupingSnapshot): boolean {
  if (answer.kind !== "grouping") return false;
  const read = readGroupingSnapshot(answer.snapshot, POOL_GROUPING_FORMAT);
  return read.kind === "snapshot" && JSON.stringify(read.snapshot) === JSON.stringify(expected);
}

/** One call to a directory within one call's deadline: its answer, or why there was none. */
async function askDirectory(deps: ConfirmLineProbeDeps, stub: DirectoryStub, message: Record<string, unknown>): Promise<Record<string, unknown> | string> {
  let why = "no answer within a call";
  const answer = await readWithinDeadline(() => stub.send(message), CONFIRM_LINE_CALL_MS, (err) => (why = shortErrorReason(err)), deps.timer);
  return answer ?? why;
}
const directoryUnreachable = (what: string, why: string): CheckResult => ({
  outcome: "directory-unreachable",
  detail: `The pool grouping directory did not answer ${what} (${why}), so the grouping it holds cannot reach any server`,
});

/**
 * #3460: the pool grouping directory, both halves. On the probe's OWN directory: a fresh
 * put is stored and handed back, and an older put is kept out, so newest wins is
 * measured in both directions (L1). Then the LIVE directory, read and never written:
 * it holds a grouping a cold server would install.
 */
async function checkDirectory(deps: ConfirmLineProbeDeps, run: string): Promise<CheckResult> {
  const verify = deps.directory(POOL_GROUPING_VERIFY_DIRECTORY);
  const live = deps.directory(POOL_GROUPING_DIRECTORY);
  const ask = (stub: DirectoryStub, message: Record<string, unknown>) => askDirectory(deps, stub, message);
  const unreachable = directoryUnreachable;
  const now = deps.now();
  const newer = groupingSnapshotOf([["verify", run]], now);
  const older = groupingSnapshotOf([["verify", `${run}:older`]], now - 1_000);

  const put = await ask(verify, groupingPutMessage(newer));
  if (typeof put === "string") return unreachable("a put", put);
  if (put.kind !== "stored") return { outcome: "not-stored", detail: `The verification directory answered a fresh put with ${kindOf(put)} rather than storing it` };
  const got = await ask(verify, groupingGetMessage());
  if (typeof got === "string") return unreachable("a get", got);
  if (!holds(got, newer)) return { outcome: "not-stored", detail: `The verification directory stored a fresh put and then handed back ${kindOf(got)} that is not it` };

  const stale = await ask(verify, groupingPutMessage(older));
  if (typeof stale === "string") return unreachable("a put", stale);
  const after = await ask(verify, groupingGetMessage());
  if (typeof after === "string") return unreachable("a get", after);
  if (stale.kind !== "kept" || !holds(after, newer)) {
    return {
      outcome: "older-won",
      detail: "An older put replaced the newer grouping on the verification directory, so a slow publisher could put a stale grouping back over a fresh one",
    };
  }

  const current = await ask(live, groupingGetMessage());
  if (typeof current === "string") return unreachable("a get of the live grouping", current);
  if (current.kind !== "grouping") return { outcome: "grouping-unusable", detail: `The live directory answered a get with ${kindOf(current)} rather than a grouping` };
  if (current.snapshot === null || current.snapshot === undefined) {
    return {
      outcome: "no-grouping",
      detail: "The live directory holds no pool grouping, so nothing has published one since it started",
    };
  }
  const read = readGroupingSnapshot(current.snapshot, POOL_GROUPING_FORMAT);
  if (read.kind === "format-mismatch") {
    return { outcome: "grouping-unusable", detail: `The live grouping is format ${read.format} and this build reads format ${POOL_GROUPING_FORMAT}, so a server reading it would refuse it` };
  }
  if (read.kind === "refused") return { outcome: "grouping-unusable", detail: `The live grouping is malformed (${read.why}), so a server reading it would refuse it` };
  const ageS = Math.round((deps.now() - read.snapshot.readAtMs) / 1000);
  if (deps.now() - read.snapshot.readAtMs > PROBE_GROUPING_MAX_AGE_MS) {
    return {
      outcome: "grouping-unusable",
      detail: `The live grouping was read ${ageS} seconds ago, past ${PROBE_GROUPING_MAX_AGE_MS / 1000} seconds, so its publisher has stopped and a server reading it would refuse it as stale`,
    };
  }
  return passed(
    `The pool grouping directory stored a put, kept the newest over an older one, and holds a live grouping of ${read.snapshot.count} codes read ${ageS} seconds ago`,
  );
}

/** Where a get said it answered from, or null when it did not say (a directory older than #3481). */
function answeredFrom(answer: Record<string, unknown>): GroupingAnsweredFrom | null {
  return answer.from === "storage" || answer.from === "memory" ? answer.from : null;
}

/**
 * #3481: does the directory still hand back its grouping once the platform has put it to
 * sleep? On the probe's OWN directory, never the live one: it puts a grouping of its own,
 * confirms it is held, then leaves the directory idle for a whole spell and reads it,
 * up to `PROBE_WAKE_READS` times. Only a read answered FROM STORAGE holding that grouping
 * passes, because a read answered from memory is an object that never slept and proves
 * nothing about storage (L98). A read after the wait that does not hold the grouping fails,
 * whichever it was answered from.
 *
 * Its grouping is minted newer than whatever the directory already holds, which the
 * directory says, so it is stored whatever the check before it (or yesterday's run) left
 * there, and two of the probe's own puts never tie on one clock reading.
 */
async function checkDirectoryWake(deps: ConfirmLineProbeDeps, run: string): Promise<CheckResult> {
  const verify = deps.directory(POOL_GROUPING_VERIFY_DIRECTORY);
  const ask = (message: Record<string, unknown>) => askDirectory(deps, verify, message);
  const spellS = PROBE_WAKE_IDLE_MS / 1000;

  const before = await ask(groupingGetMessage());
  if (typeof before === "string") return directoryUnreachable("a get", before);
  const held = before.kind === "grouping" ? readGroupingSnapshot(before.snapshot, null) : null;
  const floor = held?.kind === "snapshot" ? held.snapshot.readAtMs + 1 : 0;
  const mine = groupingSnapshotOf([["verify", `${run}:wake`]], Math.max(deps.now(), floor));

  const put = await ask(groupingPutMessage(mine));
  if (typeof put === "string") return directoryUnreachable("a put", put);
  if (put.kind !== "stored") return { outcome: "not-stored", detail: `The verification directory answered the wake check's put with ${kindOf(put)} rather than storing it, so there was nothing to leave idle` };
  const confirmed = await ask(groupingGetMessage());
  if (typeof confirmed === "string") return directoryUnreachable("a get", confirmed);
  if (!holds(confirmed, mine)) {
    return { outcome: "not-stored", detail: `The verification directory stored the wake check's put and then handed back ${kindOf(confirmed)} that is not it, before it was left idle at all` };
  }

  const unnamed: number[] = [];
  for (let read = 1; read <= PROBE_WAKE_READS; read++) {
    // Nothing touches the directory during the spell: this read is the first call since
    // the one before it, so the object's idle clock runs the whole spell.
    await deps.sleep(PROBE_WAKE_IDLE_MS);
    const got = await ask(groupingGetMessage());
    const idle = `${read} idle ${read === 1 ? "spell" : "spells"} of ${spellS} seconds`;
    if (typeof got === "string") return directoryUnreachable(`a get after ${idle}`, got);
    const from = answeredFrom(got);
    if (!holds(got, mine)) {
      const said =
        got.kind !== "grouping"
          ? `${kindOf(got)}${typeof got.why === "string" ? ` (${got.why})` : ""}`
          : got.snapshot === null || got.snapshot === undefined
            ? "no grouping at all"
            : "a grouping that is not the one it stored";
      const state = from === "storage" ? "had slept and read its storage" : from === "memory" ? "was still awake, answering from memory" : "did not say where it answered from";
      return {
        outcome: "lost-after-idle",
        detail: `After ${idle} the verification directory ${state}, and handed back ${said} rather than the grouping it stored, so a directory left idle between publishes serves no grouping`,
      };
    }
    if (from === "storage") {
      return passed(`Left idle for ${spellS} seconds, the verification directory slept, woke, and handed back the grouping it stored, read from its storage, on read ${read} of ${PROBE_WAKE_READS}`);
    }
    if (from === null) unnamed.push(read);
  }
  // Said apart (L11): an object that stayed awake is the platform keeping it in memory,
  // while one that names no source is a directory older than this probe.
  const how =
    unnamed.length === PROBE_WAKE_READS
      ? "without saying where it answered from, as a directory older than this probe does"
      : unnamed.length > 0
        ? `from memory, apart from read ${unnamed.join(" and ")}, which named no source`
        : "from memory, so the platform kept it awake";
  return {
    outcome: "wake-unobserved",
    detail: `Left idle ${PROBE_WAKE_READS} times for ${spellS} seconds each, the verification directory still held its grouping and answered every read ${how}. The probe never saw it wake, so whether a woken directory reads its storage back was not measured`,
  };
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
  const directory = await guarded(() => checkDirectory(deps, run));
  // Last, because it is the one that waits: the line checks and the live read are never
  // held behind its idle spells.
  const directoryWake = await guarded(() => checkDirectoryWake(deps, run));
  return { full, notFull, abandoned, nothingHeld, directory, directoryWake };
}

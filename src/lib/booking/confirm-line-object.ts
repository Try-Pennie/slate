/**
 * The confirm line, hosted in a shared object (#3325).
 *
 * The per isolate line (`confirm-queue.ts`, #3221 / #3257 / #3274) only coordinates
 * confirms that land on one isolate. On 2026-10-05 (load run 37333201026) a hundred
 * confirms for one slot spread across isolates, each formed its own line, about 52
 * leaders saturated the database together and nobody was booked. A Durable Object is
 * the one primitive here that every isolate reaches as the SAME instance, so the line
 * moves into one, and this module is everything that object does.
 *
 * It decides none of the line's rules: it hosts `makeConfirmQueue`, the same rules
 * every isolate runs, and speaks a small protocol around it. All the protocol adds is
 * what a network between the leader and its line makes necessary, each measured or
 * found by the plan's red team rather than imagined:
 *
 * - `enter` answers AT ONCE (lead, a ticket to wait on, or a lookahead place), so a
 *   caller can put a short deadline on it and tell an unreachable object from a long
 *   line. It is idempotent by the caller's attempt id, so a retried enter never takes
 *   a second place.
 * - A waiter holds a TICKET and polls for at most `CONFIRM_LINE_POLL_MS` at a time. A
 *   deploy leaves calls already held on the OLD instance until their own timeout while
 *   new calls reach the new one (measured on 2026-10-05: all 30 held calls ran out
 *   their 45s), so a short poll is what moves a follower onto the new instance within
 *   one poll, where its ticket is unknown and the answer is `gone`.
 * - A waiter that stops polling is dropped (nothing tells an object a request was
 *   cancelled), including one promoted to lead and never collected.
 * - A lead must be acknowledged within `CONFIRM_LINE_ACK_MS` and renewed within
 *   `CONFIRM_LINE_LEASE_MS`, by every leader call and a heartbeat, so a lead whose
 *   answer was lost or whose caller died frees the line while the followers behind it
 *   still have time to be served. In one isolate a 14s lease was enough, because a
 *   leader that dies takes the whole invocation with it; across a network it is not.
 * - `abandon` lets a caller that gave up on an enter undo whatever it was given.
 *
 * A line's state is memory only. A line writes nothing to storage, so no input gate
 * ever closes on its instance and held polls interleave at every await, and a restart
 * loses nothing but lines in flight, whose confirms re-enter (`gone`) or fall back to
 * their isolate. Correctness
 * never rests on this object: the bookings indexes and verify on book still decide.
 *
 * A settlement (the leader's booking and who sits at the instant) carries contact
 * data; it lives only in memory for the moment it is handed to the followers, is
 * serialised ONCE however many are waiting, and is never logged.
 *
 * #3460: one reserved instance of the class is not a line at all but the pool grouping
 * DIRECTORY (`pool-grouping.ts`), which holds the newest grouping the recompute lane
 * published so a cold server can key its line from it, in the instance's STORAGE as
 * well as its memory (#3479): the platform hibernates an idle object after ten seconds
 * and discards its memory, and the lane publishes once a minute. Which role a call is
 * served as is `objectRoleOf`, and `makeConfirmLineObject` keeps each role's messages to
 * its own instances.
 */
import { makeConfirmQueue, type LeaderVerdict, type QueueTurn, type EnteredNow } from "./confirm-queue.ts";
import { DIRECTORY_GROUP_PREFIX, isGroupingMessage, makeGroupingDirectoryHost, type GroupingDirectoryStorage } from "./pool-grouping.ts";
import type { ScheduleTimer } from "../read-within-deadline.ts";

/** The Worker binding the shared line is reached through, and the class behind it. */
export const CONFIRM_LINE_BINDING = "CONFIRM_LINE";
export const CONFIRM_LINE_CLASS = "ConfirmLine";

/** Raised whenever the messages change shape; a mismatch answers `gone`. */
export const CONFIRM_LINE_PROTOCOL = 1;
/** The longest one poll is held. A deploy strands a follower for at most this. */
export const CONFIRM_LINE_POLL_MS = 1_500;
/** How late a follower's next poll may be before it is taken to have gone. */
export const CONFIRM_LINE_POLL_GRACE_MS = 1_000;
/** How long a new lead has to acknowledge it was received. */
export const CONFIRM_LINE_ACK_MS = 1_000;
/** How long a lead lasts without a call or a heartbeat. */
export const CONFIRM_LINE_LEASE_MS = 4_000;
/** How often a leader's client renews its lease while it works. */
export const CONFIRM_LINE_HEARTBEAT_MS = 1_500;
/** How long an attempt's answer is remembered, for a retried enter or an abandon. */
export const CONFIRM_LINE_ATTEMPT_TTL_MS = 30_000;

/** The tag and message a traced call is logged on, which the load run's reader matches (#3354). */
export const CONFIRM_LINE_TRACE_TAG = "confirm-line-object";
export const TRACED_CALL_MSG = "line call";

/** The two stages the client stamps a traced call with (#3354). */
export const TRACED_STAGES = ["wait", "turn"] as const;
/**
 * One traced call as the object reports it: the op, the confirm's trace, and whether
 * the client sent it while the confirm waited for its turn or during the turn. A stage
 * the client never sends is `unknown`, never one of the two (L11).
 */
export interface TracedCall {
  op: string;
  trace: string;
  stage: (typeof TRACED_STAGES)[number] | "unknown";
}

type Answer = Record<string, unknown>;
type LeadTurn = Extract<QueueTurn<unknown>, { kind: "lead" }>;

interface Ticket {
  /** The enter attempt that made it, so a lead its poll hands out stays abandonable (#3351). */
  attempt: string;
  wait: Extract<EnteredNow<unknown>, { kind: "wait" }>;
  result: QueueTurn<unknown> | null;
  lastSeenAt: number;
  polling: number;
}

type AttemptRef = { kind: "lead"; turn: string } | { kind: "wait"; ticket: string } | { kind: "lookahead"; permit: string };

const isString = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 200;
const isStringList = (x: unknown): x is string[] => Array.isArray(x) && x.length <= 500 && x.every(isString);

/** A leader's verdict as it arrives over the wire, or null when it is not one. */
function readVerdict(x: unknown): LeaderVerdict<unknown> | null {
  if (!x || typeof x !== "object") return null;
  const v = x as { full?: unknown; refusal?: unknown; settled?: unknown };
  if (v.full === false) return { full: false };
  if (v.full === true && (v.refusal === "race" || v.refusal === "taken")) {
    return { full: true, refusal: v.refusal, settled: v.settled ?? null };
  }
  return null;
}

export function makeConfirmLineHost(deps: {
  now: () => number;
  /** Poll holds and the sweep. */
  timer: ScheduleTimer;
  /** The lines' leases. */
  leaseTimer: ScheduleTimer;
  newId: () => string;
  /**
   * #3354: told of each call that carries a trace, so a load run can join the
   * object's side of a confirm to the confirm's own line. Only the load test's client
   * sends a trace, so production calls report nothing. The time a call spent here is
   * the runtime's own `wallTime` on the same event, so none is measured twice.
   */
  onTrace?: (call: TracedCall) => void;
}): { handle(message: unknown): Promise<string> } {
  const { now, timer, newId } = deps;
  const line = makeConfirmQueue<unknown>({
    timer,
    leaseTimer: deps.leaseTimer,
    now,
    ackMs: CONFIRM_LINE_ACK_MS,
    leaseMs: CONFIRM_LINE_LEASE_MS,
    lookaheadLeaseMs: CONFIRM_LINE_LEASE_MS,
  });
  const turns = new Map<string, LeadTurn>();
  const tickets = new Map<string, Ticket>();
  const permits = new Map<string, () => void>();
  const attempts = new Map<string, { answer: string; ref: AttemptRef; at: number }>();
  // One serialisation per settlement, however many followers it answers.
  const settledJson = new WeakMap<object, string>();

  const json = (a: Answer) => JSON.stringify(a);
  const gone = (why?: string) => json(why ? { kind: "gone", why } : { kind: "gone" });
  const bad = (why: string) => json({ kind: "bad", why });

  const registerLead = (turn: LeadTurn): string => {
    const id = newId();
    turns.set(id, turn);
    return id;
  };

  /**
   * What a settled ticket answers its poll when it did not lead, serialising a
   * settlement once. A lead is answered by `poll` itself, which also points the attempt
   * at the turn (#3351).
   */
  const answerFor = (result: Exclude<QueueTurn<unknown>, { kind: "lead" }>): string => {
    if (result.kind === "unqueued") return json({ kind: "unqueued" });
    const s = result.settled;
    if (s === null || typeof s !== "object") return json({ kind: "refused", refusal: result.refusal, settled: s ?? null });
    let body = settledJson.get(s);
    if (body === undefined) {
      body = JSON.stringify(s);
      settledJson.set(s, body);
    }
    return `{"kind":"refused","refusal":${JSON.stringify(result.refusal)},"settled":${body}}`;
  };

  // Drop every waiter whose caller stopped polling, and forget old attempts. A
  // dropped waiter that had been promoted to lead ends that lead (`cancel`), so the
  // line is handed on rather than held by nobody.
  const sweep = () => {
    const t = now();
    for (const [id, ticket] of tickets) {
      if (ticket.polling > 0) continue;
      if (t - ticket.lastSeenAt < CONFIRM_LINE_POLL_MS + CONFIRM_LINE_POLL_GRACE_MS) continue;
      tickets.delete(id);
      ticket.wait.cancel();
    }
    for (const [id, turn] of turns) if (!turn.alive()) turns.delete(id);
    for (const [id, a] of attempts) if (t - a.at > CONFIRM_LINE_ATTEMPT_TTL_MS) attempts.delete(id);
    if (tickets.size > 0) armSweep();
  };
  let sweepArmed = false;
  const armSweep = () => {
    if (sweepArmed) return;
    sweepArmed = true;
    timer(CONFIRM_LINE_POLL_MS, () => {
      sweepArmed = false;
      sweep();
    });
  };

  const enter = (m: Record<string, unknown>): string => {
    const { attempt, line: key, waitMs, wantLookahead } = m;
    if (!isString(attempt) || !isString(key) || typeof waitMs !== "number" || !(waitMs >= 0)) return bad("enter needs attempt, line and waitMs");
    const seen = attempts.get(attempt);
    if (seen) return seen.answer;
    if (wantLookahead === true) {
      const giveBack = line.lookahead(key);
      if (giveBack) {
        const permit = newId();
        permits.set(permit, giveBack);
        const answer = json({ kind: "lookahead", permit });
        attempts.set(attempt, { answer, ref: { kind: "lookahead", permit }, at: now() });
        return answer;
      }
    }
    const entered = line.enterNow(key, waitMs);
    if (entered.kind === "lead") {
      const turn = registerLead(entered.turn);
      const answer = json({ kind: "lead", turn });
      attempts.set(attempt, { answer, ref: { kind: "lead", turn }, at: now() });
      return answer;
    }
    const id = newId();
    const ticket: Ticket = { attempt, wait: entered, result: null, lastSeenAt: now(), polling: 0 };
    tickets.set(id, ticket);
    void entered.turn.then((r) => {
      ticket.result = r;
    });
    armSweep();
    const answer = json({ kind: "wait", ticket: id });
    attempts.set(attempt, { answer, ref: { kind: "wait", ticket: id }, at: now() });
    return answer;
  };

  const poll = async (m: Record<string, unknown>): Promise<string> => {
    if (!isString(m.ticket)) return bad("poll needs a ticket");
    const id = m.ticket;
    const ticket = tickets.get(id);
    if (!ticket) return gone();
    ticket.lastSeenAt = now();
    if (!ticket.result) {
      ticket.polling++;
      let cancelHold: () => void = () => {};
      const held = new Promise<void>((r) => (cancelHold = timer(CONFIRM_LINE_POLL_MS, r)));
      await Promise.race([ticket.wait.turn.then(() => undefined), held]);
      cancelHold();
      ticket.polling--;
      ticket.lastSeenAt = now();
      // Let the `then` above record the result before it is read.
      await Promise.resolve();
    }
    if (!tickets.has(id)) return gone(); // dropped meanwhile
    if (!ticket.result) return json({ kind: "pending" });
    tickets.delete(id);
    if (ticket.result.kind === "lead") {
      // #3351: the attempt now leads to the turn rather than the ticket just deleted, so
      // a caller whose answer was lost on the way back can still abandon what it was
      // given, and the line is handed on at once rather than after the ack window.
      const turn = registerLead(ticket.result);
      const a = attempts.get(ticket.attempt);
      if (a) a.ref = { kind: "lead", turn };
      return json({ kind: "lead", turn });
    }
    return answerFor(ticket.result);
  };

  /** Every call from a leader renews its lease first; an ended turn is gone. */
  const leader = (m: Record<string, unknown>): LeadTurn | null => {
    if (!isString(m.turn)) return null;
    const turn = turns.get(m.turn);
    if (!turn) return null;
    turn.renew();
    if (!turn.alive()) {
      turns.delete(m.turn);
      return null;
    }
    return turn;
  };

  const handle = async (message: unknown): Promise<string> => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return bad("not a message");
    const m = message as Record<string, unknown>;
    // Before the version check, so a call refused for its version is still seen.
    if (deps.onTrace && isString(m.trace) && isString(m.op)) {
      const stage = (TRACED_STAGES as readonly unknown[]).includes(m.stage) ? (m.stage as TracedCall["stage"]) : "unknown";
      deps.onTrace({ op: m.op, trace: m.trace, stage });
    }
    if (m.v !== CONFIRM_LINE_PROTOCOL) return gone("version");
    sweep();
    switch (m.op) {
      case "enter":
        return enter(m);
      case "poll":
        return poll(m);
      case "ack":
      case "renew": {
        if (!isString(m.turn)) return bad(`${m.op} needs a turn`);
        const turn = turns.get(m.turn);
        if (!turn) return gone();
        turn.ack();
        if (!turn.alive()) {
          turns.delete(m.turn);
          return gone();
        }
        return json({ ok: true });
      }
      case "claimedByOthers": {
        if (!isString(m.turn)) return bad("claimedByOthers needs a turn");
        const turn = leader(m);
        return turn ? json({ ok: true, ids: [...turn.seat.claimedByOthers()] }) : gone();
      }
      case "claim": {
        if (!isString(m.turn) || !isString(m.userId) || typeof m.othersRemain !== "boolean") return bad("claim needs turn, userId and othersRemain");
        const turn = leader(m);
        if (!turn) return gone();
        turn.seat.claim(m.userId, m.othersRemain);
        return json({ ok: true });
      }
      case "claimFirst": {
        if (!isString(m.turn) || !isStringList(m.candidates)) return bad("claimFirst needs turn and candidates");
        const turn = leader(m);
        return turn ? json({ ok: true, ...turn.seat.claimFirst(m.candidates) }) : gone();
      }
      case "claimBeside": {
        if (!isString(m.turn) || !isString(m.userId) || !isStringList(m.besides)) return bad("claimBeside needs turn, userId and besides");
        const turn = leader(m);
        if (!turn) return gone();
        turn.seat.claimBeside(m.userId, m.besides);
        return json({ ok: true });
      }
      case "pass": {
        if (!isString(m.turn)) return bad("pass needs a turn");
        const turn = leader(m);
        if (!turn) return gone();
        turn.seat.pass();
        return json({ ok: true });
      }
      case "waiting": {
        if (!isString(m.turn)) return bad("waiting needs a turn");
        const turn = leader(m);
        return turn ? json({ ok: true, n: turn.waiting() }) : gone();
      }
      case "done": {
        if (!isString(m.turn)) return bad("done needs a turn");
        const verdict = readVerdict(m.verdict);
        if (!verdict) return bad("done needs a verdict");
        const turn = turns.get(m.turn);
        // Already over (reported, expired, or issued by an instance a deploy replaced):
        // the report is accepted, because there is nothing left for it to settle.
        if (!turn) return json({ ok: true, gone: true });
        turns.delete(m.turn);
        turn.done(verdict);
        return json({ ok: true });
      }
      case "giveBack": {
        if (!isString(m.permit)) return bad("giveBack needs a permit");
        permits.get(m.permit)?.();
        permits.delete(m.permit);
        return json({ ok: true });
      }
      case "abandon": {
        if (!isString(m.attempt)) return bad("abandon needs an attempt");
        const a = attempts.get(m.attempt);
        if (a) {
          if (a.ref.kind === "lead") {
            const turn = turns.get(a.ref.turn);
            turns.delete(a.ref.turn);
            turn?.done({ full: false });
          } else if (a.ref.kind === "wait") {
            const ticket = tickets.get(a.ref.ticket);
            tickets.delete(a.ref.ticket);
            ticket?.wait.cancel();
          } else {
            permits.get(a.ref.permit)?.();
            permits.delete(a.ref.permit);
          }
        }
        return json({ ok: true });
      }
      default:
        return bad("unknown op");
    }
  };

  return { handle };
}

/**
 * Every instance of the class is named `confirm-line:v1:<group>` by the client's one
 * naming function (`confirmLineObjectName`), a line's group and the directory's alike.
 */
export const CONFIRM_LINE_OBJECT_PREFIX = "confirm-line:v1:";
/** The path a line's client posts to. The bare `/` an older client sends is a line too. */
export const CONFIRM_LINE_PATH = "/line";
/** The path the pool grouping directory's client posts to (#3460). */
export const GROUPING_DIRECTORY_PATH = "/directory";

export type ObjectRole = "line" | "directory";

/**
 * Which role one call is served as (#3460): a confirm LINE, or the pool grouping
 * DIRECTORY, a reserved instance of the same class (no new class, binding or migration).
 *
 * The role travels in the URL, which only the client's two constructors build
 * (`durableLineNamespace` and `durableGroupingDirectory`). The instance's own name is
 * platform behaviour this repo cannot measure offline (L82): a runtime may or may not
 * expose `ctx.id.name` inside an object. So when it does and the name is one of ours,
 * it must AGREE with the path, which is what refuses a directory message on the
 * monitor's instance or a real line's; when it is absent, unreadable or not ours, the
 * path alone decides, and neither answer can break the line.
 */
export function objectRoleOf(pathname: string, instanceName: unknown): { role: ObjectRole } | { refused: string } {
  const byPath: ObjectRole | null =
    pathname === GROUPING_DIRECTORY_PATH ? "directory" : pathname === CONFIRM_LINE_PATH || pathname === "/" ? "line" : null;
  if (byPath === null) return { refused: `no role is served on ${pathname.slice(0, 40)}` };
  if (typeof instanceName === "string" && instanceName.startsWith(CONFIRM_LINE_OBJECT_PREFIX)) {
    const byName: ObjectRole = instanceName.slice(CONFIRM_LINE_OBJECT_PREFIX.length).startsWith(DIRECTORY_GROUP_PREFIX) ? "directory" : "line";
    if (byName !== byPath) return { refused: `a ${byPath} call on a ${byName} instance` };
  }
  return { role: byPath };
}

/**
 * Everything one instance of the class does: a line, or the directory, by the role
 * each call is served as. Directory messages are honoured ONLY on the directory, and
 * line messages are refused there, so neither can reach the other's state by a
 * misaddressed call. Each half is created on first use, so a line never holds a
 * directory and the directory never holds a line.
 */
export function makeConfirmLineObject(
  deps: Parameters<typeof makeConfirmLineHost>[0] & {
    /**
     * The instance's own storage (`ctx.storage`), where the directory keeps its snapshot
     * through a hibernation (#3479). Required, so every place an object is built says
     * where its directory persists rather than quietly keeping it in memory alone.
     */
    directoryStorage: GroupingDirectoryStorage;
  },
): {
  handle(role: ObjectRole | { refused: string }, message: unknown): Promise<string>;
} {
  let line: ReturnType<typeof makeConfirmLineHost> | null = null;
  let directory: ReturnType<typeof makeGroupingDirectoryHost> | null = null;
  const bad = (why: string) => JSON.stringify({ kind: "bad", why });
  return {
    async handle(role, message) {
      if (typeof role !== "string") return bad(role.refused);
      if (role === "directory") {
        if (!isGroupingMessage(message)) return bad("a confirm line message on the pool grouping directory");
        directory ??= makeGroupingDirectoryHost(deps.directoryStorage);
        return directory.handle(message);
      }
      if (isGroupingMessage(message)) return bad("a pool grouping message on a confirm line");
      line ??= makeConfirmLineHost(deps);
      return line.handle(message);
    },
  };
}

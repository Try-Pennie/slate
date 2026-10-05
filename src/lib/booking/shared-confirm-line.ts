/**
 * The confirm path's client for the confirm line shared across isolates (#3325).
 *
 * It implements the same `ConfirmLine` the per isolate line does, so the confirm path
 * cannot tell them apart, and it falls back to the per isolate line whenever the
 * shared one cannot be used. Correctness never depends on which line served: the
 * bookings indexes and verify on book decide. What the shared line buys is capacity,
 * so a crowd for one slot gets one booking and fast "taken" answers instead of
 * fifty leaders saturating the database together (load run 37333201026).
 *
 * What each failure leaves behind is the whole design, so each is named:
 *
 * - The switch is off, or could not be read and the deployment default is off: the
 *   isolate's own line, exactly as before (`isolate`, `off` / `unread-default`).
 * - No binding: the isolate's line, and a reach failure is reported, because a switch
 *   that is on cannot be honoured (`fallback`, `unbound`).
 * - `enter` refused, or not answered within `CONFIRM_LINE_REACH_MS`: the isolate's
 *   line, a reach failure reported, and the attempt ABANDONED, because the object may
 *   have acted on it and would otherwise hold a lead nobody has (`fallback`,
 *   `reach-timeout` / `enter-error`).
 * - A poll answers `gone` (a deploy replaced the instance, measured on 2026-10-05 to
 *   leave held calls on the old one): the follower re-enters the SHARED line, on the
 *   new instance, rather than falling back (`shared`, `gone`).
 * - A leader's call fails mid turn: it carries on, since the insert decides; claims
 *   answer locally (no exclusion), and the object's short lease frees the line in time
 *   for the followers behind it.
 *
 * Every call has a deadline, through the shared `readWithinDeadline` (L110).
 */
import { isolateKeyOf, type ConfirmLine, type LeaderVerdict, type LineKey, type LineTurn } from "./confirm-queue.ts";
import { CONFIRM_LINE_PROTOCOL, CONFIRM_LINE_HEARTBEAT_MS, CONFIRM_LINE_POLL_MS } from "./confirm-line-object.ts";
import { readWithinDeadline, type ScheduleTimer } from "../read-within-deadline.ts";

/**
 * How long `enter` may take before the object is treated as unreachable. A new
 * object answered its first call in 452ms at worst cross country and an existing one
 * in under 105ms (measured, #3325), so this tells "unreachable" from "slow" with room
 * to spare, and it is the most a fallback can add to a confirm.
 */
export const CONFIRM_LINE_REACH_MS = 1_500;
/** Every other call but a poll. */
export const CONFIRM_LINE_CALL_MS = 1_000;
/** A poll is held by the object for up to `CONFIRM_LINE_POLL_MS`; this is the margin past it. */
export const CONFIRM_LINE_POLL_MARGIN_MS = 1_000;
/** How many times a follower re-enters after a deploy before it falls back. */
export const CONFIRM_LINE_GONE_RETRIES = 2;

export type LineMode = "shared" | "isolate" | "fallback";
export type LineReason = "ok" | "off" | "unread-default" | "unbound" | "reach-timeout" | "enter-error" | "gone" | "abandoned";
export type LineKeyKind = "ladder" | "code" | "link" | "none";

/** How one confirm's turn was served, for the `confirm answered` line and the load run. */
export interface LineServed {
  line: LineMode;
  reason: LineReason;
  key: LineKeyKind;
  /**
   * Milliseconds the confirm spent in calls to the shared line other than waiting
   * in it (enter, acknowledge, claims, report): what the line ADDS to a confirm.
   */
  lineMs: number;
}

export interface SwitchReading {
  on: boolean;
  source: "read" | "last-known" | "default";
}

/** One object, as the client talks to it: a JSON message in, a JSON answer out. */
export interface LineStub {
  send(message: Record<string, unknown>): Promise<Record<string, unknown>>;
}
/** The binding, as the client uses it: one stub per line group. */
export interface LineNamespace {
  stubFor(group: string): LineStub;
}

export function keyKindOf(group: string): LineKeyKind {
  const prefix = group.slice(0, group.indexOf(":"));
  return prefix === "ladder" || prefix === "code" || prefix === "link" ? prefix : "none";
}

type Answer = Record<string, unknown>;
type Stashed = { kind: "answer"; stub: LineStub; attempt: string; answer: Answer; spentMs: number } | { kind: "fallback"; reason: LineReason };

export function makeSharedConfirmLine<T>(deps: {
  namespace: LineNamespace | null;
  fallback: ConfirmLine<T>;
  enabled: () => Promise<SwitchReading>;
  /** Called with how the turn was served, and again with the final `lineMs`. */
  record: (served: LineServed) => void;
  /** A use of the shared line that failed for a reason a deploy does not explain. */
  onReachFailure: (reason: LineReason, err: unknown) => void;
  now: () => number;
  timer: ScheduleTimer;
  newId: () => string;
}): ConfirmLine<T> {
  const { now, timer } = deps;
  // A lead or a ticket found while looking ahead, kept for the `enter` that follows
  // it in the same confirm, so an idle line costs one call rather than two.
  const stash = new Map<string, Stashed>();

  /** One call under a deadline: the answer, or null with the reason it failed. */
  const call = async (stub: LineStub, message: Answer, ms: number): Promise<{ answer: Answer | null; err: unknown; ms: number }> => {
    let err: unknown = null;
    const t0 = now();
    const answer = await readWithinDeadline(() => stub.send({ v: CONFIRM_LINE_PROTOCOL, ...message }), ms, (e) => (err = e), timer);
    return { answer, err, ms: now() - t0 };
  };
  const timedOut = (err: unknown) => err instanceof Error && /no answer within/.test(err.message);

  /** Best effort: undo whatever the object gave an attempt its caller gave up on. */
  const abandon = async (stub: LineStub, attempt: string) => {
    await call(stub, { op: "abandon", attempt }, CONFIRM_LINE_CALL_MS);
  };

  const fallBack = async (key: LineKey, waitMs: number | undefined, served: LineServed, err: unknown): Promise<LineTurn<T>> => {
    deps.onReachFailure(served.reason, err);
    deps.record(served);
    return deps.fallback.enter(key, waitMs);
  };

  /** A lead on the shared line: acknowledged at once, renewed while it works. */
  const leadOn = async (stub: LineStub, turn: string, served: LineServed): Promise<LineTurn<T>> => {
    let detached = false;
    let stopped = false;
    let lastClaims: ReadonlySet<string> = new Set();
    const timed = async (message: Answer) => {
      const r = await call(stub, { ...message, turn }, CONFIRM_LINE_CALL_MS);
      served.lineMs += r.ms;
      if (r.answer?.kind === "gone") detached = true;
      return r.answer && r.answer.ok === true ? r.answer : null;
    };
    await timed({ op: "ack" });
    // The heartbeat: a renewal every `CONFIRM_LINE_HEARTBEAT_MS` until the turn
    // reports. It runs beside the confirm, so its calls are not counted in `lineMs`.
    let beating: Promise<unknown> = Promise.resolve();
    let cancelBeat: () => void = () => {};
    const beat = () => {
      cancelBeat = timer(CONFIRM_LINE_HEARTBEAT_MS, () => {
        if (stopped || detached) return;
        beating = call(stub, { op: "renew", turn }, CONFIRM_LINE_CALL_MS).then((r) => {
          if (r.answer?.kind === "gone") detached = true;
          if (!stopped && !detached) beat();
        });
      });
    };
    beat();
    deps.record({ ...served });
    return {
      kind: "lead",
      // The shared line never asks how many wait: a full verdict always reads who is
      // seated (one read, only on the rare full verdict), so nobody arriving between
      // this answer and the report can miss it, and a call is saved on every confirm.
      waiting: async () => 1,
      seat: {
        async claimedByOthers() {
          if (detached) return new Set<string>();
          const a = await timed({ op: "claimedByOthers" });
          if (a && Array.isArray(a.ids)) lastClaims = new Set(a.ids.filter((x): x is string => typeof x === "string"));
          return lastClaims;
        },
        async claim(userId, othersRemain) {
          if (!detached) await timed({ op: "claim", userId, othersRemain });
        },
        async claimFirst(candidates) {
          const local = { pool: [...candidates], unclaimed: candidates.length };
          if (detached) return local;
          const a = await timed({ op: "claimFirst", candidates: [...candidates] });
          if (!a || !Array.isArray(a.pool) || typeof a.unclaimed !== "number") return local;
          return { pool: a.pool.filter((x): x is string => typeof x === "string"), unclaimed: a.unclaimed };
        },
        async claimBeside(userId, besides) {
          if (!detached) await timed({ op: "claimBeside", userId, besides: [...besides] });
        },
        async pass() {
          if (!detached) await timed({ op: "pass" });
        },
      },
      async done(verdict: LeaderVerdict<T>) {
        stopped = true;
        cancelBeat();
        await beating;
        if (!detached) {
          // One retry inside the reserve: an unreported full verdict leaves the
          // followers to find out for themselves, and an unreported turn holds the
          // line until its short lease runs out.
          const first = await call(stub, { op: "done", turn, verdict }, CONFIRM_LINE_CALL_MS);
          served.lineMs += first.ms;
          if (!first.answer) {
            const second = await call(stub, { op: "done", turn, verdict }, CONFIRM_LINE_CALL_MS);
            served.lineMs += second.ms;
          }
        }
        deps.record({ ...served });
      },
    };
  };

  /** Wait on a ticket, polling, until the line answers or the wait runs out. */
  const follow = async (
    key: LineKey,
    stub: LineStub,
    ticket: string,
    deadline: number,
    served: LineServed,
    goneLeft: number,
  ): Promise<LineTurn<T>> => {
    let failures = 0;
    while (now() < deadline) {
      const r = await call(stub, { op: "poll", ticket }, CONFIRM_LINE_POLL_MS + CONFIRM_LINE_POLL_MARGIN_MS);
      const a = r.answer;
      if (!a) {
        failures++;
        if (failures < 2) continue;
        // The object stopped answering mid wait: what is left of the wait goes to the
        // isolate's own line. The object drops the abandoned ticket when it stops being polled.
        return fallBack(key, Math.max(0, deadline - now()), { ...served, line: "fallback", reason: timedOut(r.err) ? "reach-timeout" : "enter-error" }, r.err);
      }
      failures = 0;
      if (a.kind === "pending") continue;
      if (a.kind === "lead" && typeof a.turn === "string") return leadOn(stub, a.turn, served);
      if (a.kind === "refused" && (a.refusal === "race" || a.refusal === "taken")) {
        deps.record({ ...served });
        return { kind: "refused", refusal: a.refusal, settled: (a.settled ?? null) as T | null };
      }
      if (a.kind === "unqueued") {
        deps.record({ ...served });
        return { kind: "unqueued" };
      }
      if (a.kind === "gone" && goneLeft > 0) {
        return enterShared(key, Math.max(0, deadline - now()), { ...served, reason: "gone" }, goneLeft - 1, null);
      }
      return fallBack(key, Math.max(0, deadline - now()), { ...served, line: "fallback", reason: "gone" }, new Error(`the shared line answered ${JSON.stringify(a).slice(0, 80)}`));
    }
    deps.record({ ...served });
    return { kind: "unqueued" };
  };

  /** Act on the object's answer to an enter. */
  const onEntered = async (key: LineKey, stub: LineStub, answer: Answer, waitMs: number, served: LineServed, goneLeft: number): Promise<LineTurn<T>> => {
    if (answer.kind === "lead" && typeof answer.turn === "string") return leadOn(stub, answer.turn, served);
    if (answer.kind === "wait" && typeof answer.ticket === "string") return follow(key, stub, answer.ticket, now() + waitMs, served, goneLeft);
    if (answer.kind === "gone" && goneLeft > 0) return enterShared(key, waitMs, { ...served, reason: "gone" }, goneLeft - 1, null);
    return fallBack(key, waitMs, { ...served, line: "fallback", reason: "enter-error" }, new Error(`the shared line answered ${JSON.stringify(answer).slice(0, 80)}`));
  };

  const enterShared = async (key: LineKey, waitMs: number, served: LineServed, goneLeft: number, stashed: Stashed | null): Promise<LineTurn<T>> => {
    if (stashed?.kind === "fallback") return fallBack(key, waitMs, { ...served, line: "fallback", reason: stashed.reason }, null);
    if (stashed?.kind === "answer") {
      served.lineMs += stashed.spentMs;
      return onEntered(key, stashed.stub, stashed.answer, waitMs, served, goneLeft);
    }
    const stub = deps.namespace!.stubFor(key.group);
    const attempt = deps.newId();
    const r = await call(stub, { op: "enter", attempt, line: key.instant, waitMs }, CONFIRM_LINE_REACH_MS);
    served.lineMs += r.ms;
    if (!r.answer) {
      await abandon(stub, attempt);
      return fallBack(key, Math.max(0, waitMs - r.ms), { ...served, line: "fallback", reason: timedOut(r.err) ? "reach-timeout" : "enter-error" }, r.err);
    }
    return onEntered(key, stub, r.answer, Math.max(0, waitMs - r.ms), served, goneLeft);
  };

  /** Which line this confirm uses, before any call to the object. */
  const decide = async (key: LineKey): Promise<{ use: "shared" } | { use: "isolate" | "fallback"; reason: LineReason }> => {
    const sw = await deps.enabled();
    if (!sw.on) return { use: "isolate", reason: sw.source === "default" ? "unread-default" : "off" };
    if (!deps.namespace) return { use: "fallback", reason: "unbound" };
    void key;
    return { use: "shared" };
  };

  return {
    async enter(key, waitMs) {
      const served: LineServed = { line: "shared", reason: "ok", key: keyKindOf(key.group), lineMs: 0 };
      const stashed = stash.get(isolateKeyOf(key)) ?? null;
      stash.delete(isolateKeyOf(key));
      const how = await decide(key);
      if (how.use !== "shared") {
        if (how.use === "fallback") return fallBack(key, waitMs, { ...served, line: "fallback", reason: how.reason }, null);
        deps.record({ ...served, line: "isolate", reason: how.reason });
        return deps.fallback.enter(key, waitMs);
      }
      return enterShared(key, waitMs ?? 0, served, CONFIRM_LINE_GONE_RETRIES, stashed);
    },
    async lookahead(key, waitMs) {
      const how = await decide(key);
      if (how.use !== "shared") return deps.fallback.lookahead(key, waitMs);
      const stub = deps.namespace!.stubFor(key.group);
      const attempt = deps.newId();
      const r = await call(stub, { op: "enter", attempt, line: key.instant, waitMs: waitMs ?? 0, wantLookahead: true }, CONFIRM_LINE_REACH_MS);
      if (!r.answer) {
        await abandon(stub, attempt);
        stash.set(isolateKeyOf(key), { kind: "fallback", reason: timedOut(r.err) ? "reach-timeout" : "enter-error" });
        return null;
      }
      if (r.answer.kind === "lookahead" && typeof r.answer.permit === "string") {
        const permit = r.answer.permit;
        return async () => {
          await call(stub, { op: "giveBack", permit }, CONFIRM_LINE_CALL_MS);
        };
      }
      // Idle (a lead) or busy past the lookahead bound (a ticket): the enter that
      // follows uses this answer rather than asking again.
      stash.set(isolateKeyOf(key), { kind: "answer", stub, attempt, answer: r.answer, spentMs: r.ms });
      return null;
    },
  };
}

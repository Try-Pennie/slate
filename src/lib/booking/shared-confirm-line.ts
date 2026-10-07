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
 * - An answer the client has no meaning for (a `bad`, an unknown kind, a shape that
 *   does not read): the isolate's line, a reach failure reported, and the attempt
 *   abandoned. It is a protocol fault, never folded into `gone`, which is the one
 *   reason that never pages (`fallback`, `bad-answer`, #3351).
 * - Polls stop being answered mid wait: the isolate's line, and the attempt abandoned,
 *   because its ticket may have been promoted to lead meanwhile, and a lead nobody
 *   collects holds the line for the ack window (#3351).
 * - The confirm ends before the `enter` a lookahead kept an answer for: `release`
 *   abandons it, for the same reason (#3351).
 * - A leader's call fails mid turn: it carries on, since the insert decides; claims
 *   answer locally (no exclusion), and the object's short lease frees the line in time
 *   for the followers behind it.
 *
 * Every call has a deadline, through the shared `readWithinDeadline` (L110).
 */
import { isolateKeyOf, type ConfirmLine, type LeaderVerdict, type LineKey, type LineTurn } from "./confirm-queue.ts";
import { CONFIRM_LINE_PROTOCOL, CONFIRM_LINE_HEARTBEAT_MS, CONFIRM_LINE_POLL_MS } from "./confirm-line-object.ts";
import { readWithinDeadline, type ScheduleTimer } from "../read-within-deadline.ts";
import type { SwitchReading } from "../cached-switch.ts";

export type { SwitchReading };

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
export type LineReason =
  | "ok"
  | "off"
  | "unread-default"
  | "unbound"
  | "reach-timeout"
  | "enter-error"
  | "gone"
  | "bad-answer"
  | "abandoned";
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
  /**
   * #3354: this confirm's trace, set by the load test only. Every call then carries it
   * and the stage it was sent in, so the run can join the object's side of the
   * confirm to the confirm's own line. Null sends neither, which is every production
   * confirm.
   */
  trace?: string | null;
}): ConfirmLine<T> {
  const { now, timer } = deps;
  // Whether a call is sent while this confirm waits for its turn or during it. The
  // turn begins when `enter` hands one back; one client serves one confirm.
  let stage: "wait" | "turn" = "wait";
  const traced = (): Answer => (deps.trace ? { trace: deps.trace, stage } : {});
  // A lead or a ticket found while looking ahead, kept for the `enter` that follows
  // it in the same confirm, so an idle line costs one call rather than two.
  const stash = new Map<string, Stashed>();

  /** One call under a deadline: the answer, or null with the reason it failed. */
  const call = async (stub: LineStub, message: Answer, ms: number): Promise<{ answer: Answer | null; err: unknown; ms: number }> => {
    let err: unknown = null;
    const t0 = now();
    const answer = await readWithinDeadline(() => stub.send({ v: CONFIRM_LINE_PROTOCOL, ...message, ...traced() }), ms, (e) => (err = e), timer);
    return { answer, err, ms: now() - t0 };
  };
  const timedOut = (err: unknown) => err instanceof Error && /no answer within/.test(err.message);

  /** Best effort: undo whatever the object gave an attempt its caller gave up on. */
  const abandon = async (stub: LineStub, attempt: string) => {
    await call(stub, { op: "abandon", attempt }, CONFIRM_LINE_CALL_MS);
  };

  /**
   * An answer the client cannot act on. `gone` after the re-entries are spent is still a
   * deploy, counted and never paged; anything else is a protocol fault, which pages and
   * gives the attempt back, since the object may have given it something (#3351).
   */
  const unusable = async (stub: LineStub, attempt: string, a: Answer): Promise<LineReason> => {
    if (a.kind === "gone") return "gone";
    await abandon(stub, attempt);
    return "bad-answer";
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
    // #3355: the ack is sent at once and NOT waited on. Nothing the confirm does
    // depends on its answer (a `gone` only marks the turn detached, which every later
    // call checks), so waiting on it only added its round trip to every leader's start:
    // 1.3s on a line object fresh from a deploy (load run 37572839375), which alone put
    // a cold confirm over the startup bar. It is settled in `done`, like the heartbeat,
    // and its time is not counted in `lineMs`, which is what the line ADDS to a confirm.
    const acking = call(stub, { op: "ack", turn }, CONFIRM_LINE_CALL_MS).then((r) => {
      if (r.answer?.kind === "gone") detached = true;
    });
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
        await acking;
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
    attempt: string,
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
        // isolate's own line. The attempt is given back first, because its ticket may
        // have been promoted to lead meanwhile, and nobody will collect that lead
        // (#3351); the sweep would only drop it after the ack window.
        await abandon(stub, attempt);
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
      const reason = await unusable(stub, attempt, a);
      return fallBack(key, Math.max(0, deadline - now()), { ...served, line: "fallback", reason }, new Error(`the shared line answered ${JSON.stringify(a).slice(0, 80)}`));
    }
    deps.record({ ...served });
    return { kind: "unqueued" };
  };

  /** Act on the object's answer to an enter. */
  const onEntered = async (
    key: LineKey,
    stub: LineStub,
    attempt: string,
    answer: Answer,
    waitMs: number,
    served: LineServed,
    goneLeft: number,
  ): Promise<LineTurn<T>> => {
    if (answer.kind === "lead" && typeof answer.turn === "string") return leadOn(stub, answer.turn, served);
    if (answer.kind === "wait" && typeof answer.ticket === "string") return follow(key, stub, attempt, answer.ticket, now() + waitMs, served, goneLeft);
    if (answer.kind === "gone" && goneLeft > 0) return enterShared(key, waitMs, { ...served, reason: "gone" }, goneLeft - 1, null);
    const t0 = now();
    const reason = await unusable(stub, attempt, answer);
    return fallBack(key, Math.max(0, waitMs - (now() - t0)), { ...served, line: "fallback", reason }, new Error(`the shared line answered ${JSON.stringify(answer).slice(0, 80)}`));
  };

  const enterShared = async (key: LineKey, waitMs: number, served: LineServed, goneLeft: number, stashed: Stashed | null): Promise<LineTurn<T>> => {
    if (stashed?.kind === "fallback") return fallBack(key, waitMs, { ...served, line: "fallback", reason: stashed.reason }, null);
    if (stashed?.kind === "answer") {
      served.lineMs += stashed.spentMs;
      return onEntered(key, stashed.stub, stashed.attempt, stashed.answer, waitMs, served, goneLeft);
    }
    const stub = deps.namespace!.stubFor(key.group);
    const attempt = deps.newId();
    const t0 = now();
    const r = await call(stub, { op: "enter", attempt, line: key.instant, waitMs }, CONFIRM_LINE_REACH_MS);
    served.lineMs += r.ms;
    if (!r.answer) {
      await abandon(stub, attempt);
      // The enter and the give back both come out of the wait the isolate's line gets.
      return fallBack(key, Math.max(0, waitMs - (now() - t0)), { ...served, line: "fallback", reason: timedOut(r.err) ? "reach-timeout" : "enter-error" }, r.err);
    }
    return onEntered(key, stub, attempt, r.answer, Math.max(0, waitMs - r.ms), served, goneLeft);
  };

  /** Which line this confirm uses, before any call to the object. */
  const decide = async (key: LineKey): Promise<{ use: "shared" } | { use: "isolate" | "fallback"; reason: LineReason }> => {
    const sw = await deps.enabled();
    if (!sw.on) return { use: "isolate", reason: sw.source === "default" ? "unread-default" : "off" };
    if (!deps.namespace) return { use: "fallback", reason: "unbound" };
    void key;
    return { use: "shared" };
  };

  const enterOnce = async (key: LineKey, waitMs: number | undefined): Promise<LineTurn<T>> => {
    const served: LineServed = { line: "shared", reason: "ok", key: keyKindOf(key.group), lineMs: 0 };
    const stashed = stash.get(isolateKeyOf(key)) ?? null;
    // Cleared only once the switch has been read: a read that throws leaves what the
    // lookahead kept where `release` will find it (#3351).
    const how = await decide(key);
    stash.delete(isolateKeyOf(key));
    if (how.use !== "shared") {
      // #3351: the switch or binding changed since the lookahead kept a lead or ticket
      // for this enter. It is given back before the other line is taken, or the
      // object holds it for the ack window with nobody to collect it.
      // The give back's time comes out of the wait the other line is handed.
      let left = waitMs;
      if (stashed?.kind === "answer") {
        const t0 = now();
        await abandon(stashed.stub, stashed.attempt);
        if (left !== undefined) left = Math.max(0, left - (now() - t0));
      }
      if (how.use === "fallback") return fallBack(key, left, { ...served, line: "fallback", reason: how.reason }, null);
      deps.record({ ...served, line: "isolate", reason: how.reason });
      return deps.fallback.enter(key, left);
    }
    return enterShared(key, waitMs ?? 0, served, CONFIRM_LINE_GONE_RETRIES, stashed);
  };

  return {
    async enter(key, waitMs) {
      const turn = await enterOnce(key, waitMs);
      // Everything sent from here on (claims, the report, the heartbeat, a permit
      // given back) is sent during the turn.
      stage = "turn";
      return turn;
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
    async release() {
      // #3351: a lead or ticket a lookahead kept for an enter that never came. Left on
      // the object, a lead nobody collects holds the line for the ack window. After
      // the enter collected it, the stash is empty and nothing is sent.
      const left = [...stash.values()];
      stash.clear();
      for (const s of left) if (s.kind === "answer") await abandon(s.stub, s.attempt);
    },
  };
}

/** The Durable Object namespace, as much of it as this client uses. */
export interface DurableLineNamespace {
  idFromName(name: string): unknown;
  get(id: unknown, opts?: { locationHint?: string }): { fetch(url: string, init: { method?: string; body?: string; headers?: Record<string, string> }): Promise<Response> };
}

/**
 * The real binding as the client's transport (#3325): one object per line GROUP,
 * named from the group, created near the database. Smart placement runs the Worker
 * beside Supabase (us west), and an object is created where its first request comes
 * from, so the hint keeps a group's object there even when that first request does
 * not. An answer that is not the protocol's JSON is a failed call, never a guess.
 */
export function durableLineNamespace(ns: DurableLineNamespace): LineNamespace {
  return {
    stubFor(group) {
      const stub = ns.get(ns.idFromName(`confirm-line:v1:${group}`), { locationHint: "wnam" });
      return {
        async send(message) {
          const res = await stub.fetch("https://confirm-line/", {
            method: "POST",
            body: JSON.stringify(message),
            headers: { "content-type": "application/json" },
          });
          const body = (await res.json()) as unknown;
          if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(`the shared line answered ${res.status} with something that is not a message`);
          return body as Record<string, unknown>;
        },
      };
    },
  };
}

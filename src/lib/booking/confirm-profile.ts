/**
 * Where a confirm's time actually goes (#2321, #3300).
 *
 * The 2026-09-14 load run measured the request path at a CPU p99 of 4,908ms over
 * 1,364 invocations with no cron in the window, against a wall p95 of 4,025ms. CPU
 * roughly equals wall, so the confirm path is compute bound rather than waiting on
 * anything, and nothing in the run could say WHICH part of it. Reading the code
 * names candidates and cannot rank them: a profile is a shape rather than a cost
 * until the sample count is read (L355), and an estimate written in a comment is a
 * measurement nobody took (L353).
 *
 * So the path times its own named stages, and the log carries the apportionment
 * instead of somebody reasoning about it afterwards.
 *
 * **This is WALL time, not CPU, and no amount of instrumenting will change that**
 * (#2353). It is not that the runtime has simply not exposed a per request CPU
 * reading: Workers are DESIGNED so that code cannot measure its own execution
 * time. `Date.now()` returns the time of the LAST I/O and does not advance during
 * execution, no other timer is provided, and concurrency is withheld so none can
 * be built; that is the Spectre mitigation the platform was built around in 2017
 * (Cloudflare's security model page). Workers tracing documents the same thing
 * from the other end: a span containing no I/O reports 0ms.
 *
 * So a proposal to measure CPU per stage from inside the Worker cannot work, and
 * it is worth knowing before somebody spends an afternoon on it. The ONLY true
 * CPU figure available is the runtime's own, one number per invocation, which the
 * archived `wrangler tail` stream carries as `cpuTime` and the load run's judge
 * reads. Apportioning THAT by stage would need a controlled comparison between
 * runs, not an in process clock.
 *
 * What this measures is therefore the confirm's wall at I/O granularity. A span
 * runs from the call starting to this confirm RESUMING after it, so when the
 * isolate is busy with other requests the wait to be resumed lands inside the
 * span: a stage or a call reading far longer than the dependency's own log of it
 * is the isolate's delay in getting back to this confirm, not the dependency.
 *
 * **Collected on every confirm since #3300.** Until then it was gated behind
 * `SLATE_LOADTEST`, so a production confirm that ran out of its 12 second budget
 * could not say where the time went. The route opens the profile when its
 * `confirm answered` clock starts (`confirm-latency.ts`), so the wall here IS the
 * `response_ms` on that line, and the profile rides on the request's own
 * `ConfirmLineFacts`: one object per request, never module state, so confirms
 * running side by side in one isolate can never mix (L748). It is READ in full, and
 * so only costs its arithmetic, on a confirm that is logged with it; every confirm
 * reads just its Google calls (`googleTimingFields`, #3490).
 *
 * What it costs on every confirm: two clock reads and one small object per span.
 * A confirm runs about a dozen named stages, one span per ladder rung and one per
 * budgeted dependency call (a few dozen Supabase and Google requests), so a
 * confirm records well under a hundred spans. `Date.now()` in a Worker returns a
 * stored value without a system call, so that is microseconds against a confirm
 * that takes hundreds of milliseconds at the least.
 */

/**
 * When THIS isolate evaluated this module (#2340).
 *
 * Read once, at module scope, which is the only place the value exists: nothing
 * inside a request can ask how long the isolate spent starting up, and the whole
 * of that cost is charged to the first request the isolate serves. One clock read
 * per isolate. Read only ever after, so sharing it across requests is safe.
 */
export const ISOLATE_READY_AT_MS = Date.now();

/**
 * The booker route's own checks before the confirm, each timed as its own stage
 * INSIDE the `route-checks` span (#3493).
 *
 * `route-checks` cost 344 to 1574ms in the fourteen 8s or slower confirms profiled
 * on 2026-10-06 and 07, as much as the whole opening database read chain, and as
 * one span it could not say which check that was. The outer span stays, so every
 * reader of `route-checks` (the failure page's dearest stage, the load report) reads
 * what it always did, and these sit inside it.
 *
 * Each stage's OWN figure includes any stage nested in it, so the per stage figures
 * (the line's `stages`, the load report's per stage spread, the shares on
 * `confirmProfileLine`) overlap and must never be summed. Every TOTAL counts covered
 * time once instead: the request reading merges overlapping stages for `staged_ms`
 * and the unattributed split, and the load test window's `residualMs` is the window
 * minus that same union. An inner stage can never outlast the span around it, so the
 * dearest stage is never one of these.
 *
 * The names carry the `route-checks.` prefix so a line reads them as parts of that
 * span. They hold no comma and no colon, which would break the `name:ms/runs`
 * token the line and the load report's reader (`burst-breakdown.ts`) parse.
 */
export const ROUTE_CHECK_STAGES = {
  /** The per minute window at the edge, and the retry credit it may consult (#3364). */
  edgeLimit: "route-checks.edge-limit",
  /** The kill switch, read per request and deliberately never cached (#2297). */
  pauseFlag: "route-checks.pause-flag",
  /** The per address hourly cap, a database read and write. */
  hourlyCap: "route-checks.hourly-cap",
  /** Reading the request body under its byte cap (#3135). */
  bodyRead: "route-checks.body-read",
  /** The per contact hourly cap, one run per contact key (an email, a phone). */
  contactCap: "route-checks.contact-cap",
  /** Resolving an advisor's own link (#2073), only on a confirm that carries one. */
  agentLink: "route-checks.agent-link",
} as const;

/** One named stage of a confirm, and what it cost. */
export interface ConfirmStage {
  stage: string;
  /** Total wall time inside this stage, across every time it ran. */
  ms: number;
  /**
   * How many times it ran. A cheap thing done forty times and an expensive thing
   * done once are the same total and different fixes, so the count is never
   * dropped (L466).
   */
  calls: number;
}

/** The load test's reading (#2321): the confirm from the point its window opened. */
export interface ConfirmProfileReading {
  /** Wall time from the window opening to it being read. */
  totalMs: number;
  /**
   * How long before the window opened that THIS isolate evaluated the confirm
   * module (#2340).
   *
   * Small means the module was evaluated moments earlier, inside this very
   * request, which is an isolate serving its first one and paying for the server
   * bundle's evaluation. Large means a warm isolate. Measured when the window
   * OPENS, not at read: by read time the confirm's own seconds have passed, and a
   * warm isolate's age would then be indistinguishable from a cold one plus a slow
   * confirm.
   */
  isolateAgeMs: number;
  /** The named stages, dearest first, so a reader meets the expensive one first. */
  stages: ConfirmStage[];
  /**
   * What the named stages do NOT account for, stated rather than left to be
   * subtracted. Without it a reader takes the named stages for the whole cost and
   * optimises a path that is a fraction of it. The window minus the time ANY stage
   * covered, overlaps counted once (#3493), so with nested or parallel stages the
   * stages' ms plus this exceed `totalMs`; only without overlap do they sum to it.
   */
  residualMs: number;
}

/** One rung of the tier ladder the confirm walked, and how long it spent on it. */
export interface RungTime {
  code: string;
  ms: number;
}

/** What one dependency's calls cost this confirm. */
export interface DependencyCalls {
  /** The first word of the call's label: `supabase`, `google`, `slack`. */
  dependency: string;
  calls: number;
  /** Covered time, parallel calls counted once. */
  ms: number;
  /** The slowest single call, so one hung call and many slow ones read apart. */
  maxMs: number;
}

/** The whole request, read at the instant it answered (#3300). */
export interface ConfirmRequestReading {
  /** From the profile opening to the reading: the line's `response_ms`. */
  wallMs: number;
  /** The named stages, dearest first. */
  stages: ConfirmStage[];
  /** The time at least one stage was running, overlapping stages counted once. */
  stagedMs: number;
  /**
   * The wall no stage covers, and where it fell (L699): before the first stage
   * began, in the gaps between stages, and after the last one ended. The three
   * always sum to `totalMs`, and `totalMs + stagedMs` is the wall. Time in a gap is
   * this confirm computing, or waiting for the isolate to resume it, with nothing
   * named in flight. With no stage at all, the whole wall is `beforeMs`.
   */
  unattributed: { totalMs: number; beforeMs: number; betweenMs: number; afterMs: number };
  /** The ladder rungs walked, in order. Each sits inside the stage that walks the ladder. */
  rungs: RungTime[];
  /**
   * Every budgeted Supabase and Google request the confirm made (`call-budget.ts`),
   * or null when nothing was watching them: a route that runs no confirm budget
   * (the admin time change) reports no calls, and zero would read as a confirm that
   * waited on nothing (L90).
   */
  calls: {
    count: number;
    ms: number;
    byDependency: DependencyCalls[];
    /** #3511: the slowest single call by its FULL label (`google freeBusy.many`),
     *  which `byDependency` folds into its dependency; null when none was made. */
    slowest: { label: string; ms: number } | null;
    /**
     * #3511: the slowest call that STARTED inside each named stage, by stage. The
     * request's slowest call can belong to another stage than the dearest one, and
     * naming it for the dearest would blame the wrong thing (L11).
     */
    slowestByStage: Record<string, { label: string; ms: number }>;
  } | null;
}

export interface ConfirmProfile {
  /** Run `fn`, charging its wall time to `stage`. Returns and throws exactly as `fn` does. */
  time<T>(stage: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Open a stage that spans more than one call (a route's checks, with returns
   * along the way). The returned function ends it, once; a stage never ended is
   * closed at the reading, so an early return is charged rather than lost.
   */
  begin(stage: string): () => void;
  /** Run one rung of the tier ladder, charging its wall time to that rung. */
  rung<T>(code: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Record one budgeted dependency call; the shape `call-budget.ts` reports in.
   * `colo` (#3784) is the colo the answer's `cf-ray` named, null when it named none.
   */
  call(label: string, startedAt: number, endedAt: number, colo?: string | null): void;
  /**
   * #3784: every colo `dependency`'s answers named, first seen first, each once.
   * Empty when none did (no call, no answer, or a service not behind Cloudflare).
   * On Supabase this is where the confirm RAN (`src/lib/http/cf-ray.ts`).
   */
  answeredFrom(dependency: string): string[];
  /**
   * This profile, as the observer a confirm budget reports its calls to, marked as
   * watching them, so the reading says how many there were, zero included. A route
   * hands this to `withinBookingRequest`; one that does not leaves `calls` null.
   */
  observeCalls(): ConfirmProfile;
  /**
   * The load test's window (#2321), opened now: stages that START from here on,
   * read against the time since. `isolateReadyAtMs` is when this isolate evaluated
   * the module, `ISOLATE_READY_AT_MS` in production.
   */
  window(isolateReadyAtMs?: number): { read(): ConfirmProfileReading };
  /** The whole request, read at `at` (the instant the confirm answered). */
  read(at: number): ConfirmRequestReading;
  /**
   * #3490: the budgeted calls whose label is one of `labels`, read at `at`: how many,
   * and their covered time (parallel calls counted once). Null when none was made, so a
   * caller can leave a field absent rather than write a 0 that reads as a measured
   * instant call (L90). Reads only the spans already recorded; it starts no timer.
   */
  callGroup(labels: readonly string[], at: number): { calls: number; ms: number } | null;
}

interface Span {
  from: number;
  /** Null while the span is still open. */
  to: number | null;
}

interface StageSpan extends Span {
  stage: string;
}

/**
 * A profile for one request. Never shared: every confirm makes its own.
 *
 * The clock is INJECTED so the tests drive it rather than waiting on real time
 * (L524). `startedAt` lets the caller open the profile on the very clock reading
 * its own timer starts from, so the profile's wall and the line's `response_ms`
 * are one number rather than two readings a moment apart.
 */
export function makeConfirmProfile(opts: { now: () => number; startedAt?: number }): ConfirmProfile {
  const startedAt = opts.startedAt ?? opts.now();
  const stages: StageSpan[] = [];
  const rungs: { code: string; span: Span }[] = [];
  const calls: { label: string; span: Span }[] = [];
  /** #3784: the colos each dependency's answers named, by its first word. A Map (L738). */
  const colos = new Map<string, string[]>();
  let observed = false;

  const begin = (stage: string): (() => void) => {
    const span: StageSpan = { stage, from: opts.now(), to: null };
    stages.push(span);
    return () => {
      if (span.to === null) span.to = opts.now();
    };
  };

  const profile: ConfirmProfile = {
    async time<T>(stage: string, fn: () => Promise<T>): Promise<T> {
      const end = begin(stage);
      try {
        return await fn();
      } finally {
        // In a `finally`, so a stage that THREW is still charged for the time it
        // spent. A confirm that fails is exactly the one somebody profiles, and a
        // stage recorded only on success would report the expensive failing step
        // as free (L515).
        end();
      }
    },
    begin,
    async rung<T>(code: string, fn: () => Promise<T>): Promise<T> {
      const span: Span = { from: opts.now(), to: null };
      rungs.push({ code, span });
      try {
        return await fn();
      } finally {
        span.to = opts.now();
      }
    },
    call(label: string, from: number, to: number, colo?: string | null): void {
      observed = true;
      calls.push({ label, span: { from, to } });
      if (!colo) return;
      const dependency = label.split(" ")[0] || label;
      const seen = colos.get(dependency) ?? [];
      if (!seen.includes(colo)) colos.set(dependency, [...seen, colo]);
    },
    answeredFrom(dependency: string): string[] {
      return [...(colos.get(dependency) ?? [])];
    },
    observeCalls(): ConfirmProfile {
      observed = true;
      return profile;
    },
    window(isolateReadyAtMs?: number) {
      const from = opts.now();
      // Never negative. Nothing should make the module look younger than the
      // request, and nonsense printed beside real numbers is what a reader has to
      // decode.
      const isolateAgeMs = Math.max(0, from - (isolateReadyAtMs ?? from));
      return {
        read(): ConfirmProfileReading {
          const at = opts.now();
          const totalMs = Math.max(0, at - from);
          // Only stages that completed inside the window, as the load test's profile
          // always counted them.
          const inside = stages.filter((s) => s.from >= from && s.to !== null);
          const byStage = aggregate(inside, at);
          // The time ANY stage covered, overlaps counted once (#3493). Summing each
          // stage's ms counted a nested stage on top of the stage around it, and two
          // stages running side by side twice, which shrank the residual toward zero.
          const named = merge(inside.map((s) => clip(s, from, at))).reduce((n, [a, b]) => n + (b - a), 0);
          return {
            totalMs,
            isolateAgeMs,
            stages: byStage,
            // Never negative. Workers clocks do not advance inside a synchronous
            // span, so stages can legitimately read as instant.
            residualMs: Math.max(0, totalMs - named),
          };
        },
      };
    },
    read(at: number): ConfirmRequestReading {
      const wallMs = Math.max(0, at - startedAt);
      const covered = merge(stages.map((s) => clip(s, startedAt, at)));
      const stagedMs = covered.reduce((n, [a, b]) => n + (b - a), 0);
      const beforeMs = covered.length > 0 ? covered[0][0] - startedAt : wallMs;
      const afterMs = covered.length > 0 ? at - covered[covered.length - 1][1] : 0;
      const totalMs = Math.max(0, wallMs - stagedMs);
      return {
        wallMs,
        stages: aggregate(stages, at),
        stagedMs,
        unattributed: { totalMs, beforeMs, betweenMs: Math.max(0, totalMs - beforeMs - afterMs), afterMs },
        rungs: rungs.map((r) => ({ code: r.code, ms: lengthOf(r.span, at) })),
        calls: observed ? readCalls(calls, startedAt, at, stages) : null,
      };
    },
    callGroup(labels: readonly string[], at: number) {
      const list = calls.filter((c) => labels.includes(c.label));
      if (list.length === 0) return null;
      return { calls: list.length, ms: coveredMs(list, startedAt, at) };
    },
  };
  return profile;
}

/**
 * #3490: the Google calls a confirm's line times on EVERY confirm, by the exact label
 * each is profiled under (`google ${label}` in `calendar.ts`, `MINT_LABEL` in `dwd.ts`).
 *
 * `read` and `write` are the calls the load test's Google delay stands in for, the ones
 * cut off at `GOOGLE_CONFIRM_TIMEOUT_MS`: the live free/busy check, and the calendar
 * writes a confirm makes (the insert on a booking, the patch on a time change, the delete
 * that rolls a lost insert back). `mint` is the delegated token request, which the delay
 * does NOT stand in for and which caused most of the slow confirms of 2026-10-12 to 18.
 * `scripts/test-loadtest-google-delay.ts` holds the read and write labels against the
 * calls in `calendar.ts` and the mint label against `dwd.ts`, so a renamed label fails the
 * build rather than leaving its field absent for ever.
 */
export const GOOGLE_TIMING_GROUPS: readonly { kind: "read" | "write" | "mint"; labels: readonly string[] }[] = [
  { kind: "read", labels: ["google freeBusy", "google freeBusy.many"] },
  { kind: "write", labels: ["google events.insert", "google events.patch", "google events.delete"] },
  { kind: "mint", labels: ["google token mint"] },
];

/**
 * #3490: the `confirm answered` line's Google fields, put on every confirm, fast or slow:
 * `google_read_ms` / `google_read_calls`, `google_write_ms` / `google_write_calls`,
 * `google_mint_ms` / `google_mint_calls`.
 *
 * What `_ms` measures: the COVERED wall time of that group's calls, from each call
 * starting to this confirm resuming after its response arrived, with calls that ran side
 * by side counted once. So two parallel wave chunks of 400 and 500ms read as the time the
 * lead waited for them, never their 900ms sum, and with one call it is that call's time.
 *
 * What it does NOT measure:
 *   - reading the response BODY, which the caller does after the span ends
 *     (`fetchWithinBudget` in `call-budget.ts`); a large free/busy reply parses outside it;
 *   - getting the token: a read or write span starts once the token is in hand, and the
 *     mint is its own group. A token served from the shared holder or the isolate's cache
 *     is in no group at all;
 *   - Google's own processing time: when the isolate is busy with other requests the wait
 *     to be resumed lands inside the span (see the module header);
 *   - a call still in flight when the confirm answered, or made after it (deferred work),
 *     since a call is recorded when it ends and the line is read at the answer;
 *   - a call refused before it started (a spent budget, the open breaker), which made no
 *     request.
 *
 * A confirm that made no call in a group logs that group's two fields ABSENT, never 0:
 * a 0 would read as a call that was made and took no time. A call that WAS made and read
 * as no time (the Worker clock moves at I/O) says 0 with its count. Absent also when
 * nothing watched the calls (a route running no confirm budget).
 *
 * Cost: none of this starts a timer or records anything new. Every confirm already records
 * each budgeted call's start and end (#3300); this reads that list once per group at the
 * answer, a filter and an interval merge over a few dozen spans.
 */
export function googleTimingFields(profile: ConfirmProfile, at: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of GOOGLE_TIMING_GROUPS) {
    const read = profile.callGroup(g.labels, at);
    if (!read) continue;
    out[`google_${g.kind}_ms`] = read.ms;
    out[`google_${g.kind}_calls`] = read.calls;
  }
  return out;
}

/** The time at least one of these calls was in flight inside [from, at], overlaps counted once. */
function coveredMs(list: { span: Span }[], from: number, at: number): number {
  return merge(list.map((c) => clip(c.span, from, at))).reduce((n, [a, b]) => n + (b - a), 0);
}

/** A span's length, an open one closed at `at`, never negative. */
function lengthOf(span: Span, at: number): number {
  return Math.max(0, (span.to ?? at) - span.from);
}

/** A span as an interval inside [from, to], an open one closed at `to`. */
function clip(span: Span, from: number, to: number): [number, number] {
  const a = Math.min(Math.max(span.from, from), to);
  const b = Math.min(Math.max(span.to ?? to, a), to);
  return [a, b];
}

/**
 * The union of some intervals, as disjoint intervals in order. This is what keeps
 * two spans running at once from being counted twice: parallel Supabase reads, or
 * a rung inside the stage that walks the ladder.
 */
function merge(intervals: [number, number][]): [number, number][] {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Per stage totals and counts, dearest first. */
function aggregate(spans: StageSpan[], at: number): ConfirmStage[] {
  const byStage = new Map<string, ConfirmStage>();
  for (const s of spans) {
    const row = byStage.get(s.stage) ?? { stage: s.stage, ms: 0, calls: 0 };
    row.ms += lengthOf(s, at);
    row.calls += 1;
    byStage.set(s.stage, row);
  }
  return [...byStage.values()].sort((a, b) => b.ms - a.ms);
}

function readCalls(
  calls: { label: string; span: Span }[],
  from: number,
  at: number,
  /** Required: a forgotten list would read as no call ever made inside a stage. */
  stages: StageSpan[],
): ConfirmRequestReading["calls"] {
  const groups = new Map<string, { label: string; span: Span }[]>();
  for (const c of calls) {
    // The first word names the dependency (`google freeBusy`, `google token mint`
    // are both Google), so the line stays a handful of tokens however many kinds
    // of call there are.
    const dependency = c.label.split(" ")[0] || c.label;
    groups.set(dependency, [...(groups.get(dependency) ?? []), c]);
  }
  const covered = (list: { span: Span }[]) => coveredMs(list, from, at);
  const byDependency = [...groups.entries()]
    .map(([dependency, list]) => ({
      dependency,
      calls: list.length,
      ms: covered(list),
      maxMs: Math.max(...list.map((c) => lengthOf(c.span, at))),
    }))
    .sort((a, b) => b.ms - a.ms);
  let slowest: { label: string; ms: number } | null = null;
  for (const c of calls) {
    const ms = lengthOf(c.span, at);
    if (slowest === null || ms > slowest.ms) slowest = { label: c.label, ms };
  }
  // No prototype, so a stage named like an inherited property starts empty (L738).
  const slowestByStage: Record<string, { label: string; ms: number }> = Object.create(null);
  for (const c of calls) {
    const ms = lengthOf(c.span, at);
    for (const s of stages) {
      // A call belongs to every stage running when it started (an outer stage and
      // an inner one both hold it), never to one that merely overlaps its tail. A
      // call starting the instant a stage ENDED belongs to what runs next, so the
      // end is exclusive; an open stage runs to the reading.
      const end = s.to ?? Number.POSITIVE_INFINITY;
      if (c.span.from < s.from || c.span.from >= end) continue;
      const held = slowestByStage[s.stage];
      if (!held || ms > held.ms) slowestByStage[s.stage] = { label: c.label, ms };
    }
  }
  return { count: calls.length, ms: covered(calls), byDependency, slowest, slowestByStage };
}

/** `profile.time`, or the work alone when there is no profile to charge it to. */
export function timeStage<T>(profile: ConfirmProfile | undefined, stage: string, fn: () => Promise<T>): Promise<T> {
  return profile ? profile.time(stage, fn) : fn();
}

/**
 * The request reading as `confirm answered` line fields (#3300): counts and
 * milliseconds and short tokens only, never an error or anything about the lead.
 * Lists are one token each, `stages` as `name:ms/runs`, `rung_ms` as `code:ms` in
 * ladder order, `calls_by` as `dependency:ms/calls/slowest_ms`, so a whole confirm
 * reads in one line. A count that is zero is said as zero, never left out; the one
 * exception is the calls, absent when nothing watched them (see `calls`).
 */
export function confirmProfileFields(r: ConfirmRequestReading): Record<string, string | number> {
  const out: Record<string, string | number> = { stages_run: r.stages.length };
  if (r.stages.length > 0) out.stages = r.stages.map((s) => `${s.stage}:${s.ms}/${s.calls}`).join(",");
  out.staged_ms = r.stagedMs;
  out.unattributed_ms = r.unattributed.totalMs;
  out.unattributed_before_ms = r.unattributed.beforeMs;
  out.unattributed_between_ms = r.unattributed.betweenMs;
  out.unattributed_after_ms = r.unattributed.afterMs;
  out.rungs_walked = r.rungs.length;
  if (r.rungs.length > 0) out.rung_ms = r.rungs.map((g) => `${g.code}:${g.ms}`).join(",");
  // Absent, never zero, when nothing watched this request's calls.
  if (r.calls) {
    out.calls_made = r.calls.count;
    out.calls_ms = r.calls.ms;
    if (r.calls.byDependency.length > 0) {
      out.calls_by = r.calls.byDependency.map((d) => `${d.dependency}:${d.ms}/${d.calls}/${d.maxMs}`).join(",");
    }
    // #3511: which call, by name, since `calls_by` says only which dependency.
    if (r.calls.slowest) out.slowest_call = `${r.calls.slowest.label}:${r.calls.slowest.ms}`;
  }
  return out;
}

/**
 * The one line the load test's apportionment is logged as.
 *
 * Built here rather than at the log site so there is one copy of the wording and
 * the preview of it is what ships (L41). It names the SHARE as well as the
 * milliseconds, because the share is what a reader acts on and computing it from
 * two numbers on a phone is what nobody does.
 */
export function confirmProfileLine(reading: ConfirmProfileReading): string {
  const share = (ms: number) =>
    reading.totalMs > 0 ? `${Math.round((ms / reading.totalMs) * 100)}%` : "n/a";
  const parts = reading.stages.map((s) => `${s.stage} ${s.ms}ms (${share(s.ms)}, x${s.calls})`);
  parts.push(`unattributed ${reading.residualMs}ms (${share(reading.residualMs)})`);
  return `${reading.totalMs}ms wall: ${parts.join(", ")}`;
}

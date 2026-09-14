/**
 * Where a confirm's time actually goes (#2321).
 *
 * The 2026-09-14 load run measured the request path at a CPU p99 of 4,908ms over
 * 1,364 invocations with no cron in the window, against a wall p95 of 4,025ms. CPU
 * roughly equals wall, so the confirm path is compute bound rather than waiting on
 * anything, and nothing in the run could say WHICH part of it. Reading the code
 * names candidates and cannot rank them: a profile is a shape rather than a cost
 * until the sample count is read (L355), and an estimate written in a comment is a
 * measurement nobody took (L353).
 *
 * So the path times its own named stages, and the next run's archived log carries
 * the apportionment instead of somebody reasoning about it afterwards.
 *
 * **This is WALL time, not CPU**, because the runtime exposes no per request CPU
 * reading. It apportions the confirm only because that run measured the two as
 * roughly equal; on a path that waits on something the two would diverge and the
 * shares here would describe the waiting rather than the compute. Anything drawn
 * from this has to say which it is.
 *
 * **Gated entirely behind `SLATE_LOADTEST`**, exactly as the Google stub and the
 * seen address echo are. With the flag unset the clock is never read at all, so a
 * production confirm pays nothing rather than paying a little and discarding it.
 */

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

export interface ConfirmProfileReading {
  /** Wall time from the profile being created to it being read. */
  totalMs: number;
  /** The named stages, dearest first, so a reader meets the expensive one first. */
  stages: ConfirmStage[];
  /**
   * What the named stages do NOT account for, stated rather than left to be
   * subtracted. Without it a reader takes the named stages for the whole cost and
   * optimises a path that is a fraction of it.
   */
  residualMs: number;
}

export interface ConfirmProfile {
  /** Run `fn`, charging its wall time to `stage`. Returns and throws exactly as `fn` does. */
  time<T>(stage: string, fn: () => Promise<T>): Promise<T>;
  /** The apportionment, or null when profiling was off. Never a row of zeroes. */
  read(): ConfirmProfileReading | null;
}

/**
 * A profile that measures, or one that does nothing at all.
 *
 * The clock is INJECTED so the tests drive it rather than waiting on real time
 * (L524), and so the disabled path can be proved never to read it.
 */
export function makeConfirmProfile(opts: {
  enabled: boolean;
  now: () => number;
}): ConfirmProfile {
  if (!opts.enabled) {
    return {
      // No clock read at all, not a read that is discarded: every confirm in
      // production takes this branch.
      time: <T>(_stage: string, fn: () => Promise<T>) => fn(),
      // Null rather than an empty reading. A disabled profile reporting zeroes
      // renders as a confirm that cost nothing, which is the shape of a
      // measurement rather than of an absent one (L98).
      read: () => null,
    };
  }

  const startedAt = opts.now();
  const byStage = new Map<string, ConfirmStage>();

  return {
    async time<T>(stage: string, fn: () => Promise<T>): Promise<T> {
      const from = opts.now();
      try {
        return await fn();
      } finally {
        // In a `finally`, so a stage that THREW is still charged for the time it
        // spent. A confirm that fails is exactly the one somebody profiles, and a
        // stage recorded only on success would report the expensive failing step
        // as free (L515).
        const spent = Math.max(0, opts.now() - from);
        const row = byStage.get(stage) ?? { stage, ms: 0, calls: 0 };
        row.ms += spent;
        row.calls += 1;
        byStage.set(stage, row);
      }
    },
    read(): ConfirmProfileReading {
      const totalMs = Math.max(0, opts.now() - startedAt);
      const stages = [...byStage.values()].sort((a, b) => b.ms - a.ms);
      const named = stages.reduce((n, s) => n + s.ms, 0);
      return {
        totalMs,
        stages,
        // Never negative. Workers clocks do not advance inside a synchronous span,
        // so stages can legitimately read as instant, and a negative number printed
        // beside real ones is nonsense a reader has to decode.
        residualMs: Math.max(0, totalMs - named),
      };
    },
  };
}

/**
 * The one line the apportionment is logged as.
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

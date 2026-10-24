/**
 * Per-step containment and cost for a cron lane (#1281 + #1277).
 *
 * Two problems with one shape, which is why there is one runner rather than two.
 *
 * CONTAINMENT (#1281). The monitor route ran thirteen checks in sequence inside a
 * single try block and only four carried their own catch, so an unexpected throw
 * in any unguarded step skipped every step below it. One broken check therefore
 * disabled a dozen unrelated ones, including two that exist to catch
 * customer-visible problems (the availability probe and the cal.com override
 * sweep). It failed loud rather than silent, because the heartbeat stamp is the
 * last statement and the lane watchdog pages on a missing stamp, but in the
 * meantime the checks were simply not running.
 *
 * COST (#1277). No step recorded its own duration. When a shared budget degrades,
 * every check slows at once and the first symptom appears in whichever one is most
 * sensitive rather than in the one consuming the budget. On the every-minute lane
 * that took three days to notice and surfaced only as a downstream page (#1245).
 *
 * Deliberately dependency-free (no `@/` imports, clock and logger injected), so
 * scripts/test-monitor-step-runner.ts drives every branch node-natively.
 */

export interface StepOutcome {
  name: string;
  /** Milliseconds this step alone took, measured whether it succeeded or not. */
  ms: number;
  ok: boolean;
  /**
   * False when the step returned without doing its work this tick (#3955): its gate
   * was shut, its hourly slot had not come round, its org was closed. It did not
   * throw, and it did not show its work succeeding either, so the step failure
   * streak counts it in NEITHER direction (L792). A throw is always measured.
   */
  measured: boolean;
}

/** What a step body is handed, to say what its run measured. */
export interface StepContext {
  /**
   * Record this run as having measured nothing, and return `value` unchanged, so a
   * step can write `return step.unmeasured(null)` where it stands down.
   */
  unmeasured: <V>(value: V) => V;
}

/** Fields for the lane's cycle log line. */
export type StepFields = Record<string, number | string>;

export interface StepRunner {
  /**
   * Run one step inside its own boundary. Returns the step's value, or
   * `fallback` when it threw. NEVER throws: a runner that could take the lane
   * down would defeat the containment it exists to provide.
   */
  run: <T>(name: string, fallback: T, fn: (step: StepContext) => Promise<T>) => Promise<T>;
  /** What each step did, in the order they ran. */
  outcomes: () => StepOutcome[];
  /** The cycle log line's cost and failure fields. */
  fields: () => StepFields;
}

export function createStepRunner(deps: {
  now: () => number;
  /** Report a step's failure. Called once per failure, with the step's name. */
  onError: (name: string, err: unknown) => void;
  /**
   * The lane lock's fence (#3120), asked before each step. Once it says the lock is
   * gone, every remaining step is SKIPPED: another run owns the lane, and two runs
   * would post the same handoff and overwrite each other's learned settings. A skip
   * is not a failure, so it never feeds a step failure streak.
   */
  stillHeld?: () => Promise<boolean>;
}): StepRunner {
  const outcomes: StepOutcome[] = [];
  const skipped: string[] = [];

  return {
    async run<T>(name: string, fallback: T, fn: (step: StepContext) => Promise<T>): Promise<T> {
      if (deps.stillHeld) {
        let held = false;
        try {
          held = await deps.stillHeld();
        } catch {
          // A fence that cannot answer cannot show the lock is held.
        }
        if (!held) {
          skipped.push(name);
          return fallback;
        }
      }
      const startedAt = deps.now();
      let measured = true;
      const step: StepContext = {
        unmeasured: (value) => {
          measured = false;
          return value;
        },
      };
      try {
        const out = await fn(step);
        outcomes.push({ name, ms: deps.now() - startedAt, ok: true, measured });
        return out;
      } catch (err) {
        // Timed in the failure path too. The step that dies is often the FAST
        // one, so leaving it out of the timings would hide exactly the step
        // someone is looking for.
        outcomes.push({ name, ms: deps.now() - startedAt, ok: false, measured: true });
        try {
          deps.onError(name, err);
        } catch {
          // A broken logger must not become the thing that aborts the lane. There
          // is nowhere left to report this, which is why it is the one place here
          // that swallows: the step is still recorded as failed, so the count and
          // the named list on the cycle line still tell the truth.
        }
        return fallback;
      }
    },

    outcomes: () => [...outcomes],

    fields(): StepFields {
      const ms = new Map<string, number>();
      const seen = new Map<string, number>();
      let total = 0;
      const failed: string[] = [];
      const unmeasured: string[] = [];
      for (const o of outcomes) {
        // Summed, not overwritten. Two steps sharing a name would otherwise
        // silently lose one of the two timings, so the measurement quietly stops
        // meaning what it says while still looking like a number.
        ms.set(o.name, (ms.get(o.name) ?? 0) + o.ms);
        seen.set(o.name, (seen.get(o.name) ?? 0) + 1);
        total += o.ms;
        if (!o.ok) failed.push(o.name);
        else if (!o.measured) unmeasured.push(o.name);
      }
      const out: StepFields = {};
      for (const [name, value] of ms) out[`ms_${name}`] = value;
      out.ms_total = total;
      out.steps = outcomes.length;
      out.steps_failed = failed.length;
      // Named, not just counted: "two checks failed" sends the reader to the logs,
      // "sweep and drift failed" tells them which customer-visible checks did not
      // run this tick.
      if (failed.length > 0) out.failed = failed.join(",");
      if (skipped.length > 0) out.skipped_lease_lost = skipped.join(",");
      // Named, so a step standing down every tick is visible on the cycle line rather
      // than reading as one that ran and found nothing.
      if (unmeasured.length > 0) out.unmeasured = unmeasured.join(",");
      const dups = [...seen.entries()].filter(([, n]) => n > 1).map(([n]) => n);
      if (dups.length > 0) out.duplicate_step_names = dups.join(",");
      return out;
    },
  };
}

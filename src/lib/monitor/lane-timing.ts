/**
 * Per-lane cost attribution for a shared cron invocation (#1245).
 *
 * The `* * * * *` trigger drives four lanes (sync, recompute, outbox, selfheal)
 * inside ONE Worker invocation, so they share its CPU and subrequest budget. When
 * that budget tripled in four days on a flat workload, the only visible symptom
 * was a recompute headroom page: the lane that noticed, not necessarily the lane
 * that spent it. Nothing recorded what each lane cost, so the consumer was
 * unproven and there was nothing to trim on purpose.
 *
 * This turns each invocation into one queryable line carrying a field per lane, so
 * a lane's cost can be charted over days and the growth attributed before it
 * reaches a ceiling rather than after.
 *
 * Wall time, not CPU: the Workers runtime exposes no per-request CPU reading, so
 * this measures elapsed time around each lane's own request. The lanes run
 * CONCURRENTLY, so the per-lane figures overlap and their sum normally EXCEEDS
 * `total_ms`; the value is in the trend per lane, not in the sum.
 */

/** One lane's measured run. `ok` false means it failed, which usually makes it
 *  look cheap, so it is reported rather than left to be misread as low cost. */
export interface LaneRun {
  /** The app route the lane was driven through, e.g. `/api/cron/recompute`. */
  path: string;
  ms: number;
  ok: boolean;
}

/** `/api/cron/bulk-reassign` -> `bulk_reassign`: a queryable field name. */
export function laneFieldName(path: string): string {
  const last = path.split("/").filter(Boolean).pop() ?? "unknown";
  return last.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
}

/**
 * The log fields for one invocation: `total_ms`, one `<lane>_ms` per lane, the
 * slowest lane by name, how many lanes succeeded and failed, and any lane that
 * failed by name.
 *
 * Flat per-lane fields on purpose. A single nested blob cannot be charted, and
 * charting one lane against itself over days is the whole point: the growth that
 * went unattributed was visible only as a change in shape over time.
 */
export function laneTimingFields(
  runs: LaneRun[],
  totalMs: number,
): Record<string, string | number> {
  const fields: Record<string, string | number> = { total_ms: Math.round(totalMs) };
  let slowest: LaneRun | null = null;
  const failed: string[] = [];
  for (const run of runs) {
    fields[`${laneFieldName(run.path)}_ms`] = Math.round(run.ms);
    if (!slowest || run.ms > slowest.ms) slowest = run;
    if (!run.ok) failed.push(laneFieldName(run.path));
  }
  if (slowest) fields.slowest = laneFieldName(slowest.path);
  // The outcome COUNTS, always present (#3138): the tail worker ships this line to
  // Better Stack as numbers, and a count that is absent on a healthy tick cannot
  // be summed or charted beside one where it is not.
  fields.lanes_ok = runs.length - failed.length;
  fields.lanes_failed = failed.length;
  // Only when there is something to say: an always-present empty field is noise
  // in every line and reads as a measurement rather than an absence.
  if (failed.length > 0) fields.failed = failed.join(",");
  return fields;
}

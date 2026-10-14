/**
 * Per-lane cost attribution for a cron tick (#1245).
 *
 * The `* * * * *` trigger drives four lanes (sync, recompute, outbox, selfheal).
 * Until #3693 they ran inside ONE Worker invocation and shared its CPU and
 * subrequest budget; now each is sent to the Worker's own fetch handler as a
 * placed request, and only a lane that falls back to in process runs on the
 * scheduled invocation's budget (`via` says which). When
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
  /** Which path ran it (#3693): sent over the Worker's binding to itself, so it runs as
   *  a placed fetch near the database, or run in process on the scheduled invocation. */
  via?: "placed" | "in_process";
  /** The `cf-placement` value a placed lane answered with, or null when it carried none. */
  placement?: string | null;
  /** Why a lane meant to be placed ran in process instead. */
  fallback?: string | null;
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
  let placed = 0;
  for (const run of runs) {
    const lane = laneFieldName(run.path);
    fields[`${lane}_ms`] = Math.round(run.ms);
    if (!slowest || run.ms > slowest.ms) slowest = run;
    if (!run.ok) failed.push(lane);
    // #3693: which path ran the lane, so the effect of placing them reads off this
    // line. A placed lane with no `cf-placement` header says `none` rather than
    // leaving the field out, so an absent header is never mistaken for in process.
    if (run.via) fields[`${lane}_via`] = run.via;
    if (run.via === "placed") {
      placed += 1;
      fields[`${lane}_placement`] = run.placement ?? "none";
    }
    if (run.fallback) fields[`${lane}_fallback`] = run.fallback;
  }
  if (slowest) fields.slowest = laneFieldName(slowest.path);
  // The outcome COUNTS, always present (#3138): the tail worker ships this line to
  // Better Stack as numbers, and a count that is absent on a healthy tick cannot
  // be summed or charted beside one where it is not.
  fields.lanes_ok = runs.length - failed.length;
  fields.lanes_failed = failed.length;
  fields.lanes_placed = placed;
  // Only when there is something to say: an always-present empty field is noise
  // in every line and reads as a measurement rather than an absence.
  if (failed.length > 0) fields.failed = failed.join(",");
  return fields;
}

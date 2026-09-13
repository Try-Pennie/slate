// Reading Cloudflare's own numbers for a booking load run (#2279), kept apart from
// the IO so every outcome is driven offline by scripts/test-loadtest-platform-reading.ts.
//
// The judge's platform bar had produced NO reading on any run, and reported the
// same sentence every time: "the analytics API did not report CPU, outcomes or
// invocations for the window". The issue blamed a lagging analytics pipeline. It
// was not that. Measured against the live GraphQL API on 2026-09-13:
//
//   THE QUERY ASKED FOR A FIELD THAT DOES NOT EXIST. `dimensions { outcome }` is
//   not a dimension of `workersInvocationsAdaptive`; the dimension is `status`.
//   The API answers HTTP 200 with an `errors` array and a NULL `data`, so the old
//   reader found no rows and reported a window it had never actually queried. A
//   200 was treated as a success, so nothing ever looked at `errors` (L11: the two
//   causes shared one sentence, and the one it printed was the wrong one).
//
//   THE HEALTHY SENTINEL WAS WRONG TOO. The judge treated `ok` as the good
//   outcome. The real `status` dimension reports `success`. So the first reading
//   that ever arrived would have turned every healthy invocation into a finding.
//   Both faults were invisible for the same reason: no real value had ever
//   reached this code (L98, and the fixtures in the judge's own suite were written
//   around the same wrong sentinel, so they agreed with it by construction).
//
// The measured pipeline lag was 1.9 minutes, not three hours. The three hour
// figure on the issue belongs to the Workers LOGS query pipeline (#1533), which is
// a different system from the GraphQL analytics read here. Minutes is a lag a
// bounded poll rides out, which is why `shouldPollAgain` exists.

/**
 * The `status` value that means the invocation finished normally.
 *
 * Measured, not guessed: a live read of the production Worker returned exactly
 * `{ success: 199 }` over a clean window. The judge's previous `ok` appears
 * nowhere in the API's vocabulary.
 */
export const HEALTHY_INVOCATION_STATUS = "success";

/**
 * Invocations over the window, grouped by status.
 *
 * `subrequests` IS asked for, and it is worth saying why against what this repo
 * previously recorded. The judge's own comment and its printed report both claimed
 * "Cloudflare exposes NO subrequest counter, so one could never be measured". That
 * is false: `sum { subrequests }` exists, and the old query was already asking for
 * it before discarding it in the response type (L425: a decoder that declares only
 * the fields it needs silently drops its siblings). What is genuinely not exposed
 * is a PER INVOCATION maximum, which is what the 1000 subrequest ceiling is
 * actually about. A sum and a mean are what can be had, and a real breach arrives
 * as a `status` other than success, which is judged.
 */
export const INVOCATIONS_QUERY = `query($account:String!,$script:String!,$from:Time!,$to:Time!){
  viewer { accounts(filter:{accountTag:$account}) {
    workersInvocationsAdaptive(limit:10000, filter:{scriptName:$script, datetime_geq:$from, datetime_leq:$to}) {
      sum { requests subrequests }
      quantiles { cpuTimeP99 }
      dimensions { status }
    } } }
}`;

/**
 * The scheduled (cron) invocations over the same window, one row each.
 *
 * This is the dataset that makes a CPU bar judgeable at all.
 * `workersInvocationsAdaptive` counts cron invocations ALONGSIDE fetch ones and
 * carries no dimension separating them (the full dimension list was read from the
 * live schema and has no event type). Slate's cron lanes run under a raised CPU
 * ceiling deliberately (`limits.cpu_ms` is 120000), so on production 2026-09-13 the
 * adaptive p99 was 48.9 SECONDS against a 200ms per request budget: not a
 * regression, just the cron lanes being counted. Judging the mixed percentile against a per request budget
 * would have failed every run for a reason nobody should fix (L36), which is how a
 * bar stops being read.
 *
 * It is a raw dataset rather than an aggregate, so each row carries its own
 * `cpuTimeUs` and the `cron` expression that fired it, which is what lets a finding
 * NAME the lane.
 */
export const SCHEDULED_QUERY = `query($account:String!,$script:String!,$from:Time!,$to:Time!){
  viewer { accounts(filter:{accountTag:$account}) {
    workersInvocationsScheduled(limit:10000, filter:{scriptName:$script, datetime_geq:$from, datetime_leq:$to}) {
      cpuTimeUs cron status
    } } }
}`;

export interface InvocationsReading {
  invocations: number;
  subrequests: number;
  cpuMsP99: number;
  /** The `status` histogram, each name kept rather than summed (L11). */
  statuses: Record<string, number>;
}

export interface ScheduledReading {
  invocations: number;
  worstCpuMs: number;
  byCron: Record<string, { invocations: number; worstCpuMs: number }>;
}

export type ReadResult<T> = { ok: true; reading: T } | { ok: false; why: string };

/** The GraphQL envelope, read defensively because every field here is optional. */
function envelopeRefusal(httpStatus: number, body: unknown, dataset: string): string | null {
  if (httpStatus !== 200) {
    return `the analytics API answered HTTP ${httpStatus}, so ${dataset} was not read`;
  }
  const b = body as { errors?: unknown } | null;
  const errors = b && typeof b === "object" ? b.errors : undefined;
  if (Array.isArray(errors) && errors.length > 0) {
    // QUOTED, not summarised. This is the branch the `outcome` fault lived in for
    // the whole life of the bar, and the one thing that would have named it in one
    // reading is the API's own sentence.
    const said = errors
      .map((e) => (e && typeof e === "object" ? String((e as { message?: unknown }).message ?? e) : String(e)))
      .join("; ");
    return `the analytics API refused the ${dataset} query: ${said}`;
  }
  return null;
}

function rowsOf(body: unknown, field: string): unknown[] | null {
  const rows = (
    body as {
      data?: { viewer?: { accounts?: Record<string, unknown>[] } };
    } | null
  )?.data?.viewer?.accounts?.[0]?.[field];
  return Array.isArray(rows) ? (rows as unknown[]) : null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Read the invocations window. Every failure carries its own sentence. */
export function readInvocationsResponse(
  httpStatus: number,
  body: unknown,
): ReadResult<InvocationsReading> {
  const refused = envelopeRefusal(httpStatus, body, "invocations");
  if (refused) return { ok: false, why: refused };
  const rows = rowsOf(body, "workersInvocationsAdaptive");
  if (rows === null) {
    return {
      ok: false,
      why: "the analytics API answered with something that is not an invocations listing",
    };
  }
  if (rows.length === 0) {
    // Distinct from every refusal above: the query WORKED and the window is empty.
    // That is never a pass, because a run that made requests cannot have an empty
    // window, but it sends somebody somewhere different from a refused query.
    return {
      ok: false,
      why: "the analytics API returned no invocation rows for the window",
    };
  }
  const statuses: Record<string, number> = {};
  let invocations = 0;
  let subrequests = 0;
  let cpuUs = 0;
  for (const r of rows as {
    sum?: { requests?: number; subrequests?: number };
    quantiles?: { cpuTimeP99?: number };
    dimensions?: { status?: string };
  }[]) {
    const n = num(r.sum?.requests);
    const name = r.dimensions?.status ?? "(unnamed)";
    invocations += n;
    subrequests += num(r.sum?.subrequests);
    statuses[name] = (statuses[name] ?? 0) + n;
    // The worst p99 across the grouped rows. The API reports a quantile per group
    // and they cannot be averaged into one.
    cpuUs = Math.max(cpuUs, num(r.quantiles?.cpuTimeP99));
  }
  // MICROSECONDS, not milliseconds. A reading a thousand times too small sits
  // comfortably under every budget (docs/cloudflare-platform-notes.md).
  return { ok: true, reading: { invocations, subrequests, cpuMsP99: cpuUs / 1000, statuses } };
}

/**
 * Read the scheduled window.
 *
 * An EMPTY list is a reading of zero rather than a refusal, and the difference
 * matters: zero crons in the window is what makes the adaptive percentile request
 * only, and therefore the one case where a per request CPU budget can honestly be
 * applied.
 */
export function readScheduledResponse(
  httpStatus: number,
  body: unknown,
): ReadResult<ScheduledReading> {
  const refused = envelopeRefusal(httpStatus, body, "scheduled invocations");
  if (refused) return { ok: false, why: refused };
  const rows = rowsOf(body, "workersInvocationsScheduled");
  if (rows === null) {
    return {
      ok: false,
      why: "the analytics API answered with something that is not a scheduled invocation listing",
    };
  }
  const byCron: Record<string, { invocations: number; worstCpuMs: number }> = {};
  let worstCpuMs = 0;
  for (const r of rows as { cpuTimeUs?: number; cron?: string }[]) {
    const ms = num(r.cpuTimeUs) / 1000;
    const cron = r.cron ?? "(unnamed)";
    const seen = (byCron[cron] ??= { invocations: 0, worstCpuMs: 0 });
    seen.invocations += 1;
    seen.worstCpuMs = Math.max(seen.worstCpuMs, ms);
    worstCpuMs = Math.max(worstCpuMs, ms);
  }
  return { ok: true, reading: { invocations: rows.length, worstCpuMs, byCron } };
}

/** Why a poll stopped or continued. Each is its own outcome, never a bare boolean. */
export const POLL_REASON = {
  /** No reading at all yet. */
  nothingYet: "nothing-yet",
  /** A reading arrived and is still well under what the run itself made. */
  stillClimbing: "still-climbing",
  /** The count reached the run's own request count. */
  caughtUp: "caught-up",
  /** Time ran out. NOT the same as catching up, and must never read as one (L98). */
  deadline: "deadline",
} as const;

export type PollReason = (typeof POLL_REASON)[keyof typeof POLL_REASON];

/**
 * The share of the run's own requests the analytics must report before the window
 * is treated as settled. The judge applies its own, stricter control afterwards;
 * this only decides when to stop waiting.
 */
export const POLL_SETTLED_SHARE = 0.95;

/**
 * Whether to read again.
 *
 * The clock is a PARAMETER. Nothing here sleeps and nothing reads `Date.now`, so
 * every case is driven in a test without waiting for real time (L524, L290).
 */
export function shouldPollAgain(args: {
  invocations: number | null;
  expected: number;
  elapsedMs: number;
  deadlineMs: number;
}): { again: boolean; reason: PollReason } {
  const { invocations, expected, elapsedMs, deadlineMs } = args;
  if (invocations !== null && invocations >= expected * POLL_SETTLED_SHARE) {
    return { again: false, reason: POLL_REASON.caughtUp };
  }
  // The deadline is checked AFTER catching up, so a poll that succeeded on its
  // last attempt reports success rather than expiry.
  if (elapsedMs > deadlineMs) return { again: false, reason: POLL_REASON.deadline };
  return {
    again: true,
    reason: invocations === null ? POLL_REASON.nothingYet : POLL_REASON.stillClimbing,
  };
}

/**
 * The scheduled invocation CPU ceiling, mirroring `limits.cpu_ms` in wrangler.jsonc.
 *
 * Written here and held against the real config by
 * scripts/test-loadtest-platform-reading.ts, so the two cannot drift apart (L41): a
 * judge carrying a stale ceiling would either pass a lane that is being killed or
 * fail one that is fine.
 */
export const WRANGLER_CRON_CPU_MS = 120_000;

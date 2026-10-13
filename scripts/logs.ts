// Read Slate's production Worker logs without walking into the traps (#807).
//
//   node --experimental-strip-types --import ./scripts/register-paths.mjs \
//     scripts/logs.ts "tag=booking-api" [--minutes 60 | --from <iso> --to <iso>] \
//     [--lines] [--slice-minutes 60] [--control "tag=recompute"]
//
// Counts by default; `--lines` also PRINTS each matching line (UTC timestamp, level or a
// dash, text) through the API's events view (#3664). Every request covers at most one hour,
// and a wider window is read one hour at a time and merged, because one wide query silently
// drops rows (#3299). The output says how many slices it read.
//
// Exit: 0 found, 1 trustworthy absence, 2 UNVERIFIABLE (the query itself is broken, or it
// was refused), 3 found but the printed list is incomplete (fewer lines listed than counted,
// or a slice filled the request limit), so the list must not be read as every line.
//
// THE TOKEN. A read only Workers Observability API token, stored in `.env.local` at the
// checkout root as `CLOUDFLARE_LOGS_READ_TOKEN=<token>` (or `CLOUDFLARE_API_TOKEN` set in the
// shell for one run). Never `CLOUDFLARE_API_TOKEN` in `.env.local`: wrangler reads that file
// too and would sign every `wrangler tail` and deploy in with this read only token. The tool
// reads only that one name from the file and never prints the token, not even inside an API
// error. To create it (once, by a person, in the Cloudflare dashboard):
//   1. dash.cloudflare.com, My Profile, API Tokens, Create Token, Create Custom Token.
//   2. Name it "Slate logs read only (<which Mac>)".
//   3. Permissions: Account, Workers Observability, Read. Nothing else.
//   4. Account Resources: Include, Pennie. Then Continue to summary, Create Token.
//   5. Copy the token into `.env.local` as above. It is shown once.
//   6. Check it: `logs.ts "tag=recompute" --minutes 60` must exit 0 (PRESENT).
// docs/cloudflare-platform-notes.md has the same steps beside the rest of the log traps.
//
// WHY THIS EXISTS. Querying these logs keeps returning zero rows from data that
// is really there, and a zero looks exactly like an outage. It has produced a
// confidently wrong answer twice: #708 concluded Cloudflare drops console.error
// (it does not), and the canary that "proved" it then concluded Cloudflare drops
// console.log (it does not either: #801 emitted 250 lines and got 250 back).
//
// Both were the same mistake, so this tool refuses to make it: it NEVER reports a
// zero without first proving, in the same window, that the query can find a line
// that is definitely there. If the control comes back empty, the answer is
// "unverifiable", not "absent".
//
// The query shapes that silently return nothing, all of them learned the hard way
// and each one encoded below:
//   - the `events` view throws a schema error on app log rows (they carry no
//     $workers.outcome, only invocation records do), so count via `calculations`
//   - `$metadata.message` / `$metadata.level` hold ONLY invocation records
//   - console.log lands with NO `level`, so ANY level filter or group-by hides it
//   - a `groupBys` on level returns an empty aggregation even when a level filter
//     matches those same rows
//   - a window in the future returns zero
//   - ingestion lag is usually a minute or two and CAN BE HOURS (#1533): measured
//     three hours behind on 2026-08-17, which is why the control must prove the
//     window's recent END and not merely the window. For anything within the last
//     few hours, `npx wrangler tail` is the accurate instrument.
//
// One trap above needs a boundary drawn on it: the events-view schema error is the
// MCP TOOL's validation, not the API's. A `view: "events"` query sent straight to the
// API returned app log rows normally on 2026-08-17, with the line in `source.message`.
// This tool still COUNTS via `calculations`, which also gives it the per-bucket series
// the freshness rule reads, and `--lines` lists through the raw events view. The verdict
// always comes from the controlled count, never from the length of a listing.
import { readFileSync } from "node:fs";
import { isEntryPoint } from "./lib/run-alerter.ts";
import { parseEnvFile } from "./smoke-env.ts";

/** The Worker whose logs we read, and the account it lives in. */
const SERVICE = "slate";
const ACCOUNT_ID = "3e7f907a9c19e51417873e2cce4fbc5c";

/**
 * The standing positive control: the recompute cron lane emits this line every
 * minute, so it is ALWAYS present in any window of a healthy deploy. If a query
 * cannot find this, the query is wrong (bad window, bad credentials, wrong field)
 * and any other zero it returns means nothing.
 *
 * Every server line is now `slate tag=<subsystem> ...` (#808), so this is a tag
 * match rather than a prose substring, and searching is the same shape:
 * `logs.ts "tag=booking-api"`. Source: src/app/api/cron/recompute/route.ts.
 */
export const CONTROL_NEEDLE = "tag=recompute";

/** Cloudflare's ingestion lag. A window ending inside it undercounts. */
const INGESTION_LAG_MS = 2 * 60_000;

export interface CountQuery {
  view: "calculations";
  queryId: string;
  dry: false;
  parameters: {
    datasets: string[];
    filterCombination: "and";
    filters: { id: string; key: string; operation: string; type: string; value: string }[];
    calculations: { alias: string; operator: string }[];
    groupBys: never[];
    havings: never[];
  };
  /** Unix MILLISECONDS. Verified against the live API: it 400s on ISO strings,
   *  even though the Cloudflare MCP tool accepts them. */
  timeframe: { from: number; to: number };
}

/**
 * The one query shape that actually works: count rows whose bare `message`
 * contains the needle. No level filter, no group-by, no events view. See the
 * header for why each of those returns a false zero.
 */
export function buildCountQuery(input: {
  needle: string;
  fromIso: string;
  toIso: string;
  service?: string;
}): CountQuery {
  return {
    view: "calculations",
    queryId: "slate-log-count",
    dry: false,
    parameters: {
      datasets: ["cloudflare-workers"],
      filterCombination: "and",
      filters: [
        {
          id: "1",
          key: "$metadata.service",
          operation: "eq",
          type: "string",
          value: input.service ?? SERVICE,
        },
        // The BARE `message` field. $metadata.message holds only invocation records.
        { id: "2", key: "message", operation: "includes", type: "string", value: input.needle },
      ],
      calculations: [{ alias: "n", operator: "count" }],
      groupBys: [],
      havings: [],
    },
    timeframe: { from: Date.parse(input.fromIso), to: Date.parse(input.toIso) },
  };
}

/**
 * Pull the count out of the observability response. Pinned to the shape the live
 * API returns (`result.calculations[0].aggregates[0].value`).
 *
 * THROWS on a shape it does not recognize, rather than defaulting to 0. A parser
 * that quietly yields 0 when Cloudflare changes the payload would manufacture the
 * exact false absence this whole tool exists to prevent, and it would do it
 * silently, forever.
 */
export function countFromResponse(body: unknown): number {
  const value = (
    body as {
      result?: { calculations?: { aggregates?: { value?: number }[] }[] };
    }
  )?.result?.calculations?.[0]?.aggregates?.[0]?.value;
  if (typeof value !== "number") {
    throw new Error(
      "observability response did not match the expected shape (result.calculations[0].aggregates[0].value). " +
        "Refusing to report 0, which would be a false absence. The API payload has probably changed.",
    );
  }
  return value;
}

/**
 * The time of the newest bucket that actually CARRIES data, or null (#1533).
 *
 * This is the pipeline's frontier: how recent the data a query can see actually is, as
 * opposed to how recent the window asked for. The `calculations` view returns a `series`
 * with one entry per bucket and an EMPTY `data` array for a bucket it has nothing for, so
 * the last non-empty bucket answers it without needing the events view.
 *
 * Returns null rather than a guess for every shape it cannot read (no series, no non-empty
 * bucket, an unparseable time), because the caller maps null to the fail-safe side. A guess
 * here would restore exactly the false confidence the frontier exists to remove, and an
 * unparseable time must never reach a comparison as NaN, which compares false against every
 * threshold and lands on the permissive side (L50).
 */
export function newestBucketMsFromResponse(body: unknown): number | null {
  const series = (
    body as {
      result?: { calculations?: { series?: { time?: string; data?: unknown[] }[] }[] };
    }
  )?.result?.calculations?.[0]?.series;
  if (!Array.isArray(series)) return null;
  let newest: number | null = null;
  for (const bucket of series) {
    if (!Array.isArray(bucket?.data) || bucket.data.length === 0) continue;
    // The API returns bucket times without a zone; they are UTC.
    const raw = typeof bucket.time === "string" ? bucket.time : "";
    const ms = Date.parse(/[Zz]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`);
    if (!Number.isFinite(ms)) continue;
    if (newest === null || ms > newest) newest = ms;
  }
  return newest;
}

export interface WindowCheck {
  fromIso: string;
  toIso: string;
  /** The window ends inside the ingestion lag, so counts may undercount. */
  lagWarning: boolean;
}

/** Reject the windows that silently return zero, rather than reporting their emptiness. */
export function assertWindowSane(input: {
  fromIso: string;
  toIso: string;
  nowMs: number;
}): WindowCheck {
  const fromMs = Date.parse(input.fromIso);
  const toMs = Date.parse(input.toIso);
  if (isNaN(fromMs) || isNaN(toMs)) throw new Error("window: unparseable timestamp");
  if (fromMs >= toMs) throw new Error("window: `from` is not before `to`");
  if (toMs > input.nowMs) {
    throw new Error(
      "window: ends in the FUTURE. Observability returns zero rows for a future window, which looks exactly like an outage. Check `date -u`.",
    );
  }
  return {
    fromIso: input.fromIso,
    toIso: input.toIso,
    lagWarning: input.nowMs - toMs < INGESTION_LAG_MS,
  };
}

export interface Judgement {
  verdict: "present" | "absent" | "unverifiable";
  trustworthy: boolean;
  needleCount: number;
  controlCount: number;
  /** Why, in words. Each cause is its own sentence: they need different actions (L11). */
  reason: string;
  /**
   * How far behind the window's end the control's newest line is, when that is BOTH known
   * and past `CONTROL_FRESHNESS_MS`. Present on a warned absence so a caller can see the
   * caveat as a value rather than having to parse it out of the prose (#1535).
   */
  staleControlMinutes?: number;
}

/**
 * How far behind the window's end the control's newest line may be before an ABSENCE
 * stops being vouchable (#1533).
 *
 * Deliberately generous. `INGESTION_LAG_MS` above describes the ordinary couple of
 * minutes; this is the point past which the pipeline is not merely lagging but is behind
 * enough that a period of interest can sit entirely inside the gap. Measured on
 * 2026-08-17 the lag reached roughly three hours, so a bound in minutes is the honest
 * one: anything larger and the tool goes back to vouching for silence it cannot see.
 */
export const CONTROL_FRESHNESS_MS = 15 * 60_000;

/**
 * WARN or ENFORCE on a stale control. Deliberately WARN for now (#1535).
 *
 * The 15 minutes above is a judgement, not a measurement, and it could not be calibrated
 * when it was written: Cloudflare's pipeline was not merely lagging but STUCK, frozen at
 * 14:00 UTC and still frozen 216 minutes later, so there was no normal to measure against.
 * Shipping the refusal straight away would have made its first live run also its first
 * enforcing run, against a threshold nobody has checked, which is the shape that has
 * already caused an outage here once (L56).
 *
 * So an absence during a lag is still REPORTED as an absence, and the staleness rides
 * along as a loud warning and a field on the verdict. That direction is the riskier one
 * for correctness, which is the point of saying so plainly: the whole reason this tool
 * exists is that a wrong "absent" is believed. It is temporary on purpose, and #1535 is
 * the issue that measures the normal lag and flips this to "enforce", so the observe-only
 * state cannot become invisible once the reason for it is forgotten (L65).
 */
export const CONTROL_FRESHNESS_MODE: "warn" | "enforce" = "warn";

/**
 * The rule this tool exists for, in two halves.
 *
 * FIRST, a result is only believable if the positive control found something in the SAME
 * window. A dead control means the query, window or credentials are wrong, so it poisons
 * every answer, including a non-zero one.
 *
 * SECOND (#1533), an ABSENCE additionally needs the control to prove the query can see the
 * RECENT END of that window. The count-only rule was satisfied by a control line from
 * hours earlier: on 2026-08-17, asking at 16:19 whether `tag=rate-limit` appeared around
 * 14:44 returned needle 0 and control 101 and was scored a trustworthy absence, while
 * Cloudflare's pipeline was about three hours behind and `wrangler tail` could see lines
 * the API reported zero of. The control was working the whole time; what it could not do
 * is prove the query reached the part of the window in question.
 *
 * A HIT is deliberately still trustworthy during a lag: the rows it counted exist, and
 * only the claim "there were none" depends on recency. Poisoning successful searches too
 * would make the tool cry wolf on every hit during a lag, which is how a guard stops being
 * read (L36).
 *
 * `controlNewestMs` null means the frontier could not be established, which is mapped to
 * the fail-safe side rather than assumed fresh.
 */
export function judge(input: {
  needleCount: number;
  controlCount: number;
  controlNewestMs?: number | null;
  windowEndMs?: number;
  /**
   * Overrides `CONTROL_FRESHNESS_MODE`. It exists so BOTH outcomes are exercised by the
   * test suite whichever one is currently shipping: the enforce branch is dormant today,
   * and a branch nobody constructs can be unreachable while the guard reads as thoroughly
   * tested (L151). Production never passes this.
   */
  freshnessMode?: "warn" | "enforce";
}): Judgement {
  const base = { needleCount: input.needleCount, controlCount: input.controlCount };
  if (input.controlCount === 0) {
    return {
      ...base,
      verdict: "unverifiable",
      trustworthy: false,
      reason:
        "the positive control found NOTHING in this window, so the query itself could not " +
        "answer (wrong window, wrong field, wrong credentials). Fix the query; this says " +
        "nothing about whether the needle is there.",
    };
  }

  if (input.needleCount > 0) {
    return {
      ...base,
      verdict: "present",
      trustworthy: true,
      reason: `found ${input.needleCount} matching line(s).`,
    };
  }

  // Only an absence needs the recent end proven.
  if (input.windowEndMs !== undefined) {
    const newest = input.controlNewestMs;
    if (newest === null || newest === undefined) {
      return {
        ...base,
        verdict: "unverifiable",
        trustworthy: false,
        reason:
          "the control was found but HOW RECENT it is could not be established, so an " +
          "absence cannot be vouched for. Re-run, or read the live stream with " +
          "`npx wrangler tail`.",
      };
    }
    const lagMs = input.windowEndMs - newest;
    if (lagMs > CONTROL_FRESHNESS_MS) {
      const mins = Math.round(lagMs / 60_000);
      const behind =
        `the query works, but it is running BEHIND: the control's newest line is ${mins} ` +
        "minutes older than the end of the window, so the recent part of this window " +
        "holds nothing queryable yet and an absence there means nothing. Read the live " +
        "stream with `npx wrangler tail` before believing this.";
      if ((input.freshnessMode ?? CONTROL_FRESHNESS_MODE) === "enforce") {
        return { ...base, verdict: "unverifiable", trustworthy: false, reason: behind };
      }
      // Warn mode (#1535). The absence is still reported, and the caveat travels with it
      // as both prose and a field, so it cannot be lost by a caller that reads only one.
      return {
        ...base,
        verdict: "absent",
        trustworthy: true,
        staleControlMinutes: mins,
        reason: `no matching line, BUT ${behind}`,
      };
    }
  }

  return {
    ...base,
    verdict: "absent",
    trustworthy: true,
    reason: "no matching line, with a live control whose newest data reaches this window's end.",
  };
}

/** grep-like, with a DISTINCT code for "do not trust me" so a caller cannot
 *  mistake a broken query for a clean zero. */
export function exitCodeFor(j: Judgement): 0 | 1 | 2 {
  if (!j.trustworthy) return 2;
  return j.verdict === "present" ? 0 : 1;
}

/** One query's answer: how many, and how recent the newest data the query could SEE is. */
export interface QueryResult {
  count: number;
  /** The pipeline's frontier for this query, or null when it could not be read (#1533). */
  newestMs: number | null;
}

/** Injectable HTTP boundary, so the core above is testable with a fake. */
export type QueryFn = (q: CountQuery) => Promise<QueryResult>;

/** Count the needle AND the control in the same window, then judge. */
export async function search(input: {
  needle: string;
  control: string;
  fromIso: string;
  toIso: string;
  query: QueryFn;
}): Promise<Judgement> {
  const [needle, control] = await Promise.all([
    input.query(buildCountQuery({ needle: input.needle, fromIso: input.fromIso, toIso: input.toIso })),
    input.query(buildCountQuery({ needle: input.control, fromIso: input.fromIso, toIso: input.toIso })),
  ]);
  // The CONTROL's frontier decides recency, never the needle's: a needle with no matches
  // has no frontier at all, and that is precisely the case being judged (#1533).
  return judge({
    needleCount: needle.count,
    controlCount: control.count,
    controlNewestMs: control.newestMs,
    windowEndMs: Date.parse(input.toIso),
  });
}

// ---------------------------------------------------------------------------------------
// Narrow windows (#3299). A single query over a WIDE window silently returns an incomplete
// set: on 2026-10-05, `tag=booking-reminder msg="cycle"` over 25 hours came back as 26 rows
// from the events view, and as 287 (12 an hour) when the same question was asked one hour
// at a time. An investigation reading the wide answer reads the missing rows as absence.
// So every request this tool sends covers at most `SLICE_MS`, for counting and for printing,
// and the results are merged.
// ---------------------------------------------------------------------------------------

/** The widest single request: the size #3299 measured as complete. Narrower is allowed. */
export const SLICE_MS = 60 * 60_000;

/** Cloudflare keeps Workers logs for 7 days, so older slices could only ever read empty. */
export const MAX_WINDOW_MS = 7 * 24 * 60 * 60_000;

export interface Slice {
  fromIso: string;
  toIso: string;
}

/**
 * Split a window into contiguous slices of at most `sliceMs`, the last one short when the
 * window is not a whole number of slices. Each slice starts exactly where the previous one
 * ended, so nothing falls between them. A slice wider than `SLICE_MS` is REFUSED rather than
 * honoured, because that is the size known to drop rows.
 */
export function sliceWindow(input: { fromIso: string; toIso: string; sliceMs?: number }): Slice[] {
  const sliceMs = input.sliceMs ?? SLICE_MS;
  if (!Number.isFinite(sliceMs) || sliceMs <= 0) {
    throw new Error("slice: must be a positive number of minutes");
  }
  if (sliceMs > SLICE_MS) {
    throw new Error(
      `slice: ${Math.round(sliceMs / 60_000)} minutes is wider than the ${SLICE_MS / 60_000} minute ` +
        "slice measured as complete (#3299); a wider query silently drops rows.",
    );
  }
  const fromMs = Date.parse(input.fromIso);
  const toMs = Date.parse(input.toIso);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) throw new Error("window: unparseable timestamp");
  if (fromMs >= toMs) throw new Error("window: `from` is not before `to`");
  if (toMs - fromMs > MAX_WINDOW_MS) {
    throw new Error(
      "window: longer than the 7 days Cloudflare keeps Workers logs, so its oldest part could only ever read as empty.",
    );
  }
  const slices: Slice[] = [];
  for (let start = fromMs; start < toMs; start += sliceMs) {
    slices.push({
      fromIso: new Date(start).toISOString(),
      toIso: new Date(Math.min(start + sliceMs, toMs)).toISOString(),
    });
  }
  return slices;
}

/** A judgement over several slices, carrying how many there were and how many could not be checked. */
export interface MergedJudgement extends Judgement {
  slices: number;
  unverifiedSlices: number;
}

/**
 * Merge per slice judgements into one, keeping the control rule PER SLICE.
 *
 * - A hit in a slice whose control is live is a real hit, whatever another slice says, so
 *   any such slice makes the window present. When some other slice could not be checked the
 *   count is called a floor, because lines there may be missing.
 * - An ABSENCE over the window needs every slice to be a trustworthy absence. One slice
 *   whose control found nothing (or whose recency could not be read) leaves a stretch of the
 *   window nobody could see into, so the whole absence is unverifiable.
 * - A stale control warning survives the merge as the largest lag any slice saw.
 */
export function mergeJudgements(judgements: Judgement[]): MergedJudgement {
  if (judgements.length === 0) throw new Error("merge: no slices to merge");
  const n = judgements.length;
  const unverified = judgements.filter((j) => !j.trustworthy);
  const stale = judgements
    .map((j) => j.staleControlMinutes)
    .filter((m): m is number => m !== undefined);
  const staleControlMinutes = stale.length > 0 ? Math.max(...stale) : undefined;
  const base = {
    needleCount: judgements.reduce((s, j) => s + j.needleCount, 0),
    controlCount: judgements.reduce((s, j) => s + j.controlCount, 0),
    slices: n,
    unverifiedSlices: unverified.length,
    ...(staleControlMinutes !== undefined ? { staleControlMinutes } : {}),
  };
  if (n === 1) return { ...judgements[0], slices: 1, unverifiedSlices: unverified.length };

  const hits = judgements.filter((j) => j.trustworthy && j.verdict === "present");
  if (hits.length > 0) {
    const trusted = hits.reduce((s, j) => s + j.needleCount, 0);
    return {
      ...base,
      verdict: "present",
      trustworthy: true,
      reason:
        unverified.length === 0
          ? `found ${base.needleCount} matching line(s) across ${n} slices.`
          : `found at least ${trusted} matching line(s); ${unverified.length} of ${n} slices could ` +
            "not be checked (their control found nothing, or its recency could not be read), so " +
            "lines there may be missing.",
    };
  }
  if (unverified.length > 0) {
    return {
      ...base,
      verdict: "unverifiable",
      trustworthy: false,
      reason:
        `${unverified.length} of ${n} slices could not be checked, so an absence over the whole ` +
        `window cannot be vouched for. The first of them: ${unverified[0].reason}`,
    };
  }
  const staleOne = judgements.find(
    (j) => staleControlMinutes !== undefined && j.staleControlMinutes === staleControlMinutes,
  );
  return {
    ...base,
    verdict: "absent",
    trustworthy: true,
    reason: staleOne
      ? `no matching line in any of ${n} slices, BUT in one of them ${staleOne.reason.replace(/^no matching line, BUT /, "")}`
      : `no matching line in any of ${n} slices, each with a live control whose newest data reaches that slice's end.`,
  };
}

export interface SliceCount extends Slice {
  judgement: Judgement;
}

/** Count needle and control in EACH slice (the control over exactly that slice), then merge. */
export async function searchSliced(input: {
  needle: string;
  control: string;
  fromIso: string;
  toIso: string;
  query: QueryFn;
  sliceMs?: number;
}): Promise<{ slices: SliceCount[]; judgement: MergedJudgement }> {
  const slices: SliceCount[] = [];
  // One slice at a time: a 7 day window is 168 slices, and firing them all at once is how a
  // read only tool earns a rate limit refusal in the middle of an investigation.
  for (const s of sliceWindow(input)) {
    slices.push({ ...s, judgement: await search({ ...input, fromIso: s.fromIso, toIso: s.toIso }) });
  }
  return { slices, judgement: mergeJudgements(slices.map((s) => s.judgement)) };
}

// ---------------------------------------------------------------------------------------
// Printing the lines (#3664). The `events` view, sent straight to the API, returns app log
// rows with the line in `source.message`; only the MCP tool's own validation breaks on them.
// ---------------------------------------------------------------------------------------

/** The most rows one events request returns. A slice that fills it may have been cut off. */
export const EVENTS_LIMIT = 2000;

export interface EventsQuery {
  view: "events";
  queryId: string;
  dry: false;
  limit: number;
  parameters: CountQuery["parameters"];
  timeframe: { from: number; to: number };
}

/** The same filters as the count (bare `message`, no level), asking for the rows themselves. */
export function buildEventsQuery(input: {
  needle: string;
  fromIso: string;
  toIso: string;
  service?: string;
  limit?: number;
}): EventsQuery {
  const count = buildCountQuery(input);
  return {
    view: "events",
    queryId: "slate-log-lines",
    dry: false,
    limit: input.limit ?? EVENTS_LIMIT,
    parameters: { ...count.parameters, calculations: [] },
    timeframe: count.timeframe,
  };
}

export interface LogLine {
  id: string | null;
  timestampMs: number | null;
  /** null for a console.log line, which Cloudflare stores with no level. Never invented. */
  level: string | null;
  /** null when the event carried no readable text: kept and printed as such, never dropped. */
  message: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function eventToLine(raw: unknown): LogLine {
  const ev = (raw ?? {}) as {
    $metadata?: { id?: unknown; level?: unknown; message?: unknown };
    timestamp?: unknown;
    source?: unknown;
  };
  const source = ev.source as { message?: unknown; level?: unknown } | string | undefined;
  const message =
    typeof source === "string" ? source : (str(source?.message) ?? str(ev.$metadata?.message));
  const ts = typeof ev.timestamp === "number" ? ev.timestamp : Date.parse(str(ev.timestamp) ?? "");
  return {
    id: str(ev.$metadata?.id),
    timestampMs: Number.isFinite(ts) ? ts : null,
    level: str(ev.$metadata?.level) ?? (typeof source === "object" ? str(source?.level) : null),
    message,
  };
}

/**
 * The lines out of an events response (`result.events.events`). THROWS when there is no
 * events list at all, for the reason `countFromResponse` does: a parser that read a changed
 * payload as "no lines" would manufacture the false absence this tool exists to prevent.
 */
export function linesFromResponse(body: unknown): LogLine[] {
  const events = (body as { result?: { events?: { events?: unknown } } })?.result?.events?.events;
  if (!Array.isArray(events)) {
    throw new Error(
      "observability response did not match the expected shape (result.events.events). " +
        "Refusing to report no lines, which would be a false absence. The API payload has probably changed.",
    );
  }
  return events.map(eventToLine);
}

/** One printed line: UTC timestamp, level (a dash when there is none), text. */
export function formatLine(line: LogLine): string {
  const when = line.timestampMs === null ? "(no timestamp)" : new Date(line.timestampMs).toISOString();
  const text =
    line.message ?? "(the line text could not be read from this event; the payload shape may have changed)";
  return `${when}  ${line.level ?? "-"}  ${text}`;
}

export type EventsFn = (q: EventsQuery) => Promise<LogLine[]>;

export interface IncompleteSlice extends Slice {
  reason: string;
}

/**
 * Count AND list each slice, merge, and say where the listing is not the whole set.
 *
 * The verdict still comes from the controlled COUNT, never from the length of the list: a
 * short list is exactly the #3299 failure, and reading it as the complete set would repeat
 * it. A slice is incomplete when it listed fewer lines than it counted, when it filled the
 * request limit (so it may hold more), or when an event's text could not be read.
 */
export async function listLines(input: {
  needle: string;
  control: string;
  fromIso: string;
  toIso: string;
  query: QueryFn;
  events: EventsFn;
  sliceMs?: number;
  limit?: number;
}): Promise<{
  slices: SliceCount[];
  judgement: MergedJudgement;
  lines: LogLine[];
  incomplete: IncompleteSlice[];
}> {
  const limit = input.limit ?? EVENTS_LIMIT;
  const slices: SliceCount[] = [];
  const incomplete: IncompleteSlice[] = [];
  const seen = new Set<string>();
  const lines: LogLine[] = [];
  for (const s of sliceWindow(input)) {
    const [judgement, listed] = await Promise.all([
      search({ ...input, fromIso: s.fromIso, toIso: s.toIso }),
      input.events(buildEventsQuery({ needle: input.needle, fromIso: s.fromIso, toIso: s.toIso, limit })),
    ]);
    slices.push({ ...s, judgement });
    const reasons: string[] = [];
    if (listed.length >= limit) {
      reasons.push(
        `listed ${listed.length} lines, the most one request returns, so this slice may hold more; ` +
          "re-run with a narrower --slice-minutes",
      );
    } else if (listed.length < judgement.needleCount) {
      reasons.push(
        `listed ${listed.length} of ${judgement.needleCount} counted lines, so ` +
          `${judgement.needleCount - listed.length} are missing from what is printed`,
      );
    }
    const unreadable = listed.filter((l) => l.message === null).length;
    if (unreadable > 0) reasons.push(`${unreadable} line(s) carried no readable text`);
    if (reasons.length > 0) incomplete.push({ ...s, reason: reasons.join("; ") });
    for (const line of listed) {
      // Adjacent slices share a boundary instant, so a row stamped exactly on it can come
      // back from both. Its id says it is one row.
      if (line.id !== null) {
        if (seen.has(line.id)) continue;
        seen.add(line.id);
      }
      lines.push(line);
    }
  }
  lines.sort((a, b) => (a.timestampMs ?? Infinity) - (b.timestampMs ?? Infinity));
  return { slices, judgement: mergeJudgements(slices.map((s) => s.judgement)), lines, incomplete };
}

// ---------------------------------------------------------------------------------------
// The token. Read by NAME from the environment or `.env.local`, and never printed: every
// line this tool writes passes through `redact`, including an API error body, which is
// text somebody else wrote and could echo whatever was sent.
// ---------------------------------------------------------------------------------------

/**
 * The name the logs token is stored under in `.env.local`, and deliberately NOT
 * `CLOUDFLARE_API_TOKEN`. Wrangler 4 loads `.env` AND `.env.local` into its own environment
 * on every command (`getDefaultEnvFiles`, read in wrangler 4.127.1 on 2026-10-13) and
 * authenticates with `CLOUDFLARE_API_TOKEN` whenever it is set, so a read only token stored
 * in the checkout under that name would replace the OAuth login for every `wrangler tail`
 * and deploy run there, and they would fail on permissions this token does not have.
 */
export const TOKEN_ENV = "CLOUDFLARE_LOGS_READ_TOKEN";

/** Still honoured from the SHELL, where this tool always documented it. Never read from the file. */
export const SHELL_TOKEN_ENV = "CLOUDFLARE_API_TOKEN";

/**
 * The token: `TOKEN_ENV` from the environment, then `SHELL_TOKEN_ENV` from the environment,
 * then `TOKEN_ENV` from the `.env.local` text. Blank is absent.
 */
export function resolveToken(io: {
  env: Record<string, string | undefined>;
  readFile: () => string | null;
}): string | null {
  const fromEnv = io.env[TOKEN_ENV]?.trim() || io.env[SHELL_TOKEN_ENV]?.trim();
  if (fromEnv) return fromEnv;
  const content = io.readFile();
  if (content === null) return null;
  // Only the one name is taken out of the file; nothing else in it reaches this process.
  const fromFile = parseEnvFile(content)[TOKEN_ENV]?.trim();
  return fromFile ? fromFile : null;
}

export function redact(text: string, secret: string | null): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}

export const TOKEN_MISSING =
  `${TOKEN_ENV} is not set in .env.local or the environment (nor ${SHELL_TOKEN_ENV} in the ` +
  "environment), so nothing was queried. " +
  "It needs a read only Workers Observability token; the steps to create one and where to " +
  "put it are in docs/cloudflare-platform-notes.md (Reading production logs).";

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Count and list against Cloudflare's observability API, with the fetch injectable. */
export function cloudflareClient(token: string, fetchFn: FetchFn = fetch): { count: QueryFn; events: EventsFn } {
  const post = async (q: CountQuery | EventsQuery): Promise<unknown> => {
    const res = await fetchFn(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/observability/telemetry/query`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(q),
      },
    );
    if (!res.ok) {
      const body = redact(await res.text(), token).slice(0, 500);
      throw new Error(`observability query failed: HTTP ${res.status} ${body}`);
    }
    return res.json();
  };
  return {
    // One parse, two readings: the count (which THROWS on an unrecognised shape rather than
    // defaulting to 0) and the frontier (null, which the caller maps to the fail-safe side).
    count: async (q) => {
      const body = await post(q);
      return { count: countFromResponse(body), newestMs: newestBucketMsFromResponse(body) };
    },
    events: async (q) => linesFromResponse(await post(q)),
  };
}

export interface RunIo {
  env: Record<string, string | undefined>;
  /** The `.env.local` text, or null when there is no such file. */
  readFile: () => string | null;
  nowMs: number;
  out: (line: string) => void;
  err: (line: string) => void;
  fetch: FetchFn;
}

const USAGE =
  'usage: logs.ts "<needle>" [--minutes 60 | --from <iso> --to <iso>] [--lines] ' +
  '[--slice-minutes 60] [--control "<line>"]';

/**
 * The command. Exit codes: 0 found, 1 trustworthy absence, 2 UNVERIFIABLE or refused, 3
 * found but the printed list is incomplete. Every line it writes passes through `redact`.
 */
export async function run(argv: string[], io: RunIo): Promise<number> {
  let token: string | null = null;
  const out = (l: string) => io.out(redact(l, token));
  const err = (l: string) => io.err(redact(l, token));
  try {
    return await runChecked(argv, io, out, err, (t) => {
      token = t;
    });
  } catch (e) {
    err(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

async function runChecked(
  argv: string[],
  io: RunIo,
  out: (l: string) => void,
  err: (l: string) => void,
  setToken: (t: string) => void,
): Promise<number> {
  const VALUED = new Set(["minutes", "control", "from", "to", "slice-minutes"]);
  const flags = new Map<string, string>();
  let lines = false;
  let needle: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--lines") lines = true;
    else if (a.startsWith("--") && VALUED.has(a.slice(2)) && argv[i + 1] !== undefined) {
      flags.set(a.slice(2), argv[++i]);
    } else if (a.startsWith("--")) {
      err(`unknown or incomplete option ${a}\n${USAGE}`);
      return 2;
    } else if (needle === undefined) needle = a;
    else {
      err(`more than one needle given ("${needle}", "${a}"); quote a needle that has spaces\n${USAGE}`);
      return 2;
    }
  }
  if (!needle) {
    err(USAGE);
    return 2;
  }
  const minutesOf = (name: string, fallback: string): number => {
    const v = Number(flags.get(name) ?? fallback);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`--${name} must be a positive number of minutes`);
    return v;
  };
  const minutes = minutesOf("minutes", "60");
  const sliceMs = minutesOf("slice-minutes", String(SLICE_MS / 60_000)) * 60_000;
  const isoOf = (name: string): string | undefined => {
    const v = flags.get(name);
    if (v === undefined) return undefined;
    const ms = Date.parse(v);
    if (!Number.isFinite(ms)) throw new Error(`--${name} is not a readable timestamp: ${v}`);
    return new Date(ms).toISOString();
  };
  const toIso = isoOf("to") ?? new Date(io.nowMs).toISOString();
  const fromIso = isoOf("from") ?? new Date(Date.parse(toIso) - minutes * 60_000).toISOString();
  const control = flags.get("control") ?? CONTROL_NEEDLE;

  // Every refusal about the window comes BEFORE the token and before any request.
  const win = assertWindowSane({ fromIso, toIso, nowMs: io.nowMs });
  const slices = sliceWindow({ fromIso, toIso, sliceMs });

  const token = resolveToken({ env: io.env, readFile: io.readFile });
  if (!token) {
    err(TOKEN_MISSING);
    return 2;
  }
  setToken(token);

  if (win.lagWarning) {
    err("note: this window ends now, and ingestion lags 1-2 minutes, so recent lines may not have landed yet.");
  }
  err(
    `note: ${fromIso} to ${toIso} is read as ${slices.length} ${slices.length === 1 ? "slice" : "slices"} ` +
      `of at most ${sliceMs / 60_000} minutes, because one wide query silently drops rows (#3299); ` +
      "counts are summed and lines merged across them.",
  );

  const client = cloudflareClient(token, io.fetch);
  const result = lines
    ? await listLines({ needle, control, fromIso, toIso, query: client.count, events: client.events, sliceMs })
    : {
        ...(await searchSliced({ needle, control, fromIso, toIso, query: client.count, sliceMs })),
        lines: [] as LogLine[],
        incomplete: [] as IncompleteSlice[],
      };
  const j = result.judgement;

  if (result.slices.length > 1) {
    for (const s of result.slices) {
      const flag = s.judgement.trustworthy ? "" : "  (could not be checked)";
      err(`  ${s.fromIso} to ${s.toIso}: needle ${s.judgement.needleCount}, control ${s.judgement.controlCount}${flag}`);
    }
  }
  for (const line of result.lines) out(formatLine(line));

  if (!j.trustworthy) {
    // The REASON comes from judge, not from a second copy of the wording here: there is more
    // than one way to be unverifiable (a dead control, a control alive but behind, a slice
    // nobody could see into), and they need different actions (L11).
    err(
      `UNVERIFIABLE (control "${control}", ${j.controlCount} line(s)): ${j.reason}\n` +
        `Do NOT read the needle count (${j.needleCount}) as absence.`,
    );
    return exitCodeFor(j);
  }
  if (j.staleControlMinutes !== undefined) {
    // stderr, and before the verdict, so it is seen even when stdout is piped somewhere and
    // even when only the last line is read.
    err(
      `WARNING: the log data is ${j.staleControlMinutes} minutes behind the end of a slice, ` +
        "so this result does NOT cover its recent part. Do not read it as an absence there; " +
        "use `npx wrangler tail` for anything recent. (#1535 will turn this into a refusal " +
        "once the normal lag has been measured.)",
    );
  }
  if (result.incomplete.length > 0) {
    err(
      `WARNING: the printed list is incomplete in ${result.incomplete.length} of ${result.slices.length} ` +
        "slice(s); do not read it as every matching line:",
    );
    for (const s of result.incomplete) err(`  ${s.fromIso} to ${s.toIso}: ${s.reason}`);
  }
  out(`${j.verdict.toUpperCase()}: "${needle}" matched ${j.needleCount} line(s) between ${fromIso} and ${toIso}.`);
  out(`control ("${control}") matched ${j.controlCount}: ${j.reason}`);
  if (lines && j.verdict === "absent" && result.lines.length > 0) {
    // The listing found rows the count did not. The rows are real, so they win.
    out(`note: the count found none, but the listing printed ${result.lines.length} line(s) above; read those.`);
    return 0;
  }
  if (result.incomplete.length > 0) return 3;
  return exitCodeFor(j);
}

/** `.env.local` at the checkout root, or null when there is none. Any other read error is loud. */
function readEnvLocal(): string | null {
  try {
    return readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function main(): Promise<void> {
  const code = await run(process.argv.slice(2), {
    env: process.env,
    readFile: readEnvLocal,
    nowMs: Date.now(),
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    fetch,
  });
  process.exit(code);
}

if (isEntryPoint(import.meta.url)) {
  await main();
}

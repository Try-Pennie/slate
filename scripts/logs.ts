// Read Slate's production Worker logs without walking into the traps (#807).
//
//   CLOUDFLARE_API_TOKEN=... node --experimental-strip-types --import ./scripts/register-paths.mjs \
//     scripts/logs.ts "tag=booking-api" [--minutes 60] [--control "tag=recompute"]
//
// Exit: 0 found, 1 trustworthy absence, 2 UNVERIFIABLE (the query itself is broken).
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
// This tool still counts via `calculations`, which also gives it the per-bucket series
// the freshness rule reads.
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

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
      return {
        ...base,
        verdict: "unverifiable",
        trustworthy: false,
        reason:
          `the query works, but it is running BEHIND: the control's newest line is ${mins} ` +
          "minutes older than the end of the window, so the recent part of this window " +
          "holds nothing queryable yet and an absence there means nothing. Wait for " +
          "ingestion to catch up, or read the live stream with `npx wrangler tail`.",
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

/** Run one count against Cloudflare's observability API. */
export const cloudflareCount =
  (token: string): QueryFn =>
  async (q: CountQuery): Promise<QueryResult> => {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/observability/telemetry/query`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(q),
      },
    );
    if (!res.ok) {
      throw new Error(`observability query failed: HTTP ${res.status} ${await res.text()}`);
    }
    // One parse, two readings: the count (which THROWS on an unrecognised shape rather
    // than defaulting to 0) and the frontier (which returns null, because the caller maps
    // null to the fail-safe side).
    const body = await res.json();
    return { count: countFromResponse(body), newestMs: newestBucketMsFromResponse(body) };
  };

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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const needle = argv.find((a) => !a.startsWith("--"));
  if (!needle) {
    console.error('usage: logs.ts "<needle>" [--minutes 60] [--control "<line>"]');
    process.exit(2);
  }
  const flag = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    console.error("CLOUDFLARE_API_TOKEN is not set (needs Workers Observability read).");
    process.exit(2);
  }

  const minutes = Number(flag("minutes", "60"));
  const control = flag("control", CONTROL_NEEDLE);
  const nowMs = Date.now();
  const win = assertWindowSane({
    fromIso: new Date(nowMs - minutes * 60_000).toISOString(),
    toIso: new Date(nowMs).toISOString(),
    nowMs,
  });
  if (win.lagWarning) {
    console.warn(
      "note: this window ends now, and ingestion lags 1-2 minutes, so recent lines may not have landed yet.",
    );
  }

  const j = await search({
    needle,
    control,
    fromIso: win.fromIso,
    toIso: win.toIso,
    query: cloudflareCount(token),
  });

  if (!j.trustworthy) {
    // The REASON comes from judge, not from a second copy of the wording here: there is
    // more than one way to be unverifiable now (a dead control, and a control that is
    // alive but behind), and they need different actions. Printing one canned cause for
    // both would send the reader to fix a query that is working (L11).
    console.error(
      `UNVERIFIABLE (control "${control}", ${j.controlCount} line(s)): ${j.reason}\n` +
        `Do NOT read the needle count (${j.needleCount}) as absence.`,
    );
    process.exit(exitCodeFor(j));
  }

  console.log(
    `${j.verdict.toUpperCase()}: "${needle}" matched ${j.needleCount} line(s) between ${win.fromIso} and ${win.toIso}.`,
  );
  console.log(`control ("${control}") matched ${j.controlCount}: ${j.reason}`);
  process.exit(exitCodeFor(j));
}

if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}

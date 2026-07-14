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
//   - a window in the future returns zero, and ingestion lags a minute or two
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
}

/**
 * The rule this tool exists for: a result is only believable if the positive
 * control found something in the SAME window. A dead control means the query,
 * window or credentials are wrong, so it poisons every answer, including a
 * non-zero one.
 */
export function judge(input: { needleCount: number; controlCount: number }): Judgement {
  const base = { needleCount: input.needleCount, controlCount: input.controlCount };
  if (input.controlCount === 0) {
    return { ...base, verdict: "unverifiable", trustworthy: false };
  }
  return input.needleCount > 0
    ? { ...base, verdict: "present", trustworthy: true }
    : { ...base, verdict: "absent", trustworthy: true };
}

/** grep-like, with a DISTINCT code for "do not trust me" so a caller cannot
 *  mistake a broken query for a clean zero. */
export function exitCodeFor(j: Judgement): 0 | 1 | 2 {
  if (!j.trustworthy) return 2;
  return j.verdict === "present" ? 0 : 1;
}

/** Injectable HTTP boundary, so the core above is testable with a fake. */
export type QueryFn = (q: CountQuery) => Promise<number>;

/** Run one count against Cloudflare's observability API. */
export const cloudflareCount =
  (token: string): QueryFn =>
  async (q: CountQuery): Promise<number> => {
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
    return countFromResponse(await res.json());
  };

/** Count the needle AND the control in the same window, then judge. */
export async function search(input: {
  needle: string;
  control: string;
  fromIso: string;
  toIso: string;
  query: QueryFn;
}): Promise<Judgement> {
  const [needleCount, controlCount] = await Promise.all([
    input.query(buildCountQuery({ needle: input.needle, fromIso: input.fromIso, toIso: input.toIso })),
    input.query(buildCountQuery({ needle: input.control, fromIso: input.fromIso, toIso: input.toIso })),
  ]);
  return judge({ needleCount, controlCount });
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
    console.error(
      `UNVERIFIABLE: the positive control ("${control}") returned 0 rows in this window, so this query cannot find\n` +
        `a line that is definitely there. Do NOT read the needle count (${j.needleCount}) as absence: the query,\n` +
        "window, or credentials are wrong. (Is the deploy live? Is the window in the past? Is the token scoped\n" +
        "to Workers Observability read?)",
    );
    process.exit(exitCodeFor(j));
  }

  console.log(
    `${j.verdict.toUpperCase()}: "${needle}" matched ${j.needleCount} line(s) between ${win.fromIso} and ${win.toIso}.`,
  );
  console.log(`control ("${control}") matched ${j.controlCount}, so this result is trustworthy.`);
  process.exit(exitCodeFor(j));
}

if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}

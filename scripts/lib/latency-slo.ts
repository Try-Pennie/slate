/**
 * The canary's latency verdict (#1047), pure.
 *
 * The canary proves the funnel WORKS. It says nothing about whether it is fast, and
 * the one latency number anybody quotes (a warm availability read at about 39ms, #256)
 * is a point-in-time measurement from the day the precompute shipped. So a latency
 * regression relies on somebody noticing a page feels slow, which for a lead who
 * abandons is nobody.
 *
 * The design decisions here are about not creating a flapping alert, because an alert
 * that cries wolf gets ignored (L36) and a latency check is the classic source of one:
 *
 *   - it judges the MEDIAN of several samples, not one request. A single cold isolate,
 *     or one unlucky sample, is not a regression.
 *   - the first sample is DISCARDED, always. The first request to a Worker after an
 *     idle period pays isolate startup, and measuring that measures how quiet the
 *     morning was rather than how fast the endpoint is.
 *   - the threshold is deliberately far above the measured warm number. This is a
 *     regression detector, not a performance target: at 39ms warm, a 500ms median
 *     means something structural changed (a cache miss on every read, a live Google
 *     call that should not be there), not that a datacenter was busy.
 *   - a slow run served ENTIRELY from Cloudflare colos outside North America does not
 *     page (#3712). The runner is sometimes routed through London or Dublin, where
 *     Slate has no warm isolate or cached slot entry and every database read crosses
 *     the Atlantic, so the run timed a route no lead takes.
 */
import { NORTH_AMERICA_COLOS, OTHER_COLOS } from "./cloudflare-colos.ts";

/** Samples to take. Enough that the median is not one request, few enough to be free. */
export const LATENCY_SAMPLES = 5;

/**
 * The median that counts as a regression, in milliseconds.
 *
 * An order of magnitude above the ~39ms warm read, on purpose. What this catches is a
 * cache-first read that has stopped being cache-first, which is the failure that
 * matters and which shows up as hundreds of milliseconds, not tens.
 */
export const AVAILABILITY_P50_BUDGET_MS = 500;

export interface LatencyVerdict {
  /** The median of the kept samples, or null when there was nothing to judge. */
  medianMs: number | null;
  /** True only when a median was measured AND it exceeded the budget. */
  regressed: boolean;
  /** One sentence for the failure log, or null when there is nothing to say. */
  message: string | null;
  /** The samples judged: the cold first one dropped, unusable ones left out. */
  kept: LatencySample[];
}

/**
 * Which tier answered a read, as the route's `x-slot-cache` header says (#257/#234):
 * `hit` the edge cache, `miss` the stored row, `nostore` a cold live compute.
 */
export type SlotCacheOutcome = "hit" | "miss" | "nostore";

/**
 * The Worker's own account of a read, from its `Server-Timing` (#3653). Each field is
 * null when the header did not carry it, never 0, so "not reported" cannot print as a
 * measured zero. The Worker's clock advances only at I/O, so these are I/O waits and
 * leave out CPU after the last I/O (see src/lib/api/server-timing.ts).
 */
export interface ServerTiming {
  workerMs: number | null;
  limitMs: number | null;
  slotsMs: number | null;
  /** #3713: the parts of the slot read. Each is null when that part did not run. */
  cacheMs: number | null;
  hoursMs: number | null;
  rowMs: number | null;
  computeMs: number | null;
  fallbackMs: number | null;
}

/**
 * Which Cloudflare data centre served a read, from its `cf-ray` (#3712). A missing
 * header and one whose colo cannot be read are kept apart, because they send a reader
 * to different places: one to whatever stripped the header, one to its new shape.
 */
export type ColoReading =
  | { kind: "read"; code: string }
  | { kind: "absent" }
  | { kind: "unreadable" };

/** One timed read: the wait at the canary, and what the response said about itself. */
export interface LatencySample {
  ms: number;
  /** Null when the response carried no readable `x-slot-cache`. */
  cache: SlotCacheOutcome | null;
  /** Null when the response carried no `Server-Timing` entry the route writes. */
  server: ServerTiming | null;
  /** The colo that served it (#3712). */
  colo: ColoReading;
}

/** A bare number is a sample whose response said nothing about itself. */
function toSample(v: number | LatencySample): LatencySample {
  return typeof v === "number" ? { ms: v, cache: null, server: null, colo: { kind: "absent" } } : v;
}

/** The shape of a colo code: the IATA code Cloudflare names a data centre by. */
const COLO_CODE = /^[A-Z]{3,4}$/;

/**
 * Read the colo out of a `cf-ray` header (`8c1a2b3c4d5e6f70-LHR`). The same suffix the
 * route reads for its own log line (`requestColo` in src/app/api/availability/route.ts),
 * copied because this runs on bare node (the app reads it through `coloFromRay`,
 * src/lib/http/cf-ray.ts).
 */
export function readColo(header: string | null): ColoReading {
  if (header === null) return { kind: "absent" };
  const m = /-([A-Z]{3,4})$/.exec(header.trim());
  return m ? { kind: "read", code: m[1]! } : { kind: "unreadable" };
}

/**
 * Where a read was served, for the paging decision (#3712):
 *
 *  - `north-america`  a colo on that list: a lead's route, judged as always.
 *  - `outside`        a colo on the other list: a route no lead takes.
 *  - `unrecognised`   a code on neither list, possibly a colo opened since the snapshot.
 *  - `unknown`        no colo could be read at all.
 *
 * Only `outside` changes anything; the other three are judged exactly as before #3712,
 * so a gap in the table or a missing header can only cost a page, never hide one.
 */
export type ColoRegion = "north-america" | "outside" | "unrecognised" | "unknown";

export function coloRegion(c: ColoReading): ColoRegion {
  if (c.kind !== "read" || !COLO_CODE.test(c.code)) return "unknown";
  if (NORTH_AMERICA_COLOS.has(c.code)) return "north-america";
  if (OTHER_COLOS.has(c.code)) return "outside";
  return "unrecognised";
}

/** A colo as a reader names it: `London (LHR)`, or the bare code when it is not listed. */
function coloName(code: string): string {
  const city = NORTH_AMERICA_COLOS.get(code) ?? OTHER_COLOS.get(code);
  return city ? `${city} (${code})` : code;
}

/** The colo as the log line prints it. */
function coloLabel(c: ColoReading): string {
  if (c.kind === "read") return c.code;
  return c.kind === "absent" ? "nocfray" : "cfray-unreadable";
}

/** `a`, `a and b`, `a, b and c`. */
function listWords(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * Where the reads behind a page were served, in the reader's words (#3712). Only ever
 * part of a page, so it says what was seen and leaves the verdict to the sentence it
 * sits in.
 */
function coloSentence(samples: LatencySample[]): string {
  if (samples.length === 0) return "";
  const NOT_LISTED = "not on the canary's colo list (scripts/lib/cloudflare-colos.ts), so judged as before";
  // Each group says where its reads came from, worded to follow a count ("5 came ...").
  const counts = new Map<string, number>();
  for (const x of samples) {
    const where =
      x.colo.kind === "absent"
        ? "with no cf-ray header"
        : x.colo.kind === "unreadable"
          ? "with a cf-ray naming no colo that could be read"
          : coloRegion(x.colo) === "north-america" || coloRegion(x.colo) === "outside"
            ? `from ${coloName(x.colo.code)}`
            : `from ${x.colo.code}, ${NOT_LISTED}`;
    counts.set(where, (counts.get(where) ?? 0) + 1);
  }
  if (counts.size === 1) {
    const only = samples[0]!.colo;
    if (only.kind === "absent") return "No response carried a cf-ray header, so which colo served the reads is unknown.";
    if (only.kind === "unreadable") return "No response's cf-ray named a colo that could be read, so where the reads were served is unknown.";
    const region = coloRegion(only);
    return region === "north-america" || region === "outside"
      ? `Every read was served from ${coloName(only.code)}.`
      : `Every read was served from ${only.code}, ${NOT_LISTED}.`;
  }
  const parts = [...counts].map(([where, n]) => `${n} came ${where}`);
  const outside = samples.filter((x) => coloRegion(x.colo) === "outside").length;
  const note =
    outside > 0
      ? ` The ${outside} through a colo outside North America took a route no lead uses; the rest did not, so the run is judged as it stands.`
      : "";
  return `Of the ${samples.length} reads, ${listWords(parts)}.${note}`;
}

/** True only when there was evidence and ALL of it came from outside North America. */
function allOutside(samples: LatencySample[]): boolean {
  return samples.length > 0 && samples.every((x) => coloRegion(x.colo) === "outside");
}

/** The distinct colos, by name, in the order first seen. */
function coloNames(samples: LatencySample[]): string[] {
  return [...new Set(samples.flatMap((x) => (x.colo.kind === "read" ? [x.colo.code] : [])))].map(coloName);
}

/** Read `x-slot-cache`. Anything the route does not send is unknown, never a guessed hit. */
export function readSlotCache(header: string | null): SlotCacheOutcome | null {
  const v = header?.trim().toLowerCase();
  return v === "hit" || v === "miss" || v === "nostore" ? v : null;
}

/**
 * The entry names the route writes. A COPY of `SERVER_TIMING_NAMES` in
 * src/lib/api/server-timing.ts, because this file runs on bare node and may import
 * nothing outside scripts/; scripts/test-server-timing.ts drives both and fails if
 * they disagree in either direction.
 */
export const CANARY_TIMING_NAMES: ReadonlyMap<string, keyof ServerTiming> = new Map([
  ["worker", "workerMs"],
  ["limit", "limitMs"],
  ["slots", "slotsMs"],
  ["cache", "cacheMs"],
  ["hours", "hoursMs"],
  ["row", "rowMs"],
  ["compute", "computeMs"],
  ["fallback", "fallbackMs"],
]);

/** The slot read's parts, in the order a read reaches them, with the word the log prints. */
const SLOT_PARTS: ReadonlyArray<readonly [keyof ServerTiming, string]> = [
  ["cacheMs", "cache"],
  ["hoursMs", "hours"],
  ["rowMs", "row"],
  ["computeMs", "compute"],
  ["fallbackMs", "fallback"],
];

/** What each part is called in a page, where the log line's word would be cryptic. */
const SLOT_PART_WORDS: Readonly<Record<string, string>> = {
  cache: "edge cache",
  hours: "business hours",
  row: "stored row",
  compute: "live compute",
  fallback: "lower tiers",
};

/** Split on commas outside double quotes: a `desc="a,b"` must not split an entry. */
function splitOutsideQuotes(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (ch === sep && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Read the route's entries out of a `Server-Timing` header, ignoring any other entry
 * (Cloudflare can add its own). Null when none of the route's entries is readable, so
 * a response without one reads as not measured.
 */
export function parseServerTiming(header: string | null): ServerTiming | null {
  if (!header) return null;
  const t: ServerTiming = {
    workerMs: null,
    limitMs: null,
    slotsMs: null,
    cacheMs: null,
    hoursMs: null,
    rowMs: null,
    computeMs: null,
    fallbackMs: null,
  };
  let found = false;
  for (const entry of splitOutsideQuotes(header, ",")) {
    const [rawName, ...params] = splitOutsideQuotes(entry, ";").map((p) => p.trim());
    // A Map, so a name like `constructor` cannot match an inherited property.
    const field = CANARY_TIMING_NAMES.get(rawName ?? "");
    if (!field) continue;
    // Digits only, which also rules out a negative or non-finite value: `Number("")`
    // is 0, so an empty `dur=` would otherwise read as a measured 0ms, the healthy
    // side of every comparison downstream (L50).
    const dur = params.find((p) => /^dur=/i.test(p))?.slice(4).trim() ?? "";
    if (!/^\d+(\.\d+)?$/.test(dur)) continue;
    t[field] = Number(dur);
    found = true;
  }
  return found ? t : null;
}

/** How the reads over budget were served, from their `x-slot-cache`. */
export interface SlowReadCache {
  /**
   *  - `misses`   more than half the slow reads were not served from the edge cache
   *  - `hits`     more than half were edge cache hits
   *  - `mixed`    neither is a majority (unread ones count against both)
   *  - `unknown`  no slow read carried the header
   */
  kind: "misses" | "hits" | "mixed" | "unknown";
  over: number;
  hits: number;
  /** Served from the stored row (`miss`). */
  rows: number;
  /** Computed live (`nostore`). */
  computed: number;
  unread: number;
}

/**
 * Classify the reads OVER budget, not all of them. On 2026-10-12 a batch held 120ms
 * reads beside 1.2s ones, and a fast hit says nothing about where a slow read's time
 * went. When nothing is over budget (which a regressed median cannot produce) every
 * kept read is classified instead, so the counts are never of an empty set.
 */
export function classifySlowReads(kept: LatencySample[], budgetMs: number): SlowReadCache {
  const overBudget = kept.filter((x) => x.ms > budgetMs);
  const set = overBudget.length > 0 ? overBudget : kept;
  const hits = set.filter((x) => x.cache === "hit").length;
  const rows = set.filter((x) => x.cache === "miss").length;
  const computed = set.filter((x) => x.cache === "nostore").length;
  const unread = set.length - hits - rows - computed;
  const over = set.length;
  const kind =
    unread === over
      ? "unknown"
      : (rows + computed) * 2 > over
        ? "misses"
        : hits * 2 > over
          ? "hits"
          : "mixed";
  return { kind, over, hits, rows, computed, unread };
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The cache half of the cause: what the slow reads' headers said, and nothing more. */
function cacheSentence(c: SlowReadCache): string {
  const ofOver = (n: number) => `${n} of ${c.over} ${plural(c.over, "read", "reads")} over budget ${plural(n, "was", "were")}`;
  switch (c.kind) {
    case "unknown":
      return (
        "The responses carried no x-slot-cache header, so this check could not tell whether the " +
        "slow reads were served from the cache."
      );
    case "misses": {
      // A stored row read is the designed second tier, not a broken cache, so this names
      // the tier and the database read behind it rather than claiming the cache stopped.
      const tiers = [
        c.rows > 0 ? `${c.rows} from the stored row in the database` : null,
        c.computed > 0 ? `${c.computed} computed live` : null,
      ].filter((p): p is string => p !== null);
      return (
        `${ofOver(c.rows + c.computed)} not served from the edge cache (${tiers.join(", ")}), so the time ` +
        "went to the read behind the edge cache: look at how long the database read took, and at why the " +
        "edge cache did not hold these times."
      );
    }
    case "hits":
      return (
        `${ofOver(c.hits)} ${plural(c.hits, "an edge cache hit", "edge cache hits")}, so the cache was serving ` +
        "and the time went elsewhere: the Worker, the burst limiter or the network between the runner and the edge."
      );
    case "mixed": {
      const parts = [
        `${c.hits} cache ${plural(c.hits, "hit", "hits")}`,
        `${c.rows + c.computed} ${plural(c.rows + c.computed, "miss", "misses")}`,
        c.unread > 0 ? `${c.unread} without the header` : null,
      ].filter((p): p is string => p !== null);
      return (
        `The ${c.over} reads over budget were split (${parts.join(", ")}), so neither the cache nor ` +
        "the path around it is ruled out."
      );
    }
  }
}

/** The Worker half of the cause: its own clock against the canary's, on the slow reads. */
function serverSentence(slow: LatencySample[]): string {
  const timed = slow.filter((x) => x.server?.workerMs !== null && x.server?.workerMs !== undefined);
  if (timed.length === 0) {
    return "No Server-Timing came back, so the Worker's time and transit cannot be told apart.";
  }
  const client = median(timed.map((x) => x.ms))!;
  const worker = median(timed.map((x) => x.server!.workerMs!))!;
  const of = `The Worker's own clock read a median ${ms(worker)} of their ${ms(client)}`;
  if (worker * 2 >= client) {
    const med = (field: keyof ServerTiming) =>
      median(timed.flatMap((x) => (x.server![field] === null ? [] : [x.server![field]!])));
    const limit = med("limitMs");
    const slots = med("slotsMs");
    // #3713: the slot read's parts, where the route sent them, so the page names the
    // read inside it that waited. Medians over the reads that ran that part.
    const parts = SLOT_PARTS.flatMap(([field, word]) => {
      const m = med(field);
      return m === null ? [] : [`${SLOT_PART_WORDS[word] ?? word} ${ms(m)}`];
    });
    const split = [
      limit === null ? null : `burst limiter ${ms(limit)}`,
      slots === null ? null : `slot read ${ms(slots)}${parts.length ? `: ${parts.join(", ")}` : ""}`,
    ].filter((p): p is string => p !== null);
    return `${of}${split.length ? ` (${split.join(", ")})` : ""}, so the wait was inside the Worker.`;
  }
  return (
    `${of}, so most of the wait was outside it: transit between the runner and the edge, or CPU, ` +
    "which that clock does not count."
  );
}

/**
 * Why a slow batch was slow, worded only from what its responses said (#3653).
 *
 * This replaces a sentence that told the reader to "look for a read that has stopped
 * being served from the cache" on every page, which on 2026-10-12 sent them to a cache
 * that had served 8 of 10 reads (L11). One builder, so the single batch, recheck and
 * confirmed messages cannot drift into three ways of saying it.
 */
export function latencyCause(kept: LatencySample[], budgetMs: number = AVAILABILITY_P50_BUDGET_MS): string {
  const c = classifySlowReads(kept, budgetMs);
  const overBudget = kept.filter((x) => x.ms > budgetMs);
  return `${cacheSentence(c)} ${serverSentence(overBudget.length > 0 ? overBudget : kept)}`;
}

/**
 * The `samples=[...]` detail of the canary's log line: each read's wait, its cache
 * outcome (`nohdr` when the header was absent), the colo that served it (`nocfray` with
 * no cf-ray, `cfray-unreadable` when it had no colo, #3712) and, when sent, the Worker's
 * own time with its split, the slot read's parts after it (#3713). Printed for every
 * run, so #3652 can be answered from the log history.
 */
export function formatSamples(samples: LatencySample[]): string {
  return samples
    .map((x) => {
      const t = x.server;
      const fields: ReadonlyArray<readonly [keyof ServerTiming, string]> = [["limitMs", "limit"], ["slotsMs", "slots"], ...SLOT_PARTS];
      const split = t
        ? fields
            .flatMap(([field, word]) => (t[field] === null ? [] : [`${word}=${Math.round(t[field]!)}`]))
            .join(",")
        : "";
      const worker = t && t.workerMs !== null ? ` worker=${Math.round(t.workerMs)}${split ? `(${split})` : ""}` : "";
      return `${Math.round(x.ms)} ${x.cache ?? "nohdr"} ${coloLabel(x.colo)}${worker}`;
    })
    .join(", ");
}

/** The middle value, or the mean of the two middles. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Judge a run's samples.
 *
 * `samples` is in the order they were taken; the first is dropped as the cold one.
 *
 * A run with nothing to judge reports `regressed: false` and SAYS so in the message
 * rather than silently passing: "measured nothing" and "measured a healthy number"
 * must not look the same to the reader (L98). It is not a failure, because a canary
 * that could not reach the endpoint at all already fails on the availability check
 * itself, and failing twice for one cause is how an alert stops naming its cause.
 */
export function judgeLatency(
  samples: ReadonlyArray<number | LatencySample>,
  budgetMs: number = AVAILABILITY_P50_BUDGET_MS,
): LatencyVerdict {
  const kept = samples
    .slice(1)
    .map(toSample)
    .filter((x) => Number.isFinite(x.ms) && x.ms >= 0);
  const medianMs = median(kept.map((x) => x.ms));
  if (medianMs === null) {
    return {
      medianMs: null,
      regressed: false,
      message:
        "latency was not measured this run (no usable samples), so this pass says nothing about it",
      kept,
    };
  }
  if (medianMs > budgetMs) {
    return {
      medianMs,
      regressed: true,
      message:
        `availability read median ${Math.round(medianMs)}ms over ${kept.length} samples, past the ` +
        `${budgetMs}ms budget, an order of magnitude above the warm cached read. ${latencyCause(kept, budgetMs)}`,
      kept,
    };
  }
  return { medianMs, regressed: false, message: null, kept };
}

/**
 * How long to wait before re-measuring a batch that came in over budget (#2811).
 *
 * Measured, not chosen: 590 canary runs from 2026-09-11 to 2026-09-26 went over budget
 * 10 times, and the NEXT run after every one of them read between 38ms and 204ms. The
 * slow stretches inside those runs span a few seconds (one batch's five requests), so a
 * two minute pause outlasts every one on record while keeping the job far inside its
 * 15 minute timeout. It is paid only on the rare over-budget batch, never on a healthy run.
 */
export const LATENCY_RECHECK_DELAY_MS = 2 * 60_000;

/**
 * What one canary pass concluded about latency, after any recheck.
 *
 *  - `not-measured`        the first batch had nothing to judge. Not a page, and not a
 *                          measured reading either, so it stamps no verdict (#1700).
 *  - `healthy`             the first batch was inside the budget.
 *  - `passing-blip`        over budget, then inside it on the recheck. Logged, not paged.
 *  - `confirmed`           over budget on both batches. Pages.
 *  - `recheck-unmeasured`  over budget, and the recheck got no usable readings. Pages,
 *                          because the only thing known is that the read was slow.
 *  - `outside-north-america`  would have been `confirmed` or `recheck-unmeasured`, but
 *                          EVERY read it rests on was served from a colo outside North
 *                          America (#3712). Not a page, and not a measured reading
 *                          either: it timed a route no lead takes, so it stamps no
 *                          verdict, and a canary that keeps being routed through Europe
 *                          goes stale and pages through #1700 rather than reading as
 *                          healthy. A run with even one North American, unrecognised or
 *                          unreadable read in that evidence is judged as before.
 *
 * A HEALTHY run through Europe still counts as healthy and measured, as it did before
 * #3712. Whether a fast reading taken there should stamp the verdict is a separate
 * question from whether a slow one should page, and nothing has measured it; the log
 * line names the colo on every sample, so it can be answered from the history.
 */
export type LatencyRunKind =
  | "not-measured"
  | "healthy"
  | "passing-blip"
  | "confirmed"
  | "recheck-unmeasured"
  | "outside-north-america";

export interface LatencyRun {
  kind: LatencyRunKind;
  /** True when this pass must page. */
  page: boolean;
  /** True when a real median was read, pass or fail: the #1700 verdict stamp. */
  measured: boolean;
  /** One sentence for the log, and for the failure log when `page` is true. */
  message: string | null;
  first: LatencyVerdict;
  recheck: LatencyVerdict | null;
}

export interface LatencyRunDeps {
  /** Take one batch of `LATENCY_SAMPLES` timed reads, in order, errors left out. A bare
   *  number is a read whose response said nothing about its cache or its timing. */
  takeBatch: () => Promise<ReadonlyArray<number | LatencySample>>;
  /** Injected so a test never waits for real (L524). */
  sleep: (ms: number) => Promise<void>;
  budgetMs?: number;
  recheckDelayMs?: number;
}

const ms = (n: number | null) => `${Math.round(n ?? 0)}ms`;

/**
 * Measure, and re-measure once before paging (#2811).
 *
 * One slow batch paged on its own before this, and in the whole recorded history that
 * was never the start of a real regression. A cache-first read that has stopped being
 * cache-first is slow on EVERY read, so it is slow on the recheck too and still pages
 * in the same run.
 */
export async function measureLatency(deps: LatencyRunDeps): Promise<LatencyRun> {
  const budgetMs = deps.budgetMs ?? AVAILABILITY_P50_BUDGET_MS;
  const delayMs = deps.recheckDelayMs ?? LATENCY_RECHECK_DELAY_MS;
  const first = judgeLatency(await deps.takeBatch(), budgetMs);
  if (first.medianMs === null) {
    return { kind: "not-measured", page: false, measured: false, message: first.message, first, recheck: null };
  }
  if (!first.regressed) {
    return { kind: "healthy", page: false, measured: true, message: null, first, recheck: null };
  }
  await deps.sleep(delayMs);
  const recheck = judgeLatency(await deps.takeBatch(), budgetMs);
  const wait = `${Math.round(delayMs / 60_000)} minutes`;
  if (recheck.medianMs === null) {
    if (allOutside(first.kept)) {
      return outsideNorthAmerica(
        first,
        recheck,
        `availability read median ${ms(first.medianMs)} was past the ${budgetMs}ms budget and could not be ` +
          `re-measured ${wait} later`,
        first.kept,
      );
    }
    return {
      kind: "recheck-unmeasured",
      page: true,
      measured: true,
      message:
        `availability read median ${ms(first.medianMs)}, past the ${budgetMs}ms budget, and it could not be ` +
        `re-measured ${wait} later (no usable readings), so it cannot be ruled a passing blip. ` +
        `${latencyCause(first.kept, budgetMs)} ${coloSentence(first.kept)} Check too whether the endpoint is answering at all.`,
      first,
      recheck,
    };
  }
  if (!recheck.regressed) {
    return {
      kind: "passing-blip",
      page: false,
      measured: true,
      message:
        `availability read median ${ms(first.medianMs)} was past the ${budgetMs}ms budget, and ` +
        `${ms(recheck.medianMs)} on a recheck ${wait} later, so it was a slow minute and nobody is paged.`,
      first,
      recheck,
    };
  }
  const evidence = [...first.kept, ...recheck.kept];
  if (allOutside(evidence)) {
    return outsideNorthAmerica(
      first,
      recheck,
      `availability read median ${ms(first.medianMs)}, and ${ms(recheck.medianMs)} again on a recheck ${wait} ` +
        `later, both past the ${budgetMs}ms budget`,
      evidence,
    );
  }
  return {
    kind: "confirmed",
    page: true,
    measured: true,
    message:
      `availability read median ${ms(first.medianMs)}, and ${ms(recheck.medianMs)} again on a recheck ${wait} ` +
      `later, both past the ${budgetMs}ms budget, an order of magnitude above the warm cached read. ` +
      `${latencyCause(evidence, budgetMs)} ${coloSentence(evidence)}`,
    first,
    recheck,
  };
}

/**
 * The skipped run (#3712): what was slow, where every read went, and why that is not a
 * lead's wait. Kept as the run's message so the log says it was skipped and why, rather
 * than the run passing in silence (L98).
 */
function outsideNorthAmerica(
  first: LatencyVerdict,
  recheck: LatencyVerdict,
  whatWasSlow: string,
  evidence: LatencySample[],
): LatencyRun {
  return {
    kind: "outside-north-america",
    page: false,
    measured: false,
    message:
      `${whatWasSlow}, but every read was routed through ${listWords(coloNames(evidence))}, outside North ` +
      "America, which no lead uses. That timed the runner's route to Cloudflare, not a lead's wait. " +
      "Nobody is paged, and this run does not count as a latency verdict.",
    first,
    recheck,
  };
}

/** The verdict for one canary pass that probed a real bucket AND the SMOKE bucket. */
export interface DualLatencyDecision {
  /** True when this pass must page (a confirmed REAL-bucket regression). */
  page: boolean;
  /** True when the REAL bucket read a median, pass or fail: the #1700 verdict stamp. */
  measured: boolean;
  /** One sentence for the log, and for the failure log when `page` is true. */
  message: string | null;
}

/**
 * Combine a full REAL-bucket run with a one-batch SMOKE reading into the pass's
 * verdict (#3586).
 *
 * The SMOKE bucket is the one the canary books and cancels on every pass, so its slot
 * cache is churned and a cold SMOKE read can be slow while a real lead is unaffected
 * (2026-10-10: a ~3 minute SMOKE blip paged as a production slowdown). So paging and the
 * verdict stamp follow the REAL bucket, whose cache the canary never touches and which
 * is what a lead actually reads; the SMOKE reading is kept only as a comparison in the
 * log, so a churned-test-cache blip is visible but never pages.
 *
 * The REAL bucket drives `measured` too: if it read no median (a renamed bucket code, or
 * the endpoint not answering), this pass stamps nothing, so the `verdict:availability-latency`
 * heartbeat goes stale and pages through the #1700 net rather than a dead real probe
 * reading as a healthy morning (L557). The SMOKE reading never rescues that: it is not
 * the signal being protected.
 */
export function decideDualLatency(
  real: LatencyRun,
  smoke: LatencyVerdict,
  realBucket: string,
): DualLatencyDecision {
  const smokeNote =
    smoke.medianMs === null
      ? "SMOKE bucket not measured"
      : `SMOKE bucket median ${Math.round(smoke.medianMs)}ms`;
  // Every message names the REAL bucket it is about: it is the subject of the page now,
  // so "availability read median Nms" without a bucket, next to only a SMOKE note, would
  // read as if SMOKE were what regressed.
  const realNote = `real bucket ${realBucket}`;
  if (real.page) {
    return {
      page: true,
      measured: real.measured,
      message: real.message ? `${real.message} (${realNote}; ${smokeNote})` : `${realNote}; ${smokeNote}`,
    };
  }
  if (!real.measured) {
    // The production signal measured nothing; no page this pass, and no stamp, so a
    // persistently broken real probe is caught by the stale heartbeat, not swallowed.
    return {
      page: false,
      measured: false,
      message: real.message ? `${real.message} (${realNote}; ${smokeNote})` : `${realNote}; ${smokeNote}`,
    };
  }
  if (smoke.regressed) {
    // The real bucket's HEALTHY median is the recheck's when the first batch was a
    // passing blip (first over budget, recheck inside it); only on a clean `healthy`
    // run is `first` the in-budget reading. Reporting `first` here would print the
    // slow number beside the words "inside the budget".
    const realHealthyMs = real.recheck?.medianMs ?? real.first.medianMs;
    return {
      page: false,
      measured: true,
      message:
        `${realNote} median ${ms(realHealthyMs)} is inside the budget; ${smokeNote} was over it, so a ` +
        `churned test-cache blip and not a production slowdown. Nobody is paged.`,
    };
  }
  return { page: false, measured: true, message: real.message };
}

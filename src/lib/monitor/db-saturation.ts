import { recordConsecutiveStreak, clearFailureStreak } from "@/lib/notify/streak";
import { sendThrottledAlert, sendThrottledInfo, resolveAlert } from "@/lib/notify/dispatch";
import { logAlertSendFailure, logResolveFailure } from "@/lib/notify/send-failure";
import { publicSupabaseUrl, supabaseSecretKey } from "@/lib/env";

/**
 * Pages when the Supabase database is memory pressured (#3588).
 *
 * On 2026-10-10 a production availability latency incident (real `/api/availability`
 * median 653ms, p95 1874ms, worsening from ~60ms, during the 50% cutover) was caused by
 * the database instance being memory pressured: committed memory ~1.55 GB against a ~1.69
 * GB ceiling with heavy swap. CPU was 4% and Postgres query execution looked idle, so
 * every query based monitor read healthy; the time was lost to swap and REST layer
 * latency. Nothing alerted on the database's own saturation, and it surfaced only
 * indirectly as a latency symptom a lead had already felt. This reads the database's
 * memory directly so the class pages early instead.
 *
 * It judges MEMORY IN USE (MemTotal minus MemAvailable), not the committed address space
 * against CommitLimit that it first judged. CommitLimit is enforced only under strict
 * overcommit (`vm.overcommit_memory=2`), and Supabase's image leaves the kernel default
 * (its tuned profile sets no overcommit mode, but does set `vm.panic_on_oom=1`, so running
 * out of REAL memory restarts the database). On the Large instance the commit limit (half
 * of RAM plus swap, 4.77 GB) sits below physical RAM (7.54 GB), and on 2026-10-29 at the
 * 50% pilot committed reached 80% of it, whispering, with 78% of RAM free and no swap. The
 * committed figure rises with load, so at 100% it could have paged on a healthy
 * database. On the small instance of 2026-10-10 the two figures happened to agree
 * because it was swapping heavily, which means MemAvailable was near zero too.
 *
 * Committed memory is still read, as a HEDGE that only ever whispers, at 95% of the commit
 * limit. The overcommit mode could be read from Supabase's published image but not from the
 * live database, and if it were strict after all, the database would refuse new connections
 * at 100% with RAM free, which memory in use cannot see.
 *
 * Fail safe like the rest of the monitor family: an unreadable value is never scored as
 * healthy (the NaN lands healthy shape, #1169, L11). A read that FAILS or a body that
 * cannot be PARSED (a wrong credential's 4xx, a renamed metric) is a CONFIGURED blind
 * spot, which must not read healthy for ever, so it THROWS; the lane runs each check in
 * its own `steps.run` boundary, so the throw touches nothing else, and a sustained one
 * pages through `monitor_step_failing:db_saturation`.
 *
 * There is deliberately NO "not configured" inert state. The metrics endpoint is read
 * with the Supabase secret key the whole app already holds (`supabaseSecretKey()`, the
 * forward-looking `sb_secret_…` key Supabase's own metrics docs use as the Basic-auth
 * password), so there is no new secret to be missing: a deploy that reaches this check
 * at all has the key, and a deploy missing it is broken everywhere, not just here. That
 * removes a whole false-reassurance surface (a key nobody set reading as inert rather
 * than off, #543), and means every non-healthy outcome is either a real page or a loud
 * blind spot.
 */

/** alert_state key for the PAGE: memory in use is critically high. A condition, so it
 *  resolves when the reading comes back under the page threshold. */
export const DB_SATURATION_KEY = "db_saturation";

/** alert_state key for the WARN: memory is elevated but not yet critical. An info whisper,
 *  so it never resolves (a healthy reading simply stops whispering). */
export const DB_SATURATION_WARN_KEY = "db_saturation_warn";

/** Memory in use as a percent of physical RAM. Page at 90 (about 750 MB left on Large, close
 *  to where the kernel starts reclaiming hard and an OOM restarts the database), warn at 80
 *  for early visibility before it reaches the page. Chosen by Dan on 2026-10-29. */
export const DB_SATURATION_PAGE_PCT = 90;
export const DB_SATURATION_WARN_PCT = 80;

/** Swap is a SECONDARY, corroborating signal: a database should not be swapping at all, so
 *  any sustained swap use is worth a warn, but it never pages on its own (the page trigger
 *  is memory in use), to avoid a guessed swap threshold false paging. */
export const DB_SATURATION_SWAP_WARN_PCT = 10;

/** Committed memory as a percent of the kernel's commit limit, the hedge above. Whisper
 *  only, never a page: on 2026-10-29 it read 80.7 at the 50% pilot on a healthy database,
 *  so 95 leaves room for the move to 100% while still warning before a strict limit bites. */
export const DB_SATURATION_COMMIT_WARN_PCT = 95;

/** Consecutive monitor ticks over the page threshold before paging. The lane runs every 5
 *  minutes; 2 ticks rides out a momentary spike so a brief burst does not page. */
export const DB_SATURATION_ALERT_AFTER_TICKS = 2;

/** Streak window: comfortably over 2 ticks * 5 min, with slack for a late tick. */
export const DB_SATURATION_STREAK_SECONDS = 30 * 60;

/** How long the metrics fetch may take before it is aborted, surfacing as a thrown step
 *  failure. Well inside the monitor lane's budget so a hung endpoint cannot stall the step. */
export const DB_METRICS_FETCH_TIMEOUT_MS = 10_000;

/**
 * The node_exporter style metric names Supabase's privileged metrics endpoint exposes.
 * These are from Supabase's documented metrics; CONFIRM them against the live endpoint
 * after deploy, because a renamed metric reads here as missing, which makes the judge
 * `unreadable` and the check throw (a sustained throw pages through
 * `monitor_step_failing`), rather than guessing a wrong value or reading healthy.
 */
export const DB_METRIC_NAMES = {
  total: "node_memory_MemTotal_bytes",
  available: "node_memory_MemAvailable_bytes",
  swapTotal: "node_memory_SwapTotal_bytes",
  swapFree: "node_memory_SwapFree_bytes",
  committed: "node_memory_Committed_AS_bytes",
  commitLimit: "node_memory_CommitLimit_bytes",
} as const;

/** The memory figures, each null when the metric was absent or unparseable. */
export interface DbMemoryReading {
  totalBytes: number | null;
  availableBytes: number | null;
  swapTotalBytes: number | null;
  swapFreeBytes: number | null;
  committedBytes: number | null;
  commitLimitBytes: number | null;
}

/**
 * Read one node_exporter gauge out of a Prometheus text body, or null when it is absent
 * or its value is not a finite number. A gauge line is `name value` (node_memory_* carry
 * no labels, but an optional `{...}` label set is tolerated), and `# HELP`/`# TYPE`
 * comment lines are ignored. A null is the fail safe value: the judge turns a null
 * total or available into `unreadable`, never into a guessed percentage (L50).
 */
function readGauge(text: string, name: string): number | null {
  // Anchored to a line start, and the name must be followed by whitespace or a `{...}`
  // label set, so `node_memory_MemAvailable_bytes` never matches inside
  // `node_memory_MemAvailable_bytes_total`. The VALUE is the first token after the name;
  // a trailing token (Prometheus allows an optional timestamp, `name value 1700000000000`)
  // is ignored rather than making the whole line read as a missing metric.
  const re = new RegExp(`^${name}(?:\\{[^}]*\\})?[ \\t]+([^\\s]+)`, "m");
  const m = re.exec(text);
  if (!m) return null;
  const value = Number(m[1]);
  return Number.isFinite(value) ? value : null;
}

/** Pure Prometheus parser: pull the memory gauges out of the metrics body. */
export function parseDbMemoryMetrics(text: string): DbMemoryReading {
  return {
    totalBytes: readGauge(text, DB_METRIC_NAMES.total),
    availableBytes: readGauge(text, DB_METRIC_NAMES.available),
    swapTotalBytes: readGauge(text, DB_METRIC_NAMES.swapTotal),
    swapFreeBytes: readGauge(text, DB_METRIC_NAMES.swapFree),
    committedBytes: readGauge(text, DB_METRIC_NAMES.committed),
    commitLimitBytes: readGauge(text, DB_METRIC_NAMES.commitLimit),
  };
}

/** What the judge decided, and the figures the copy reads. `unreadable` carries nulls. */
export interface DbSaturationVerdict {
  status: "ok" | "warn" | "page" | "unreadable";
  usedPct: number | null;
  swapUsedPct: number | null;
  /** Committed memory against the commit limit, null when either is missing. A hedge that
   *  only whispers; it never decides the status or makes the check unreadable. */
  committedPct: number | null;
}

/**
 * Pure judge. The `status` is MEMORY IN USE ONLY (page >= 90%, warn >= 80%, ok below),
 * because memory in use is the one signal that decides the critical page and its
 * recovery. A missing or zero total, or an available figure outside 0 to total, is
 * `unreadable` (nothing can be judged, and a broken read must never score healthy).
 *
 * Swap is deliberately NOT folded into the status: it is a secondary, corroborating signal
 * the RUNNER turns into an extra whisper, never into the page or its resolution. If swap
 * gated the status, residual swap (Linux does not eagerly reclaim it) would hold the
 * memory page open long after the pressure eased (#3588 review). Swap missing or
 * unconfigured is fine (a database with no swap), so an absent swap figure reads as zero.
 */
export function judgeDbSaturation(r: DbMemoryReading): DbSaturationVerdict {
  if (
    r.totalBytes === null ||
    r.availableBytes === null ||
    r.totalBytes <= 0 ||
    r.availableBytes < 0 ||
    r.availableBytes > r.totalBytes
  ) {
    return { status: "unreadable", usedPct: null, swapUsedPct: null, committedPct: null };
  }
  const usedPct = ((r.totalBytes - r.availableBytes) / r.totalBytes) * 100;
  const swapUsedPct =
    r.swapTotalBytes !== null && r.swapTotalBytes > 0 && r.swapFreeBytes !== null
      ? ((r.swapTotalBytes - r.swapFreeBytes) / r.swapTotalBytes) * 100
      : 0;
  const committedPct =
    r.committedBytes !== null && r.commitLimitBytes !== null && r.commitLimitBytes > 0
      ? (r.committedBytes / r.commitLimitBytes) * 100
      : null;
  const status: DbSaturationVerdict["status"] =
    usedPct >= DB_SATURATION_PAGE_PCT ? "page" : usedPct >= DB_SATURATION_WARN_PCT ? "warn" : "ok";
  return { status, usedPct, swapUsedPct, committedPct };
}

/** Whether swap use alone is worth a whisper, decided by the runner separately from the
 *  memory status so swap never gates the page (#3588 review). */
export function swapWarrantsWhisper(swapUsedPct: number | null): boolean {
  return swapUsedPct !== null && swapUsedPct >= DB_SATURATION_SWAP_WARN_PCT;
}

/** Whether committed memory is close enough to the commit limit to whisper, the hedge in
 *  the header. Like swap, decided apart from the status so it never gates the page. */
export function commitLimitWarrantsWhisper(committedPct: number | null): boolean {
  return committedPct !== null && committedPct >= DB_SATURATION_COMMIT_WARN_PCT;
}

const pct = (n: number | null): string => (n === null ? "unknown" : `${Math.round(n)}%`);

/**
 * The page. Customer consequence first (that is what decides whether someone acts at 7am),
 * then the numbers, then what to do. Read on a phone mid incident, so it does not open
 * with the word Slate (the Slack app already carries that).
 */
export function formatDbSaturationAlert(v: DbSaturationVerdict): string {
  return (
    `The booking database is running low on memory: ${pct(v.usedPct)} of its memory is in use ` +
    `and ${pct(v.swapUsedPct)} of its swap is used. Under load this shows up as slow ` +
    `availability and booking requests that leads feel, while Postgres query execution still ` +
    `looks idle, so the query based checks will read healthy. Scale the database instance up ` +
    `or shed load; this clears once memory in use falls fully back under ${DB_SATURATION_WARN_PCT}% ` +
    `(it holds through the ${DB_SATURATION_WARN_PCT} to ${DB_SATURATION_PAGE_PCT}% band so it does not flap).`
  );
}

/** The all clear for the PAGE: the critical state is over. Deliberately does not claim
 *  fully healthy, because the reading may still be in the warn band. */
export function formatDbSaturationRecovery(): string {
  return (
    `The booking database's memory in use is back under the ${DB_SATURATION_WARN_PCT}% early ` +
    `warning line, so the memory pressure that was slowing availability and booking requests has ` +
    `fully eased, not merely dipped under the critical ${DB_SATURATION_PAGE_PCT}% mark. No action is needed.`
  );
}

/** The warn whisper: elevated but not critical, so somebody can scale proactively. An info,
 *  so it never sends an all clear; it simply stops once the reading is healthy again. */
export function formatDbSaturationWarn(v: DbSaturationVerdict): string {
  // The warn fires when memory in use is over 80%, swap is in use, or committed memory is near
  // the commit limit, so the copy names only the line or lines this reading actually crossed
  // (L11). The first version named both of its lines as a disjunction and always said "a
  // database that is swapping", which on 2026-10-29 read out beside "swap is 0% used".
  const memoryOver = v.usedPct !== null && v.usedPct >= DB_SATURATION_WARN_PCT;
  const swapping = swapWarrantsWhisper(v.swapUsedPct);
  const nearCommitLimit = commitLimitWarrantsWhisper(v.committedPct);
  const reasons = [
    memoryOver ? `that is past the ${DB_SATURATION_WARN_PCT}% early warning line` : null,
    swapping
      ? `it is using ${pct(v.swapUsedPct)} of its swap, and a database that is swapping is already working harder than it should`
      : null,
    nearCommitLimit
      ? `its committed memory is at ${pct(v.committedPct)} of the kernel's commit limit. Supabase's published setup ` +
        `leaves that limit unenforced, but if this database enforces it, it refuses new connections at 100% even with ` +
        `memory free, so ask Supabase support whether vm.overcommit_memory is 2 here`
      : null,
  ].filter((r): r is string => r !== null);
  const opener =
    memoryOver || swapping ? "The booking database's memory is getting tight" : "The booking database needs a memory check";
  const close =
    memoryOver || swapping
      ? `This is below the level that pages but worth acting on: scale the instance before memory in use reaches ${DB_SATURATION_PAGE_PCT}%.`
      : "This never pages on its own.";
  return `${opener}: ${pct(v.usedPct)} of its memory is in use. ${capitalise(reasons.join("; and "))}. ${close}`;
}

const capitalise = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

/**
 * What one tick measured. A configured blind spot does not reach a result at all, it
 * throws (see the runner), so these are the only three outcomes a tick returns.
 */
export interface DbSaturationResult {
  status: "clear" | "warn" | "saturated";
  usedPct: number | null;
  swapUsedPct: number | null;
  committedPct: number | null;
}

/**
 * Fetch the raw Prometheus metrics body from Supabase's privileged endpoint. Throws on an
 * HTTP failure or a timeout; the throw propagates out of the check to the monitor lane's
 * step boundary, so a sustained failure pages through `monitor_step_failing` rather than
 * reading healthy.
 *
 * Basic auth with username `service_role` and the password the Supabase secret key
 * (`supabaseSecretKey()`), exactly as Supabase's current metrics docs and Grafana guides
 * use the endpoint (the forward-looking `sb_secret_…` key; the legacy service_role JWT is
 * being retired end of 2026). It is the SAME key the whole server already holds, so this
 * check needs no new secret: there is no inert "not configured" state to drift into (#543),
 * and a wrong key is a 4xx the fetch throws on, which pages loud rather than reading blind.
 * The host comes from `publicSupabaseUrl()` (the same `NEXT_PUBLIC_SUPABASE_URL` the rest
 * of the app reads), so the project ref is never hard coded.
 */
export async function fetchDbSaturationMetrics(): Promise<string> {
  // The secret key the whole server already holds; `supabaseSecretKey()` throws if it is
  // unset, which is a broken deploy that surfaces as a configured blind spot, not an inert
  // state (a deploy missing this key cannot read any row, so the check is the least of it).
  const token = supabaseSecretKey();
  const base = publicSupabaseUrl();
  const auth = Buffer.from(`service_role:${token}`).toString("base64");
  // A bounded timeout, well inside the lane's budget: a hung connection must fail rather
  // than stall the whole db_saturation step for the lane's lifetime (L110). The abort
  // surfaces as a throw out of this check, the same configured blind spot as any other
  // read failure, which a sustained one pages through `monitor_step_failing`.
  const res = await fetch(`${base.replace(/\/$/, "")}/customer/v1/privileged/metrics`, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(DB_METRICS_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`supabase metrics endpoint returned ${res.status}`);
  return res.text();
}

/**
 * One monitor tick. The states, deliberately distinct:
 *
 * The PAGE is driven by MEMORY IN USE alone; swap and committed memory near the commit
 * limit only ever add a whisper, never the page or its resolution (so residual swap cannot hold the page open, #3588 review). States:
 *
 *  - PAGE (in use >= 90%): count toward the streak, page once sustained two ticks.
 *  - WARN (in use 80 to 90%): HOLD a standing page open (hysteresis), reset the page
 *    streak so re-entry debounces, and whisper. The page does NOT clear here.
 *  - OK (in use < 80%): the page is genuinely over, so clear and resolve it. If swap is
 *    still in use, or committed memory is near the commit limit, the whisper continues
 *    (advisory), but the page stays resolved.
 *  - CONFIGURED BUT BLIND (fetch failed, or a body the parser cannot read): THROWS. The
 *    throw is contained by the lane's per-check `steps.run` boundary, and a sustained one
 *    pages through `monitor_step_failing:db_saturation`, so a renamed metric or a dead
 *    endpoint surfaces instead of reading healthy for ever (#3588 review, L557). It never
 *    clears a real page, because a throw returns the step's null fallback, not a verdict.
 *
 * There is no inert "not configured" branch: the metrics read uses the Supabase secret key
 * the whole server already holds, so a deploy that reaches this check at all has the key,
 * and a wrong or missing key is a throw (the blind-spot path), never a silent inert state.
 *
 * Best effort by design: a throw here fails only this one check, never the lane.
 */
export async function runDbSaturationCheck(deps: {
  loadMetrics: () => Promise<string>;
  /** The page and the warn whisper each throttle on their own cooldown: one slow climb
   *  should not re-page and re-whisper every tick, so the two are tuned separately. */
  cooldownMs: { page: number; warn: number };
  logTick?: (fields: Record<string, unknown>) => void;
}): Promise<DbSaturationResult> {
  // A metrics read that FAILS (fetch threw) or a body that cannot be PARSED (a metric was
  // renamed, or the endpoint returned a 4xx error page for a wrong key) is a CONFIGURED
  // blind spot, and it must not sit silently reading healthy for ever (#3588 review, L557).
  // It is left to THROW out of this check: the monitor lane runs every check in its own
  // `steps.run` boundary, so the throw cannot touch the checks around it, and a sustained
  // step failure pages through `monitor_step_failing:db_saturation`, the lane's own blind
  // detector backstop.
  const text = await deps.loadMetrics();
  const verdict = judgeDbSaturation(parseDbMemoryMetrics(text));
  if (verdict.status === "unreadable") {
    // Throw (see the header). Note what this deliberately does NOT do: it does not clear a
    // standing db_saturation page. A tick that cannot measure must never resolve a critical
    // page, or a blind spot would read as recovery (#1134, #1152); so if the database was
    // saturated and then became unreadable, the page stays open (fail safe) and the
    // blindness is reported SEPARATELY by monitor_step_failing:db_saturation.
    deps.logTick?.({ status: "unreadable", reason: "unparseable" });
    throw new Error("database metrics missing or unparseable, so saturation cannot be scored");
  }

  if (verdict.status === "page") {
    const sustained = await recordConsecutiveStreak(
      DB_SATURATION_KEY,
      DB_SATURATION_STREAK_SECONDS,
      DB_SATURATION_ALERT_AFTER_TICKS,
    );
    if (sustained) {
      // alert-key: db_saturation
      await sendThrottledAlert(DB_SATURATION_KEY, deps.cooldownMs.page, formatDbSaturationAlert(verdict)).catch(
        logAlertSendFailure(DB_SATURATION_KEY),
      );
    }
    deps.logTick?.({ status: "saturated", usedPct: verdict.usedPct, swapUsedPct: verdict.swapUsedPct, committedPct: verdict.committedPct, sustained });
    return { status: "saturated", usedPct: verdict.usedPct, swapUsedPct: verdict.swapUsedPct, committedPct: verdict.committedPct };
  }

  const whisper = async (): Promise<DbSaturationResult> => {
    // alert-key: db_saturation_warn
    await sendThrottledInfo(DB_SATURATION_WARN_KEY, deps.cooldownMs.warn, formatDbSaturationWarn(verdict)).catch(
      logAlertSendFailure(DB_SATURATION_WARN_KEY),
    );
    deps.logTick?.({ status: "warn", usedPct: verdict.usedPct, swapUsedPct: verdict.swapUsedPct, committedPct: verdict.committedPct });
    return { status: "warn", usedPct: verdict.usedPct, swapUsedPct: verdict.swapUsedPct, committedPct: verdict.committedPct };
  };

  if (verdict.status === "warn") {
    // Memory in use is elevated but under the page threshold. HYSTERESIS (#3588 review):
    // reset the page streak so a reading hovering around 90 has to climb and hold again
    // before it can re-page, but do NOT resolve a standing page here. The page clears only
    // once memory in use is fully back under the warn line (the `ok` branch below); resolving in
    // the 80 to 90 band would all-clear a reading oscillating across 90 over and over and
    // land "no action is needed" while it is still elevated (L11, L36).
    await clearFailureStreak(DB_SATURATION_KEY);
    return whisper();
  }

  // OK: memory in use is fully back under the warn line, so the critical condition is
  // genuinely over. Resolve the page on MEMORY IN USE alone (a no-op unless one was
  // delivered), never gated on swap: residual swap must not hold the memory page open.
  await clearFailureStreak(DB_SATURATION_KEY);
  // alert-key: db_saturation
  await resolveAlert(DB_SATURATION_KEY, formatDbSaturationRecovery()).catch(logResolveFailure(DB_SATURATION_KEY));

  // Memory in use is fine, but swap can still be in use, or committed memory near the commit
  // limit: whisper (advisory) while it is, with the page already resolved. The whisper simply
  // stops when the reading falls back, no all-clear owed.
  if (swapWarrantsWhisper(verdict.swapUsedPct) || commitLimitWarrantsWhisper(verdict.committedPct)) return whisper();

  deps.logTick?.({ status: "clear", usedPct: verdict.usedPct, swapUsedPct: verdict.swapUsedPct, committedPct: verdict.committedPct });
  return { status: "clear", usedPct: verdict.usedPct, swapUsedPct: verdict.swapUsedPct, committedPct: verdict.committedPct };
}

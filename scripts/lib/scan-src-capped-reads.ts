// Static detector for the #822 guard: a capped single-page supabase-js list read
// on a GROWTH table in production `src/`. See scripts/test-src-capped-reads.ts
// for the why and the fixtures that prove this actually catches the bad pattern.
//
// A "read site" is a `.from("<table>").select(...)` chain (the supabase-js shape
// production code uses; the #730 fetch-shape detector cannot see it). It is
// FLAGGED when the table is a GROWTH table and the chain carries no bounding
// signal. It is NOT flagged when:
//   - the table is roster-bounded / config / singleton / lock (SAFE_TABLES): its
//     row count is capped by the design target (100-200 agents), well under a
//     page, so it can never truncate;
//   - the chain is a write (`.insert`/`.update`/`.delete`/`.upsert` reached
//     before any `.select`), not a read;
//   - the chain (including a bound applied later to a reused query builder)
//     carries `.single()`/`.maybeSingle()`/`.limit()`/`.range()`/`.csv()`, a
//     `head: true` count, or a primary-key `.eq("id", …)`/`.in("id", …)`;
//   - a `// cap-safe:` opt-out sits on / above the `.from(` line.
//
// TABLE-AWARE by decision (Dan, 2026-07-16): a table NOT on SAFE_TABLES defaults
// to a growth table (flagged), so a brand-new table must be justified rather than
// silently unguarded (fail-loud over churn).
//
// Like the sibling scan-capped-reads.ts this is a deliberate text scan, not a
// full parser: lightweight, dependency-free, with escape hatches that keep it
// from false-flagging the legitimately-narrow lookups.

export interface SrcCappedReadFinding {
  file: string;
  line: number;
  /** The growth table the read hits. */
  table: string;
  /** The `.from("t").select(...)` snippet (truncated for readability). */
  snippet: string;
}

// Roster-bounded / config / singleton / lock tables: their row count is capped by
// the design target (100-200 agents, ~60 buckets) or by a fixed key space, so a
// read of one can never exceed a single PostgREST page. Every OTHER table is
// treated as a growth table (its rows scale with booking volume or time).
// Exported so AGENTS.md's copy of this list is DERIVED from it rather than
// maintained beside it (#2398): the doc's list had drifted two tables behind,
// and the paragraph telling a reader to "add it to SAFE_TABLES" was pointing at
// a list that already held the table they were reading about.
export const SAFE_TABLES = new Set([
  "organizations",
  "users",
  "buckets",
  "bucket_members",
  "availability_schedules",
  "agent_calendars",
  "event_types",
  "webhook_endpoints",
  "monitor_settings",
  "monitor_alert_config",
  "alert_state",
  // Org business hours (#1294): exactly one row per weekday, a fixed 1..7 primary
  // key space, so it holds seven rows forever.
  "business_hours",
  // Precomputed availability cache: upserted onConflict bucket_code, so exactly
  // one row per bucket (~60). Bounded by the bucket count, never by volume.
  "bucket_slots",
  "sync_locks",
  "rate_limits",
  "reschedule_locks",
  "lane_heartbeats",
  "selfheal_scan_cursor",
  // #1313: one rolling-window state row on a fixed key space; can never grow.
  "booking_failure_rate_state",
  // Snowflake export watermark (#1098): one row per (lane, mirrored table), so
  // roughly a dozen rows total. Bounded by the table count, never by volume.
  "export_cursor",
  // #346: reason options are roster/config-bounded (a few dozen rows across 3
  // actions), so a single page always holds the whole set.
  "reason_options",
  // #1015: single-row direct-booking config (id pinned to 1), like
  // monitor_alert_config. Exactly one row, never a page.
  "booking_settings",
]);

const FROM_SITE = /\.from\(\s*(["'`])([a-z_]+)\1/g;
const MUTATORS = [".insert(", ".update(", ".delete(", ".upsert("];

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/** Index of the nth newline at/after `from` (or end of source). */
function nthNewline(source: string, from: number, n: number): number {
  let idx = from;
  for (let i = 0; i < n; i++) {
    const next = source.indexOf("\n", idx + 1);
    if (next === -1) return source.length;
    idx = next;
  }
  return idx;
}

/**
 * True if a `// cap-safe` opt-out is attached to the read: a trailing comment on
 * the `.from(` line, or anywhere in the contiguous block of `//` comment lines
 * immediately above it (so a multi-line justification counts). Mirrors the
 * sibling scan-capped-reads.ts.
 */
function hasOptOut(source: string, fromIndex: number): boolean {
  const lines = source.slice(0, fromIndex).split("\n");
  if (/\/\/\s*cap-safe/i.test(lines[lines.length - 1] ?? "")) return true;
  for (let i = lines.length - 2; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith("//")) break;
    if (/\/\/\s*cap-safe/i.test(trimmed)) return true;
  }
  return false;
}

/**
 * The text to search for cap-safe signals and the select/mutator order: the read
 * expression starting at the `.from(`. For a reused query builder
 * (`let q = db.from(...).select(...)` with the terminating `await q.range(...)`
 * on a later line) the window is extended through the statement that awaits the
 * builder, so a `.range()`/`.limit()` applied later still counts.
 */
function readWindow(source: string, fromIndex: number): string {
  // The statement-so-far, back to the previous `;`. This spans the multi-line
  // `let q = supabaseAdmin()\n  .from(...)` shape where the binding is on a line
  // above the `.from(`, which a single-line prefix would miss.
  const prevSemi = source.lastIndexOf(";", fromIndex);
  const stmtPrefix = source.slice(prevSemi === -1 ? 0 : prevSemi + 1, fromIndex);
  // Builder: a `const/let/var NAME = <client>` binding with no `await` (the
  // query is stored and executed on a later statement).
  const builder = /(?:const|let|var)\s+(\w+)\s*=\s*[\s\S]*$/.exec(stmtPrefix);
  const awaited = /\bawait\b/.test(stmtPrefix);

  if (builder && !awaited) {
    const varName = builder[1];
    // The binding chain (from `.from(` to its own `;`) plus every later line that
    // references the builder variable (its reassignments and the terminating
    // `await q.range(...)` / `await q.maybeSingle()`). A sibling query on a
    // neighbouring line never mentions this variable, so its bound can't leak in
    // and mask this read (the false negative a plain char-window would cause).
    const bindEnd = source.indexOf(";", fromIndex);
    const bindStmt = source.slice(fromIndex, bindEnd === -1 ? source.length : bindEnd);
    const restStart = bindEnd === -1 ? fromIndex : bindEnd;
    const rest = source.slice(restStart, nthNewline(source, restStart, 30));
    // Every method chain applied to the builder later (`q = q.eq(...)`,
    // `await q.order(...).range(...)`) captured whole (to its `;`) so a bound on
    // a chain-continuation line still counts. A bare `[q]` array element (e.g. in
    // Promise.all) is only a reference, not a `.` chain, so a sibling query's
    // bound in that same statement can't leak in.
    const chainRe = new RegExp(`\\b${varName}\\s*\\.`, "g");
    let chains = "";
    for (const cm of rest.matchAll(chainRe)) {
      const start = cm.index as number;
      const semi = rest.indexOf(";", start);
      chains += `${rest.slice(start, semi === -1 ? rest.length : semi)};`;
    }
    return `${bindStmt};${chains}`;
  }

  const semi = source.indexOf(";", fromIndex);
  const end = semi === -1 ? Math.min(fromIndex + 600, source.length) : semi;
  return source.slice(fromIndex, end);
}

function isCapSafe(window: string): boolean {
  if (/\.(single|maybeSingle|limit|range|csv)\s*\(/.test(window)) return true;
  if (/head\s*:\s*true/.test(window)) return true;
  // Primary-key lookup: bounded to the id (or the id list).
  if (/\.(eq|in)\(\s*(["'`])id\2/.test(window)) return true;
  return false;
}

/** True if the chain is a read (a `.select(` reached before any mutator). */
function isSelect(window: string): boolean {
  const sel = window.indexOf(".select(");
  if (sel === -1) return false;
  for (const m of MUTATORS) {
    const idx = window.indexOf(m);
    if (idx !== -1 && idx < sel) return false; // a write reached first
  }
  return true;
}

export function scanSrcCappedReads(source: string, file = "<source>"): SrcCappedReadFinding[] {
  const findings: SrcCappedReadFinding[] = [];
  for (const m of source.matchAll(FROM_SITE)) {
    const table = m[2];
    if (SAFE_TABLES.has(table)) continue; // roster-bounded / config / singleton

    const fromIndex = m.index as number;
    const window = readWindow(source, fromIndex);
    if (!isSelect(window)) continue; // a write, not a list read
    if (isCapSafe(window)) continue; // bounded / paginated / single-row / count
    if (hasOptOut(source, fromIndex)) continue; // documented as one-page-max

    const snippet = window.replace(/\s+/g, " ").trim();
    findings.push({
      file,
      line: lineOf(source, fromIndex),
      table,
      snippet: snippet.length > 100 ? `${snippet.slice(0, 97)}...` : snippet,
    });
  }
  return findings;
}

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
//     `head: true` count, or a primary-key `.eq("id", …)`/`.in("id", …)` (the
//     key column is per table, see PRIMARY_KEYS);
//   - a `// cap-safe:` opt-out sits on / above the `.from(` line;
//   - the chain sits inside a `selectAllPages(...)` call (#3273), which orders
//     it by a unique key and pages it, so the chain itself carries no `.range()`.
//
// TABLE-AWARE by decision (Dan, 2026-07-16): a table NOT on SAFE_TABLES defaults
// to a growth table (flagged), so a brand-new table must be justified rather than
// silently unguarded (fail-loud over churn).
//
// Like the sibling scan-capped-reads.ts this is a deliberate text scan, not a
// full parser: lightweight, dependency-free, with escape hatches that keep it
// from false-flagging the legitimately-narrow lookups.

import { hasOptOutAtOffset } from "./opt-out.ts";
import { isInsidePagedCall, pagedCallSpans } from "./scan-paged-calls.ts";

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
// This constant is the list's ONE home. AGENTS.md used to carry a copy, which
// drifted two tables behind (#2398): the paragraph telling a reader to "add it
// to SAFE_TABLES" was pointing at a list that already held the table they were
// reading about. Since 2026-10-15 the doc only names this constant, and
// scripts/test-auto-loaded-doc-claims.ts refuses a copy coming back.
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
  // Org business hours (#1294): exactly one row per weekday, a fixed 1..7 primary
  // key space, so it holds seven rows forever.
  "business_hours",
  // Precomputed availability cache: upserted onConflict bucket_code, so exactly
  // one row per bucket (~60). Bounded by the bucket count, never by volume.
  "bucket_slots",
  "sync_locks",
  // NOT rate_limits (#3109): it holds one row per caller IP and per lead email
  // and phone, so it scales with traffic. The daily prune keeps it to about a
  // day of callers, which can still be more than a page.
  "reschedule_locks",
  "lane_heartbeats",
  // #3027: one row per user, so bounded by the roster like `users` itself.
  "advisor_photos",
  "selfheal_scan_cursor",
  // #3090: one row, the audit chain walk's position.
  "audit_log_chain_verify",
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
  // #4296: the editable reminder emails, a handful of rows an admin creates one at a
  // time (two seeded). NOT booking_reminder_sends or reminder_email_versions, which
  // grow with bookings and with every copy edit.
  "reminder_emails",
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
  return hasOptOutAtOffset(source, fromIndex, "cap-safe:");
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

/**
 * The primary key column of a growth table whose key is NOT `id`. A `.eq` / `.in`
 * on the primary key returns at most one row per value, so it is the same bounded
 * lookup as `.in("id", ids)`. Per TABLE on purpose: a column called `key`
 * elsewhere is an ordinary filter and bounds nothing.
 *
 * `alert_state` (#2726): off SAFE_TABLES since its per booking alert families
 * grow with booking volume, and keyed by `key`.
 */
const PRIMARY_KEYS: Record<string, string> = {
  alert_state: "key",
};

function isCapSafe(window: string, table: string): boolean {
  if (/\.(single|maybeSingle|limit|range|csv)\s*\(/.test(window)) return true;
  if (/head\s*:\s*true/.test(window)) return true;
  // Primary-key lookup: bounded to the key (or the key list).
  const pk = PRIMARY_KEYS[table] ?? "id";
  if (new RegExp(`\\.(eq|in)\\(\\s*(["'\`])${pk}\\2`).test(window)) return true;
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
  const paged = pagedCallSpans(source);
  for (const m of source.matchAll(FROM_SITE)) {
    const table = m[2];
    if (SAFE_TABLES.has(table)) continue; // roster-bounded / config / singleton

    const fromIndex = m.index as number;
    const window = readWindow(source, fromIndex);
    if (!isSelect(window)) continue; // a write, not a list read
    if (isInsidePagedCall(paged, fromIndex)) continue; // selectAllPages orders and pages it
    if (isCapSafe(window, table)) continue; // bounded / paginated / single-row / count
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

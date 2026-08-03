// Static detector for the #1231 guard: a write to a mirrored table that supplies
// that table's watermark column, so the rows can land BEHIND the Snowflake export
// cursor and the strictly forward keyset never fetches them. See
// scripts/test-mirror-backfill-cursor.ts for the incident, the scope decisions,
// and the fixtures that prove this catches the bad shape.
//
// Like its siblings (scan-capped-reads.ts, scan-definer-search-path.ts) this is a
// deliberate text scan rather than a SQL or TS parser: lightweight,
// dependency-free, with a one line escape hatch. It errs toward silence, because a
// guard that cries wolf on ordinary migrations gets switched off. The two shapes
// it does catch are the two the incident took.

/** A write whose rows may be unreachable to the export. */
export interface MirrorBackfillFinding {
  file: string;
  /** 1-indexed line the write starts on. */
  line: number;
  /** The mirrored table written to. */
  table: string;
  /** The watermark column the write supplies. */
  watermark: string;
  /** The matched text, trimmed, for the failure message. */
  snippet: string;
}

export interface MirrorSpec {
  table: string;
  watermark: string;
}

const OPT_OUT = /export-cursor-ok:/;

/**
 * Blanks out `--` and `//` line comments plus SQL block comments, so a write
 * described in prose is not read as a real one. Quote-aware for single quotes.
 * Returns one entry per input line, same length, so line numbers survive.
 */
function stripComments(lines: string[]): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    let kept = "";
    let inString = false;
    for (let i = 0; i < line.length; i++) {
      const two = line.slice(i, i + 2);
      if (inBlock) {
        if (two === "*/") {
          inBlock = false;
          i++;
        }
        continue;
      }
      if (!inString && (two === "--" || two === "//")) break;
      if (!inString && two === "/*") {
        inBlock = true;
        i++;
        continue;
      }
      if (line[i] === "'") inString = !inString;
      kept += line[i];
    }
    out.push(kept);
  }
  return out;
}

/**
 * Blanks out every `$tag$ ... $tag$` body, keeping newlines so line numbers hold.
 *
 * A write inside a function body executes at write time with a current watermark,
 * which is the normal application path and not a backfill. Blanking the bodies is
 * what makes that distinction, and the guard's control proves it is a distinction
 * rather than a blind spot: the same statement hoisted out is caught.
 */
function stripDollarBodies(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const open = /\$(\w*)\$/.exec(sql.slice(i));
    if (!open) {
      out += sql.slice(i);
      break;
    }
    const openStart = i + open.index;
    const tag = open[0];
    const closeAt = sql.indexOf(tag, openStart + tag.length);
    out += sql.slice(i, openStart);
    if (closeAt === -1) {
      // Unterminated body: keep the newlines and stop, rather than guessing.
      out += sql.slice(openStart).replace(/[^\n]/g, " ");
      break;
    }
    out += sql.slice(openStart, closeAt + tag.length).replace(/[^\n]/g, " ");
    i = closeAt + tag.length;
  }
  return out;
}

/** True when the opt-out sits on this line or in the comment block above it. */
function hasOptOut(rawLines: string[], index: number): boolean {
  if (OPT_OUT.test(rawLines[index] ?? "")) return true;
  for (let i = index - 1; i >= 0; i--) {
    const t = (rawLines[i] ?? "").trim();
    if (t === "") continue;
    if (!t.startsWith("--") && !t.startsWith("//") && !t.startsWith("*")) return false;
    if (OPT_OUT.test(t)) return true;
  }
  return false;
}

/** 1-indexed line for a byte offset. */
function lineOf(src: string, offset: number): number {
  return src.slice(0, offset).split("\n").length;
}

/**
 * A rewind anywhere in the same file clears every write in it.
 *
 * File-level on purpose: the rewind is normally its own statement at the end of
 * the migration, not attached to the write, and a file that rewinds the cursor has
 * demonstrably thought about reachability.
 */
function rewindsCursor(stripped: string): boolean {
  return /\bexport_cursor\b/.test(stripped);
}

function scanSql(src: string, file: string, specs: MirrorSpec[]): MirrorBackfillFinding[] {
  const rawLines = src.split("\n");
  const stripped = stripDollarBodies(stripComments(rawLines).join("\n"));
  if (rewindsCursor(stripped)) return [];

  const findings: MirrorBackfillFinding[] = [];
  // Statement at a time, so the watermark has to appear in the SAME statement as
  // the write: an unrelated later statement mentioning created_at is not evidence.
  let offset = 0;
  for (const statement of stripped.split(";")) {
    const start = offset;
    offset += statement.length + 1;
    for (const spec of specs) {
      const t = spec.table;
      const insert = new RegExp(`\\binsert\\s+into\\s+(?:public\\.)?${t}\\b`, "i").exec(statement);
      const update = new RegExp(`\\bupdate\\s+(?:public\\.)?${t}\\b`, "i").exec(statement);
      const hit = insert ?? update;
      if (!hit) continue;
      const suppliesWatermark = insert
        ? new RegExp(`\\b${spec.watermark}\\b`).test(statement)
        : new RegExp(`\\b${spec.watermark}\\s*=`).test(statement);
      if (!suppliesWatermark) continue;
      const line = lineOf(src, start + hit.index);
      if (hasOptOut(rawLines, line - 1)) continue;
      findings.push({
        file,
        line,
        table: t,
        watermark: spec.watermark,
        snippet: hit[0].trim(),
      });
    }
  }
  return findings;
}

/** How far past `.from("t")` a write's payload is looked for. */
const TS_WINDOW = 600;

function scanTs(src: string, file: string, specs: MirrorSpec[]): MirrorBackfillFinding[] {
  const rawLines = src.split("\n");
  const stripped = stripComments(rawLines).join("\n");
  if (rewindsCursor(stripped)) return [];

  const findings: MirrorBackfillFinding[] = [];
  for (const spec of specs) {
    const fromRe = new RegExp(`\\.from\\(\\s*["'\`]${spec.table}["'\`]\\s*\\)`, "g");
    let m: RegExpExecArray | null;
    while ((m = fromRe.exec(stripped)) !== null) {
      // The chain, up to the end of the statement or a bounded window: a
      // supabase-js write reads `.from("t").insert({...})` with the payload right
      // there, and a long payload is still one statement.
      const rest = stripped.slice(m.index, m.index + TS_WINDOW);
      const chain = rest.slice(0, rest.indexOf(";") === -1 ? rest.length : rest.indexOf(";") + 1);
      if (!/\.(insert|upsert|update)\s*\(/.test(chain)) continue;
      if (!new RegExp(`\\b${spec.watermark}\\b`).test(chain)) continue;
      const line = lineOf(stripped, m.index);
      if (hasOptOut(rawLines, line - 1)) continue;
      findings.push({
        file,
        line,
        table: spec.table,
        watermark: spec.watermark,
        snippet: m[0],
      });
    }
  }
  return findings;
}

/**
 * Findings for one file. `.sql` is scanned as SQL, anything else as TS/JS; the
 * mirrored table list is passed in (derived from MIRROR_TABLES by the guard)
 * rather than retyped here, so a new mirrored table is covered automatically.
 */
export function scanMirrorBackfill(src: string, file: string, specs: MirrorSpec[]): MirrorBackfillFinding[] {
  return file.endsWith(".sql") ? scanSql(src, file, specs) : scanTs(src, file, specs);
}

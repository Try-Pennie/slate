/**
 * Find a write that moves `users.bookable` or `users.deactivated_at` outside the
 * one module that owns both, `src/lib/bookable/routable-write.ts` (#2085).
 *
 * That module sends Regal the bookable trait from INSIDE the write: it reads the
 * row before, writes, reads what it wrote, and records a trait for every row whose
 * routing value (`isRoutable`: bookable and not deactivated) moved. A second writer
 * would change who Slate routes to while Regal went on believing the old answer,
 * and nothing would say so, because a site that never emits looks exactly like a
 * site where nothing changed (L621). So the second writer fails the build.
 *
 * WHAT IT FLAGS, in any scanned file except the owning module:
 *
 *   - a `.update(` or `.upsert(` whose argument names `bookable` or
 *     `deactivated_at` as a word (so `bookable_pending_since` is NOT the flag), or
 *     calls one of the shared patches (`deactivationPatch(`, `reactivationPatch(`),
 *     since applying the shared patch from a second site is a second writer too;
 *   - an `.insert(` that names `bookable` with anything but a literal `false`. A
 *     row created not bookable owes no trait (every insert site today does that,
 *     and the backfill gives Regal its starting state); one created bookable does.
 *
 * It follows ONE hop through a local `const` (`.update(patch)`), because that is
 * the shape the owning module's predecessors used; it does not follow more.
 *
 * WHAT IT CANNOT SEE, said so a green run is never read as more than it is (L400):
 * an argument that is an import, a parameter or a field, and SQL run by hand in
 * the Supabase editor (the residual #2085 accepts, repaired by the backfill). The
 * caller scans `src/` and `worker/`, the code that runs in production; `scripts/`
 * is out of scope because its writers of these columns are seed and load test
 * scripts creating synthetic agents, whose traits are suppressed anyway.
 *
 * ESCAPE HATCH: `// routable-write-ok: <why>` on, or in the `//` block directly
 * above, the write. It is its own token rather than the neighbouring
 * `lifecycle-write-ok:`, because a second rule behind an existing suppression
 * silently widens every existing use of it (L448), and it is refused with no
 * reason.
 */

import { hasOptOut as sharedHasOptOut } from "./opt-out.ts";

export interface RoutableWriteFinding {
  file: string;
  line: number;
  text: string;
}

const MUTATORS = [".update(", ".upsert(", ".insert("] as const;

/** Balanced argument region of a call starting at the `(` at `from`, bounded. */
function callArgument(source: string, from: number): string {
  let depth = 0;
  const end = Math.min(source.length, from + 4000);
  for (let i = from; i < end; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  return source.slice(from, end);
}

/** ONE hop: the initialiser of a local `const name`, up to its statement's `;`. */
function resolveLocalConst(source: string, name: string): string {
  const decl = new RegExp(`\\bconst\\s+${name}\\s*(?::[^=]*)?=`).exec(source);
  if (!decl) return "";
  const from = decl.index + decl[0].length;
  let depth = 0;
  const end = Math.min(source.length, from + 2000);
  for (let i = from; i < end; i++) {
    const ch = source[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === ";" && depth <= 0) return source.slice(from, i);
  }
  return source.slice(from, end);
}

const NAMES_COLUMN = /\b(?:bookable|deactivated_at)\b(?!_)/;
const SHARED_PATCH = /\b(?:deactivationPatch|reactivationPatch)\s*\(/;
/** `bookable` as a key whose value is anything but a literal `false`, or shorthand. */
const INSERTS_BOOKABLE = /\bbookable\s*:(?!\s*false\b)|\bbookable\s*[,}]/;

function isRoutableWrite(marker: (typeof MUTATORS)[number], arg: string): boolean {
  if (marker === ".insert(") return INSERTS_BOOKABLE.test(arg);
  return NAMES_COLUMN.test(arg) || SHARED_PATCH.test(arg);
}

export function scanRoutableWrites(file: string, source: string): RoutableWriteFinding[] {
  const findings: RoutableWriteFinding[] = [];
  const lines = source.split("\n");
  for (const marker of MUTATORS) {
    for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + 1)) {
      let arg = callArgument(source, at + marker.length - 1);
      const bareName = /^\(\s*([A-Za-z_$][\w$]*)\s*\)$/.exec(arg);
      if (bareName) arg = resolveLocalConst(source, bareName[1]);
      if (!isRoutableWrite(marker, arg)) continue;
      const line = source.slice(0, at).split("\n").length;
      if (sharedHasOptOut(lines, line - 1, "routable-write-ok:")) continue;
      findings.push({ file, line, text: lines[line - 1].trim() });
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

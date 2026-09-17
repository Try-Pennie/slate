/**
 * Find a `users` write that moves `deactivated_at` outside the one module that
 * owns what a departure and a return write (#2386).
 *
 * The rule it protects is in `src/lib/offboarding/lifecycle-write.ts`: leaving the
 * pool stamps `deactivated_at` AND clears `bookable`, in one statement, and
 * returning writes `bookable` false so re-entry goes through the activation gate.
 *
 * Why a scan and not just a shared helper. The rule was written once (#1324) and
 * then copied badly: the Salesforce reap kept its own
 * `update({ deactivated_at: ... })` for six weeks, and every leaver it processed
 * stayed marked bookable. Sharing the patch alone would not have stopped that,
 * because the copy was a whole write and never reached for the shared thing
 * (L370). A third copy has to fail the build (L613).
 *
 * WHAT IT FLAGS: a `.update(` whose argument names `deactivated_at`, in any
 * `src/**` file except the owning module. That is the exact shape both instances
 * wore. It follows ONE hop through a local `const`, because the owning module's own
 * write is `const patch = ...; .update(patch)` and anybody copying the rule copies
 * the shape they are looking at; it does NOT follow more than that, and says so.
 *
 * It deliberately says nothing about a `.upsert(` or an `.insert(`: those write a
 * whole row rather than moving somebody between states, and no instance of this
 * defect has ever been one. If one appears, widen the shape here rather than
 * assuming it was covered.
 *
 * WHAT IT CANNOT SEE, said here so a green run is never read as more than it is
 * (L400). An `.update(x)` whose `x` is not a local `const` in the same file (an
 * import, a parameter, a field) is NOT flagged: nothing in a single file scan can
 * follow it, and flagging every named argument would fire on writes that have
 * nothing to do with this column. Both instances of the defect so far, and the
 * shape anybody copying the owning module would produce, are within one file.
 *
 * ESCAPE HATCH: `// lifecycle-write-ok: <why>` on, or in the `//` block directly
 * above, the `.update(`. It is refused when it carries no reason, so the hatch
 * cannot be taken by writing the token alone.
 */

import { hasOptOut as sharedHasOptOut } from "./opt-out.ts";

export interface DeactivationWriteFinding {
  file: string;
  line: number;
  text: string;
}

/** Does the comment block above `index`, or the line itself, carry the hatch? */
function hasOptOut(lines: string[], index: number): boolean {
  return sharedHasOptOut(lines, index, "lifecycle-write-ok:");
}

/**
 * The argument region of an `.update(` starting at `from`, balanced to its closing
 * paren. Bounded, so a file with an unbalanced paren cannot hang the scan; the
 * bound is generous enough for every real patch object, which are a few lines.
 */
function updateArgument(source: string, from: number): string {
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

/**
 * ONE hop: `.update(patch)` where `patch` is a local `const` declared earlier in
 * the file. Returns the declaration's OWN initialiser, ending at the statement's
 * `;`, so a patch assembled a few lines above the write is read as part of it and
 * the unrelated lines after it are not: a fixed character window past the
 * declaration reaches the `.select("deactivated_at")` two lines below and reports
 * a compliant write as a copy.
 */
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

export function scanDeactivationWrites(
  file: string,
  source: string,
): DeactivationWriteFinding[] {
  const findings: DeactivationWriteFinding[] = [];
  const lines = source.split("\n");
  const marker = ".update(";
  for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + 1)) {
    let arg = updateArgument(source, at + marker.length - 1);
    const bareName = /^\(\s*([A-Za-z_$][\w$]*)\s*\)$/.exec(arg);
    if (bareName) arg = resolveLocalConst(source, bareName[1]);
    if (!/\bdeactivated_at\b/.test(arg)) continue;
    const line = source.slice(0, at).split("\n").length;
    if (hasOptOut(lines, line - 1)) continue;
    findings.push({ file, line, text: lines[line - 1].trim() });
  }
  return findings;
}

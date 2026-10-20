/**
 * The booking load run's bar is ONE number (#3124): `LOAD_RUN_BOOKINGS_PER_MINUTE` in
 * `src/lib/load-bar.ts`, which the run's steady pass is sized from and the daily busy
 * minute alert judges against. Before #3124 the run held its own 60, as four drivers at
 * fifteen in `scripts/loadtest/book-plan.ts`, so the bar Dan raised and the bar the run
 * judged were two numbers that nothing tied together. A shared constant does not stop
 * that coming back, because the copy never reaches for the shared thing (L370, L613), so
 * this scan is the other half of the consolidation.
 *
 * It reads the load test's own code (`scripts/loadtest`, and the workflow that runs it)
 * and reports three things:
 *
 *   - a RATE SHAPED binding (a name about a rate a minute, a driver's pace, a target or
 *     a bar) whose value is a bare numeric literal equal to the bar, or to a bar Dan has
 *     raised past (`RETIRED_LOAD_BARS`): a copy of the bar, current or stale;
 *   - a binding that must be DERIVED from the bar (the steady pacing constants) holding
 *     any numeric literal at all, whatever its value, since a hand set pace is a second
 *     bar however it is spelled;
 *   - the file that sizes the steady pass not importing the bar from `load-bar`.
 *
 * The escape hatch is `// load-bar-ok: <why>` on, or in the `//` block directly above,
 * the line, for a literal that is a rate but not the bar (a warm up read once a second
 * happens to be 60 a minute). It is refused without a reason of at least three words, and
 * a refused one is reported as such rather than as a plain copy, since the two send a
 * reader to do different things (L11).
 *
 * What it cannot see, so a clean scan is never read as more than it is (L400): a bar
 * written as arithmetic (`4 * 15`), a value passed in from outside the scanned files, and
 * prose in comments or the RUNBOOK. Comment lines are skipped on purpose: they explain
 * old runs in the numbers those runs used.
 *
 * Pure: the caller reads the files, so fixtures drive every verdict.
 */

/** Bars Dan has raised past. A literal one of these is a run judged on the old premise. */
export const RETIRED_LOAD_BARS: readonly number[] = [60];

/** The hatch token, its own so no other suppression widens to cover it (L448). */
export const LOAD_BAR_HATCH = "load-bar-ok:";

export interface LoadBarFile {
  path: string;
  text: string;
}

export interface LoadBarScanInput {
  files: readonly LoadBarFile[];
  /** The bar today, read from `LOAD_RUN_BOOKINGS_PER_MINUTE` by the caller. */
  bar: number;
  /** Bindings that must be computed from the bar, never written as a number. */
  derivedNames: readonly string[];
  /** The file that sizes the steady pass, which must import the bar. */
  sizingFile: string;
}

export interface LoadBarFinding {
  path: string;
  line: number;
  text: string;
  why: string;
}

/** A name about a rate a minute, one driver's pace, a target or a bar. */
const RATE_SHAPED = /(per_?min|per_?driver|target|(^|_)bar($|_)|bar$|^bar)/i;

/** `name = 70`, `name: 70`, `readonly name = 70`, but never `==`, `=>` or `>=`. */
const BINDING = /([A-Za-z_$][\w$]*)\s*(?::|(?<![=!<>])=(?![=>]))\s*(-?\d[\d_]*(?:\.\d+)?)(?![\w.])/g;

function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("#");
}

/**
 * The hatch governing a line: on the line itself, or in the run of `//` lines directly
 * above it. `null` when there is none; `""` when there is one with too short a reason.
 */
function hatchFor(lines: readonly string[], index: number): string | null {
  const read = (line: string): string | null => {
    const at = line.indexOf(LOAD_BAR_HATCH);
    if (at < 0) return null;
    const reason = line.slice(at + LOAD_BAR_HATCH.length).trim();
    return /\w+\s+\w+\s+\w+/.test(reason) ? reason : "";
  };
  const own = read(lines[index] ?? "");
  if (own !== null) return own;
  for (let i = index - 1; i >= 0; i--) {
    const t = (lines[i] ?? "").trim();
    if (!t.startsWith("//")) break;
    const r = read(t);
    if (r !== null) return r;
  }
  return null;
}

export function scanLoadBarLiterals(input: LoadBarScanInput): {
  findings: LoadBarFinding[];
  unreasonedHatches: LoadBarFinding[];
} {
  const findings: LoadBarFinding[] = [];
  const unreasonedHatches: LoadBarFinding[] = [];
  const barValues = new Map<number, string>([
    ...RETIRED_LOAD_BARS.map((v) => [v, `the retired bar of ${v} a minute`] as [number, string]),
    [input.bar, `the load bar (${input.bar} a minute)`],
  ]);
  const derived = new Set(input.derivedNames);

  for (const file of input.files) {
    const lines = file.text.split("\n");
    lines.forEach((raw, index) => {
      const trimmed = raw.trim();
      if (trimmed === "" || isCommentLine(trimmed)) return;
      // A trailing comment is prose, not code.
      const code = raw.replace(/\s\/\/.*$/, "");
      for (const m of code.matchAll(BINDING)) {
        const name = m[1] ?? "";
        const value = Number((m[2] ?? "").replace(/_/g, ""));
        const at = { path: file.path, line: index + 1, text: trimmed };
        // A derived name is the bar by construction, so no hatch excuses it.
        if (derived.has(name)) {
          findings.push({
            ...at,
            why: `${name} is written as ${m[2]}, but it must be derived from LOAD_RUN_BOOKINGS_PER_MINUTE (src/lib/load-bar.ts)`,
          });
          continue;
        }
        if (!RATE_SHAPED.test(name) || !barValues.has(value)) continue;
        const hatch = hatchFor(lines, index);
        if (hatch === null) {
          findings.push({
            ...at,
            why:
              `${name} holds ${barValues.get(value)} as a literal. The bar lives in ONE place, ` +
              `LOAD_RUN_BOOKINGS_PER_MINUTE in src/lib/load-bar.ts; read it from there`,
          });
        } else if (hatch === "") {
          unreasonedHatches.push({ ...at, why: `${LOAD_BAR_HATCH} carries no reason of three words or more` });
        }
        // A reasoned hatch is a recorded decision about a rate that is not the bar.
      }
    });
  }

  const sizing = input.files.find((f) => f.path === input.sizingFile);
  if (!sizing) {
    findings.push({
      path: input.sizingFile,
      line: 0,
      text: "",
      why: `the file that sizes the steady pass was not among the files scanned, so nothing checked it reads the bar`,
    });
  } else if (!/import\s*\{[^}]*\bLOAD_RUN_BOOKINGS_PER_MINUTE\b[^}]*\}\s*from\s*["'][^"']*load-bar(\.ts)?["']/.test(sizing.text)) {
    findings.push({
      path: input.sizingFile,
      line: 0,
      text: "",
      why: `${input.sizingFile} does not import LOAD_RUN_BOOKINGS_PER_MINUTE from src/lib/load-bar.ts, so the steady pass is not sized from the bar`,
    });
  }

  return { findings, unreasonedHatches };
}

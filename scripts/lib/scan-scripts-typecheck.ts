/**
 * Pure scan behind `scripts/test-scripts-typecheck.ts` (#1504): turn `tsc`
 * output into the errors that must fail the build.
 *
 * Split out so the parse and the opt-out rule can be unit tested with fixture
 * lines, rather than only ever being exercised by whatever the tree happens to
 * contain today.
 */

/**
 * The error classes that break at RUNTIME rather than merely describing a
 * sloppy type. An undefined identifier throws the moment the line executes; an
 * unresolved import throws on load. Everything else in the tree (nullable and
 * shape mismatches in test fakes) is real but does not ship broken, so it is
 * left out deliberately rather than forgotten. Add a code here as its class is
 * cleared; the guard's own message says so.
 */
import { hasOptOut as sharedHasOptOut } from "./opt-out.ts";

// TS1294 is syntax `erasableSyntaxOnly` refuses (an enum, a parameter property):
// `node --experimental-strip-types`, which runs every script here, throws on it at
// load (#4362, scripts/test-erasable-syntax-only.ts).
export const BREAKING_CODES = ["TS2304", "TS2307", "TS1294"] as const;

/** The opt-out, matching the repo's other one-line conventions. */
export const OPT_OUT = "typecheck-ok:";

export interface TscError {
  file: string;
  line: number;
  code: string;
  message: string;
}

/** Parse `path(line,col): error TSxxxx: message` lines; ignore everything else. */
export function parseTscErrors(output: string): TscError[] {
  const out: TscError[] = [];
  for (const raw of output.split("\n")) {
    const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(raw.trim());
    if (!m) continue;
    out.push({ file: m[1], line: Number(m[2]), code: m[4], message: m[5] });
  }
  return out;
}

/**
 * True when the error's own line, or the block of `//` comment lines directly
 * above it, carries the opt-out. Same shape as `// cap-safe:` and `// parse-ok:`
 * so there is one thing to learn, and it must carry a reason: a bare marker
 * would let somebody silence a real undefined name with four characters.
 */
export function hasOptOut(sourceLines: string[], lineNumber: number): boolean {
  return sharedHasOptOut(sourceLines, lineNumber - 1, OPT_OUT);
}

/**
 * The errors that must fail the build: the breaking classes, minus any carrying
 * the opt-out. `readSource` is injected so this stays pure and the caller owns
 * the filesystem.
 */
export function breakingErrors(
  output: string,
  readSource: (file: string) => string[],
  codes: readonly string[] = BREAKING_CODES,
): TscError[] {
  return parseTscErrors(output)
    .filter((e) => codes.includes(e.code))
    .filter((e) => !hasOptOut(readSource(e.file), e.line));
}

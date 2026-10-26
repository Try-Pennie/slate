// Static detector for the #4201 guard: a LIST read of `users` must say whether the
// placeholder advisor and the test advisors belong in it. Driven by
// scripts/test-real-advisor-reads.ts.
//
// The defect it prevents. `users` holds the real advisors, the permanent test
// advisors (#396) and, from migration 0207, the placeholder advisor that holds the
// calls a coordinator stacks (#4200). Every screen, picker, pool and monitor that
// lists advisors kept the test ones out with its own `.eq("is_test", false)`, so
// the placeholder, a third kind nobody filtered, would have walked into every one
// of them. The rule now lives in ONE module, `src/lib/advisors/real-advisor.ts`,
// and this scan makes every list read of the table declare itself:
//
//   - wrapped in `realAdvisorsOnly(...)`, the query helper, or in
//     `withoutPlaceholder(...)`, its sibling that keeps the test advisors, or
//   - selecting `REAL_ADVISOR_COLUMNS`, for a read whose rows the JS predicate
//     `isRealAdvisor` judges, or
//   - carrying `// any-advisor-ok: <why>` on, or in the comment block directly
//     above, its `.from("users")` line, for a read that genuinely wants every row.
//
// A read is NOT a list read when it names its subject by key: `.eq`/`.in` on `id`,
// `email` or `auth_user_id`, or a `.single()`/`.maybeSingle()`. The subject was
// chosen upstream, so a filter here would only re-ask a question already answered.
// A chain that never calls `.select(` (a write, or a builder kept for writes) is
// not a read.
//
// Separately, a bare `.eq("is_test", false)` on a users chain anywhere outside the
// shared module is refused even when the chain is otherwise declared, so nobody
// re-adds a test only exclusion that the placeholder walks past.
//
// Deliberately a text scan, in the same family as scan-test-data-counts.ts. The
// chain is read by bracket matching rather than a fixed line window, so a long
// select cannot push the filter out of view.

import { hasOptOut } from "./opt-out.ts";

export interface RealAdvisorFinding {
  file: string;
  line: number;
  kind: "undeclared" | "test-only";
  snippet: string;
}

/** The module that owns the rule, and so may spell the filters itself. */
export const REAL_ADVISOR_MODULE = "src/lib/advisors/real-advisor.ts";

/** Files outside src/ the scan also covers. */
export const EXTRA_SCOPE = ["scripts/lib/calcom-roster.ts"];

export const OPT_OUT = "any-advisor-ok:";

const FROM_RE = /\.from\(\s*["'`]users["'`]\s*\)/g;
const WRITE_RE = /^\s*\.(?:update|insert|upsert|delete)\(/;
/** A key, or a one row read, that names its subject rather than a population. */
const KEYED_RE = /\.(?:eq|in)\(\s*["'`](?:id|email|auth_user_id)["'`]|\.(?:maybeSingle|single)\(/;
const TEST_ONLY_RE = /\.eq\(\s*["'`]is_test["'`]\s*,\s*false\s*\)/;
const HELPERS = ["realAdvisorsOnly(", "withoutPlaceholder("];
const COLUMNS = "REAL_ADVISOR_COLUMNS";

/** Blank out comments, keeping offsets and line numbers. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead: string) => lead + " ".repeat(m.length - lead.length));
}

/** Index just past the bracket that closes the one at `open`, quote aware. */
function closeOf(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      for (i++; i < code.length && code[i] !== q; i++) if (code[i] === "\\") i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return code.length;
}

/** The method chain starting at `.from(` (offset `at`), through its last call. */
function chainAt(code: string, at: number): string {
  let end = closeOf(code, code.indexOf("(", at));
  for (;;) {
    const m = /^\s*\.[A-Za-z_$][\w$]*\s*\(/.exec(code.slice(end));
    if (!m) break;
    end = closeOf(code, end + m[0].length - 1);
  }
  return code.slice(at, end);
}

/** Offsets covered by an argument of either query helper. */
function helperSpans(code: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const helper of HELPERS) {
    for (let at = code.indexOf(helper); at !== -1; at = code.indexOf(helper, at + 1)) {
      const open = at + helper.length - 1;
      spans.push([open, closeOf(code, open)]);
    }
  }
  return spans;
}

function lineOf(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}

/**
 * The opt out may sit above the `.from(` line or above the line its statement
 * starts on (`const { data } = await db` then `.from("users")` below it), so walk
 * up through the statement's own code lines, at most three, and ask at each.
 */
function optedOut(code: string, rawLines: string[], index: number): boolean {
  const lines = code.split("\n");
  let at = index;
  for (let steps = 0; steps < 3; steps++) {
    if (hasOptOut(rawLines, at, OPT_OUT)) return true;
    const above = (lines[at - 1] ?? "").trim();
    if (above === "" || /[;,{}]$/.test(above)) return false;
    at--;
  }
  return hasOptOut(rawLines, at, OPT_OUT);
}

export function scanRealAdvisorReads(source: string, file = "<source>"): RealAdvisorFinding[] {
  if (file === REAL_ADVISOR_MODULE) return [];
  const code = stripComments(source);
  const rawLines = source.split("\n");
  const spans = helperSpans(code);
  const findings: RealAdvisorFinding[] = [];

  for (const m of code.matchAll(FROM_RE)) {
    const at = m.index!;
    const chain = chainAt(code, at);
    const line = lineOf(code, at);
    const snippet = (rawLines[line - 1] ?? "").trim().slice(0, 120);
    const tail = chain.slice(m[0].length);
    if (WRITE_RE.test(tail) || !tail.includes(".select(")) continue;

    if (TEST_ONLY_RE.test(chain)) {
      findings.push({ file, line, kind: "test-only", snippet });
      continue;
    }
    if (KEYED_RE.test(chain)) continue;
    if (spans.some(([s, e]) => at > s && at < e)) continue;
    if (chain.includes(COLUMNS)) continue;
    if (optedOut(code, rawLines, line - 1)) continue;
    findings.push({ file, line, kind: "undeclared", snippet });
  }
  return findings;
}

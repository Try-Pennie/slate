// The set of documents Claude Code loads into EVERY session in this repo, and
// the judge that says whether they still fit the budget (#2393).
//
// `CLAUDE.md` is loaded automatically and its first line is `@AGENTS.md`, so
// both arrive before anything else runs and every character of them is paid on
// every request of every session. Nobody adding a paragraph can see the total,
// which is how the pair reached 166,069 characters with nothing measuring it.
//
// WHAT THE CEILING ACTUALLY IS, measured on 2026-09-17 against Claude Code
// 2.1.274 rather than assumed:
//
//   - There is no per file character cut that this repo could reach. A probe
//     memory file carrying an unguessable end of file nonce was read in full at
//     400,105 characters. At 2,000,043 characters the request was refused for
//     length with the whole file counted (219,376 tokens), so nothing had been
//     trimmed away first. The binary does carry a truncation notice string, so
//     the machinery exists; it is simply not reached at any size a rules file
//     gets to.
//   - The ceiling that DOES bind is the request itself: above 200,000 tokens the
//     request is refused outright, and the memory payload is counted inside it
//     along with the system prompt, the tool definitions, and the work.
//   - The exchange rate was measured on this very file rather than guessed. An
//     otherwise identical session costs 61,314 prompt tokens with an eight
//     character memory file and 103,544 with AGENTS.md as it stood that day
//     (157,721 characters), so AGENTS.md alone cost 42,230 tokens, which is
//     3.73 characters per token and 21 percent of the whole request limit.
//   - Re-measured on 2026-10-15 across whole sessions rather than one file: the
//     rules loaded at startup in Slate sessions came to about 86,000 tokens per
//     request, at 2.78 characters per token, 20 percent of every token read (30
//     percent for subagents). 2.78 is the figure used below. It is lower than the
//     3.73 single file reading, so it overstates tokens rather than understating
//     them, which is the safe direction for a budget. At 2.78 the old 125,000
//     character budget was about 45,000 tokens, not the 33,500 it claimed.
//
// So the budget is a share of the window, not a guess at a cut off. See
// BUDGET_CHARS below for the share chosen and why.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Measured 2026-10-15 across whole Slate sessions: 2.78 characters per token for
 * the rules loaded at startup. (The 2026-09-17 reading on AGENTS.md alone was
 * 3.73: 157,721 characters cost 42,230 tokens.)
 */
export const CHARS_PER_TOKEN = 2.78;

/** The request is refused above this, memory payload counted inside it. */
export const REQUEST_TOKEN_LIMIT = 200_000;

/**
 * The budget for everything this repo auto loads, in characters.
 *
 * 30,000 characters is about 10,800 tokens at the measured rate, 5.4 percent of
 * the 200,000 token request limit. It was set on 2026-10-15, when the files
 * were cut from 124,740 characters to 24,539 by moving runbooks, incident
 * histories and guard designs into `docs/` and leaving each rule with a pointer.
 * The same request also has to carry the machine's global config, the memory
 * index, the tool definitions, every file read during the turn, and the
 * conversation itself, and the startup rules were measured that day at 20
 * percent of every token a Slate session reads.
 *
 * The history before the cut: 125,000 characters (2026-09-17, one sixth of the
 * request at the old 3.73 rate), after growth from 51,740 characters on
 * 2026-08-29 to 157,721 on 2026-09-17, about 5,600 a day. The point of the budget
 * is to make the next long section a decision somebody takes rather than an
 * accident nobody can see, and the remedy when it fires is to move a runbook
 * section into `docs/` and leave the rule with a pointer, never to raise the
 * number without saying what share of the window the new one takes.
 */
export const BUDGET_CHARS = 30_000;

export type LoadedDoc = { path: string; chars: number };

export type BudgetVerdict = {
  docs: LoadedDoc[];
  totalChars: number;
  budgetChars: number;
  estimatedTokens: number;
  shareOfRequestPct: number;
  overBy: number;
  withinBudget: boolean;
};

/** A line-leading `@path` import, the form Claude Code follows. */
const IMPORT_LINE = /^@(\S+)\s*$/;

/**
 * Walk the auto loaded set from an entry file, following `@import` lines the way
 * the platform does. Returns each file once, in the order it is reached.
 *
 * `readFile` is injectable so the guard can drive the walk over a fixture tree
 * with no files on disk.
 */
export function collectAutoLoadedDocs(
  root: string,
  entry: string,
  readFile: (path: string) => string | null = (p) =>
    existsSync(p) ? readFileSync(p, "utf8") : null,
): LoadedDoc[] {
  const seen = new Set<string>();
  const out: LoadedDoc[] = [];
  const queue = [resolve(root, entry)];
  while (queue.length > 0) {
    const path = queue.shift() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    const text = readFile(path);
    if (text === null) continue;
    out.push({ path, chars: text.length });
    for (const line of text.split("\n")) {
      const m = IMPORT_LINE.exec(line.trim());
      if (!m) continue;
      queue.push(resolve(dirname(path), m[1]));
    }
  }
  return out;
}

/** Judge a collected set against the budget. Pure, so both directions are testable. */
export function judgeBudget(
  docs: LoadedDoc[],
  budgetChars: number = BUDGET_CHARS,
): BudgetVerdict {
  const totalChars = docs.reduce((n, d) => n + d.chars, 0);
  const estimatedTokens = Math.round(totalChars / CHARS_PER_TOKEN);
  return {
    docs,
    totalChars,
    budgetChars,
    estimatedTokens,
    shareOfRequestPct: Math.round((estimatedTokens / REQUEST_TOKEN_LIMIT) * 1000) / 10,
    overBy: Math.max(0, totalChars - budgetChars),
    withinBudget: totalChars <= budgetChars,
  };
}

/** The message a reader gets, naming every file so the biggest one is obvious. */
export function describeVerdict(verdict: BudgetVerdict, root: string): string {
  const rows = [...verdict.docs]
    .sort((a, b) => b.chars - a.chars)
    .map((d) => `  ${d.path.replace(root + "/", "").padEnd(24)} ${String(d.chars).padStart(8)}`)
    .join("\n");
  const head = verdict.withinBudget
    ? `auto loaded docs: ${verdict.totalChars} characters, budget ${verdict.budgetChars}`
    : `auto loaded docs are ${verdict.overBy} characters OVER the ${verdict.budgetChars} budget`;
  return [
    head,
    rows,
    `  total                    ${String(verdict.totalChars).padStart(8)}`,
    `  about ${verdict.estimatedTokens} tokens, ${verdict.shareOfRequestPct}% of the ${REQUEST_TOKEN_LIMIT} token request limit`,
    verdict.withinBudget
      ? ""
      : "  Move a runbook section into docs/ and leave the rule with a pointer. Raising the\n  budget is a decision about what share of the window the repo's rules may take.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export { join };

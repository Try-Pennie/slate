/**
 * Scan logic for the shell-in-CI parse safety guard (#1436), kept beside its test
 * so it is unit-testable with positive controls.
 *
 * #1433 found three defects in ONE check: a failing command hidden behind a pipe,
 * zero parsed rows treated as success, and the CLI's own upgrade notice parsed as
 * data. Nobody had looked at whether its siblings shared the pattern, and two of
 * them did (L30: fix the class, not the instance). Both were the same shape:
 *
 *   states="$(gh pr list ... || echo '')"      # a failure becomes empty output
 *   if grep -q OPEN <<<"$states"; then ...     # and empty reads as "nothing found"
 *   echo "nothing blocking"; exit 0            # which reports green having asked nothing
 *
 * So this guard enforces two mechanical properties on every `run:` block in the
 * workflows and the git hooks. Neither can catch a badly ANCHORED pattern, which
 * is the third #1433 defect and needs a human reading the parse, so that one is
 * called out in the test's own header rather than pretended to be covered here.
 *
 *   1. **A parser cannot hide a failing producer.** A block that pipes into
 *      grep/awk/sed/jq/tee/cut/sort/head/tail must set `pipefail`, or the pipeline
 *      reports the PARSER's exit status and a dead producer looks like a clean read.
 *
 *   2. **A swallowed read must be declared.** A command substitution ending in a
 *      `|| echo ...` / `|| true` fallback turns "could not ask" into a value, and
 *      the value is almost always the one that reads as healthy. Some of these are
 *      genuinely correct (a detached HEAD really has no branch), so the rule is
 *      not a ban: it is that each one carries a `# parse-ok:` line saying which
 *      way it fails.
 */

/** One `run:` block, with enough context to report it. */
import { hasOptOut } from "./opt-out.ts";

export interface RunBlock {
  file: string;
  /** 1-based line of the `run:` key itself. */
  line: number;
  /** The block's shell script, dedented. */
  script: string;
}

/** Commands that turn a stream into a decision. A pipe into one of these is a parse. */
const PARSERS = ["grep", "awk", "sed", "jq", "tee", "cut", "sort", "uniq", "head", "tail", "wc", "xargs"];

/** `VAR="$( ... || echo x )"` / `$( ... || true )`: a read whose failure becomes a value. */
const SWALLOWED_READ = /\$\((?:[^()]|\([^()]*\))*\|\|\s*(?:echo\b[^)]*|true)\)/;

/**
 * Pull every `run:` block out of a workflow file.
 *
 * Handles the two shapes the repo uses: `run: |` with an indented body, and a
 * single line `run: node ...`. A `run:` inside a quoted string is not a thing this
 * repo does, and the scanner says so rather than pretending to parse YAML.
 */
export function runBlocks(file: string, source: string): RunBlock[] {
  const lines = source.split("\n");
  const blocks: RunBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^(\s*)(?:-\s+)?run:\s*(\|[-+]?|>[-+]?)?\s*(.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1]!.length;
    const block = m[2];
    const inline = m[3] ?? "";
    if (!block) {
      // Single line form.
      if (inline.trim()) blocks.push({ file, line: i + 1, script: inline });
      continue;
    }
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const next = lines[j]!;
      if (next.trim() === "") {
        body.push("");
        continue;
      }
      const nextIndent = next.length - next.trimStart().length;
      if (nextIndent <= indent) break;
      body.push(next.trimStart());
    }
    blocks.push({ file, line: i + 1, script: body.join("\n") });
    i = j - 1;
  }
  return blocks;
}

/** Does a shell script pipe into something that parses? */
export function pipesIntoParser(script: string): boolean {
  return script.split("\n").some((line) => {
    const code = line.replace(/#.*$/, "");
    // A `||` is not a pipe, and neither is `2>&1` on its own.
    const withoutOr = code.replace(/\|\|/g, "  ");
    const idx = withoutOr.indexOf("|");
    if (idx === -1) return false;
    const after = withoutOr.slice(idx + 1).trim();
    return PARSERS.some((p) => after.startsWith(p));
  });
}

export function setsPipefail(script: string): boolean {
  return /set\s+-[a-z]*o?\s*pipefail|set\s+-o\s+pipefail|set\s+-[a-z]*o\s+pipefail/.test(script);
}

/**
 * Fold `cmd \` continuations into one logical line, keeping the array length so a
 * reported offset still points at where the statement STARTS.
 */
export function joinContinuations(lines: string[]): string[] {
  const out: string[] = new Array(lines.length).fill("");
  let pending: string | null = null;
  let startedAt = 0;
  lines.forEach((line, i) => {
    if (pending === null) startedAt = i;
    const text = pending === null ? line : `${pending} ${line.trim()}`;
    if (/\\\s*$/.test(text)) {
      pending = text.replace(/\\\s*$/, "");
      return;
    }
    pending = null;
    // At the START index, so a `# parse-ok:` comment sitting directly above the
    // statement still sits directly above it after folding. Putting it at the last
    // line instead left the annotation looking detached, which quietly made every
    // multi line read unannotatable.
    out[startedAt] = text;
  });
  if (pending !== null) out[startedAt] = pending;
  return out;
}

/** Is this line, or the comment block directly above it, opted out? */
function optedOut(lines: string[], i: number): boolean {
  // A blank line ENDS the region here, matching this guard's own fixture: a run
  // block's statements are folded onto the line they start on, so a gap between
  // the comment and the statement means the excuse belongs to something else.
  return hasOptOut(lines, i, "parse-ok:", { syntax: ["hash"], blankLineEndsRegion: true });
}

export interface Finding {
  file: string;
  line: number;
  rule: "pipefail" | "swallowed-read";
  message: string;
}

/**
 * Every parse safety finding in one file's `run:` blocks (or, for a shell script,
 * in the whole file when `wholeFile` is set).
 */
export function scanParseSafety(
  file: string,
  source: string,
  opts: { wholeFile?: boolean } = {},
): Finding[] {
  const blocks = opts.wholeFile
    ? [{ file, line: 1, script: source }]
    : runBlocks(file, source);
  const findings: Finding[] = [];

  for (const block of blocks) {
    // Join backslash continuations FIRST. A read written across two lines puts its
    // `|| echo '[]'` on the second one, with no `$(` in sight, so a line-at-a-time
    // scan cannot see it: the worst instance in this repo was exactly that shape,
    // and it was invisible to the first version of this scanner.
    const lines = joinContinuations(block.script.split("\n"));

    if (pipesIntoParser(block.script) && !setsPipefail(block.script)) {
      const hasOptOut = lines.some((_, i) => optedOut(lines, i) && pipesIntoParser(lines[i] ?? ""));
      if (!hasOptOut) {
        findings.push({
          file,
          line: block.line,
          rule: "pipefail",
          message:
            `${file}:${block.line}: this run block pipes into a parser without \`set -o pipefail\`, ` +
            `so a FAILING producer reports the parser's exit status instead and a dead read looks ` +
            `like a clean one (#1433). Add pipefail, or annotate the line with ` +
            `\`# parse-ok: <why a failing producer is safe here>\`.`,
        });
      }
    }

    lines.forEach((line, i) => {
      const code = line.replace(/#.*$/, "");
      if (!SWALLOWED_READ.test(code)) return;
      if (optedOut(lines, i)) return;
      findings.push({
        file,
        line: block.line,
        rule: "swallowed-read",
        message:
          `${file}:${block.line} (+${i + 1} in the block): \`${line.trim()}\` turns a FAILED read ` +
          `into a value, and the value almost always reads as healthy, so the check reports green ` +
          `having asked nothing (#1436). Either tell "could not read" apart from "nothing found", ` +
          `or annotate with \`# parse-ok: <which way it fails, and what covers it>\`.`,
      });
    });
  }

  return findings;
}

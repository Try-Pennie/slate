// ONE reader for every convention guard's one line opt out (#2200).
//
// The repo carries three dozen escape hatches (`// cap-safe:`, `// error-ok:`,
// `// write-ok:`, `// parse-ok:`, `// in-chunk-ok:`, `// typecheck-ok:`,
// `-- search-path-ok:`, `{/* mark-ok: ... */}` and the rest). The MARKER differs
// every time; the reading is the same problem every time: is there a one line
// reason on this line, or in the comment block directly above it, and does it
// actually say anything?
//
// Each scanner answered it for itself, and the copies had already drifted in the
// PERMISSIVE direction, which is the direction that costs nothing to write and
// silently exempts real code:
//
//   - `scan-unsaved-guard.ts` matched the reason as `\s*\S`, and in a JSX comment
//     the block's own `*/` satisfies that, so `{/* unsaved-ok: */}` read as an
//     exemption somebody had reasoned about (#2112, L233).
//   - `scan-capped-reads.ts`, `scan-src-capped-reads.ts`, `scan-date-parse.ts` and
//     `scan-alert-error-text.ts` required no reason at all: their patterns did not
//     even demand the colon, so the bare word silenced the guard.
//   - Half the copies stopped the upward walk at a BLANK line and half stepped
//     over it, so the same comment exempted a read in one guard and not in another.
//   - None of them could see an opt out inside a ternary
//     (`const x = cond ? // error-ok: ...`), which is how `AppHeader.tsx:123` would
//     have become a false positive the day the swallowed read guard widened its
//     surface (#2542). A guard that cries wolf is one people turn off.
//
// So this is the single reader, taking the marker as an ARGUMENT. The token stays
// a parameter rather than being folded into one widened pattern on purpose:
// putting a second rule behind an existing suppression token silently widens
// every existing use of it (L448), so `// write-ok:` remains its own word and an
// `// error-ok:` written about a read can never exempt a write.
//
// WHERE a marker may sit, in one sentence: on the subject's own line, or in the
// comment region directly above it, where "directly above" steps over blank lines
// and over lines carrying nothing but punctuation (`((`, `?`, `)`), because those
// are syntax rather than statements and a comment does not stop being attached to
// the code because a bracket sits between them.
//
// WHAT counts as a reason: text beginning with a letter or a digit. Not merely a
// non-space character, because in a block comment the terminator itself is a
// non-space character and that is exactly how #2112 read a bare marker as
// reasoned. A reason that wraps onto the next comment line still counts, because
// people write sentences.
//
// Unit tested once, against every comment form the tree actually uses and with a
// case per hole already found, by `scripts/test-opt-out-reader.ts`. That test also
// refuses a NEW hand rolled matcher anywhere under `scripts/`, so the next guard
// cannot quietly grow a thirty seventh copy of this (L613).

/** The comment lead-ins a tree may use. TS/TSX is `slash`, SQL `sql`, YAML `hash`. */
export type CommentSyntax = "slash" | "sql" | "hash";

export interface OptOutOptions {
  /** Which line comment lead-ins may carry the marker. Default: `["slash"]`. */
  syntax?: readonly CommentSyntax[];
  /**
   * How many lines above the subject the walk may reach, counting every line it
   * steps over. Default: unbounded, which is what "the block directly above"
   * means; a bound is for a scanner whose subject line is approximate.
   */
  reach?: number;
  /**
   * A BLANK line ends the comment region rather than being stepped over.
   *
   * Off by default, because a blank line between a comment and the code it is
   * about is ordinary formatting and most of the copies this reader replaced
   * stepped over one. It is on for `event-type-write-ok:`, whose own test asserts
   * the stricter reading on the stated grounds that an excuse must not be able to
   * drift away from what it excuses; that is a decision somebody made, so it is
   * named here rather than quietly reversed by consolidating (L542).
   */
  blankLineEndsRegion?: boolean;
}

export interface OptOut {
  /** The marker was found on the line or in the comment region above it. */
  present: boolean;
  /** The text after the marker, `""` when it carried none. */
  reason: string;
  /** The reason begins with a letter or a digit, so it says something. */
  reasoned: boolean;
  /** 0-indexed line the marker sits on, `-1` when absent. */
  line: number;
}

const ABSENT: OptOut = { present: false, reason: "", reasoned: false, line: -1 };

/** Lead-in strings per syntax, longest first so `--` is not read as `-`. */
const LEAD_INS: Readonly<Record<CommentSyntax, readonly string[]>> = {
  slash: ["//"],
  sql: ["--", "//"],
  hash: ["#"],
};

/**
 * A line carrying nothing but punctuation is transparent to the upward walk.
 *
 * `((`, `?`, `)`, `: (`, `} && (` are syntax, not statements: the comment above
 * them is still the comment attached to the code below. This is what makes an opt
 * out inside a ternary readable, and it is deliberately narrow, so no line that
 * DOES anything can be stepped over.
 *
 * A `;` is excluded on purpose. `});` ENDS a statement, so a comment above it
 * belongs to what that statement contained, and stepping over it would let one
 * block's reason exempt the next block's code.
 */
function isPunctuationOnly(trimmed: string): boolean {
  return trimmed !== "" && /^[\s()[\]{}?:,&|.]+$/.test(trimmed);
}

/** Where a line comment starts on this line, or -1. Quote-blind on purpose: a */
/* marker inside a string literal is not something any real file contains. */
function lineCommentAt(line: string, syntax: readonly CommentSyntax[]): number {
  let best = -1;
  for (const s of syntax) {
    for (const lead of LEAD_INS[s]) {
      const at = line.indexOf(lead);
      if (at !== -1 && (best === -1 || at < best)) best = at;
    }
  }
  return best;
}

/**
 * The comment body of a line that is a comment, or `null` when it is code.
 *
 * A line counts as a comment line when everything before its lead-in is
 * punctuation, which is what admits `? // error-ok: ...` and `* a continuation`
 * inside a block comment.
 */
function commentBodyOf(line: string, syntax: readonly CommentSyntax[]): string | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;

  const at = lineCommentAt(line, syntax);
  if (at !== -1) {
    const before = line.slice(0, at).trim();
    if (before === "" || isPunctuationOnly(before)) return line.slice(at);
  }

  // A block comment's own lines: `/* ... */`, `{/* ... */}`, and `* continuation`.
  if (/^\{?\/\*/.test(trimmed) || trimmed.startsWith("*")) return trimmed;
  if (trimmed.endsWith("*/") || trimmed.endsWith("*/}")) return trimmed;

  return null;
}

/** The reason text following `token` in `body`, with a block terminator stripped. */
function reasonAfter(body: string, token: string): string | null {
  const at = body.indexOf(token);
  if (at === -1) return null;
  return body
    .slice(at + token.length)
    .replace(/\*\/\}?\s*$/, "")
    .trim();
}

/**
 * A reason says something when it contains a LETTER (L233, L675).
 *
 * Not "begins with a letter", which several of the copies used: real reasons
 * routinely open with a backticked identifier (`` `reason` is our own sentence ``)
 * and refusing those would send people to rewrite correct annotations. Not
 * "any non-space character" either, which is the hole #2112 found: in a block
 * comment the terminator itself is a non-space character, so `{/* mark-ok: *\/}`
 * read as reasoned. A terminator is stripped before this is asked, so what is
 * left has to be words.
 */
function saysSomething(reason: string): boolean {
  return /[A-Za-z]/.test(reason);
}

/**
 * Read the opt out for `token` attached to line `at` (0-indexed).
 *
 * `token` is the marker WITH its colon (`"error-ok:"`), so a guard can never be
 * satisfied by prose that merely names the convention.
 */
export function readOptOut(
  lines: readonly string[],
  at: number,
  token: string,
  options: OptOutOptions = {},
): OptOut {
  const syntax = options.syntax ?? (["slash"] as const);
  const reach = options.reach ?? Number.POSITIVE_INFINITY;

  // The region: the subject's own line, plus every comment or punctuation-only
  // line directly above it, top to bottom.
  const region: { index: number; body: string }[] = [];
  const own = lines[at] ?? "";
  const ownAt = lineCommentAt(own, syntax);
  region.push({ index: at, body: ownAt === -1 ? own : own.slice(ownAt) });

  let steps = 0;
  for (let i = at - 1; i >= 0 && steps < reach; i--, steps++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (trimmed === "") {
      if (options.blankLineEndsRegion) break;
      continue;
    }
    if (isPunctuationOnly(trimmed)) continue;

    // A BLOCK comment is consumed whole, from its terminator up to its `/*`.
    // Its middle lines are ordinary prose (a sentence wraps, and the wrapped
    // lines start with a word), so reading them one at a time meets the second
    // line of the reason, calls it code, and stops short of the marker on the
    // block's first line. That is how a real `{/* unsaved-ok: ... */}` three
    // lines long excused nothing.
    if (trimmed.endsWith("*/") || trimmed.endsWith("*/}")) {
      let open = i;
      while (open >= 0 && !(lines[open] ?? "").includes("/*")) open--;
      if (open >= 0) {
        for (let k = i; k >= open; k--) region.unshift({ index: k, body: (lines[k] ?? "").trim() });
        steps += i - open;
        i = open;
        continue;
      }
    }

    const body = commentBodyOf(raw, syntax);
    if (body === null) break;
    region.unshift({ index: i, body });
  }

  for (let r = 0; r < region.length; r++) {
    const reason = reasonAfter(region[r]!.body, token);
    if (reason === null) continue;
    if (saysSomething(reason)) {
      return { present: true, reason, reasoned: true, line: region[r]!.index };
    }
    // A reason that wraps onto the next comment line still counts: people write
    // sentences, and a guard that refused one would push everybody onto one long
    // line instead of onto a real reason.
    for (let k = r + 1; k < region.length; k++) {
      const next = region[k]!;
      if (next.index === at) break; // the subject's own line is code, not prose.
      const text = next.body
        .replace(/^[\s{]*(?:\/\/|--|#|\/\*|\*)+/, "")
        .replace(/\*\/\}?\s*$/, "")
        .trim();
      if (text === "") break;
      return { present: true, reason: text, reasoned: saysSomething(text), line: region[r]!.index };
    }
    return { present: true, reason, reasoned: false, line: region[r]!.index };
  }

  return ABSENT;
}

/**
 * The usual question: is this subject exempt, with a reason somebody wrote?
 *
 * A marker carrying no reason is NOT an exemption. An entry with no written
 * reason beside neighbours that each carry one is evidence it was never reasoned
 * about (L233), and four characters must never be enough to silence a guard.
 */
export function hasOptOut(
  lines: readonly string[],
  at: number,
  token: string,
  options: OptOutOptions = {},
): boolean {
  const found = readOptOut(lines, at, token, options);
  return found.present && found.reasoned;
}

/**
 * The marker is present, reasoned or not.
 *
 * For the guards that report an unreasoned hatch as its OWN finding rather than
 * ignoring it, so "somebody wrote the marker and said nothing" is visible instead
 * of reading as a site nobody ever annotated.
 */
export function hasBareOptOut(
  lines: readonly string[],
  at: number,
  token: string,
  options: OptOutOptions = {},
): boolean {
  return readOptOut(lines, at, token, options).present;
}

/**
 * The marker on THIS line only, for a guard that reports an unreasoned hatch as
 * its own finding and so has to walk the file line by line without the block
 * above each one answering for it.
 */
export function readOptOutOnLine(
  line: string,
  token: string,
  options: OptOutOptions = {},
): OptOut {
  const syntax = options.syntax ?? (["slash"] as const);
  const at = lineCommentAt(line, syntax);
  const body = at === -1 ? (commentBodyOf(line, syntax) ?? "") : line.slice(at);
  const reason = reasonAfter(body, token);
  if (reason === null) return ABSENT;
  return { present: true, reason, reasoned: saysSomething(reason), line: 0 };
}

/**
 * The marker, with a reason, ANYWHERE in this text.
 *
 * The file-scoped variant, for the handful of rules whose subject is the whole
 * file rather than a line: a migration that rewinds its export cursor at the
 * bottom rather than beside each write, a module that enumerates the tree, a
 * stylesheet exempted wholesale. Same reason rule, same comment forms, so the two
 * scopes cannot disagree about what a reason is.
 */
export function readTextOptOut(
  text: string,
  token: string,
  options: OptOutOptions = {},
): OptOut {
  const syntax = options.syntax ?? (["slash"] as const);
  const lines = text.split("\n");
  let bare: OptOut = ABSENT;
  for (let i = 0; i < lines.length; i++) {
    const body = commentBodyOf(lines[i] ?? "", syntax);
    if (body === null) continue;
    const reason = reasonAfter(body, token);
    if (reason === null) continue;
    if (saysSomething(reason)) return { present: true, reason, reasoned: true, line: i };
    // A reason that wrapped onto the next comment line still counts.
    const next = commentBodyOf(lines[i + 1] ?? "", syntax);
    const wrapped =
      next === null
        ? ""
        : next
            .replace(/^[\s{]*(?:\/\/|--|#|\/\*|\*)+/, "")
            .replace(/\*\/\}?\s*$/, "")
            .trim();
    if (saysSomething(wrapped)) return { present: true, reason: wrapped, reasoned: true, line: i };
    if (!bare.present) bare = { present: true, reason, reasoned: false, line: i };
  }
  return bare;
}

/** `readTextOptOut`, asked as the usual yes or no. */
export function textHasOptOut(
  text: string,
  token: string,
  options: OptOutOptions = {},
): boolean {
  const found = readTextOptOut(text, token, options);
  return found.present && found.reasoned;
}

/** 0-indexed line holding byte offset `index` in `source`. */
export function lineIndexOfOffset(source: string, index: number): number {
  let line = 0;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/** `readOptOut` for a scanner that holds a byte offset rather than a line. */
export function readOptOutAtOffset(
  source: string,
  index: number,
  token: string,
  options: OptOutOptions = {},
): OptOut {
  return readOptOut(source.split("\n"), lineIndexOfOffset(source, index), token, options);
}

/** `hasOptOut` for a scanner that holds a byte offset rather than a line. */
export function hasOptOutAtOffset(
  source: string,
  index: number,
  token: string,
  options: OptOutOptions = {},
): boolean {
  const found = readOptOutAtOffset(source, index, token, options);
  return found.present && found.reasoned;
}

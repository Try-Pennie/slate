import ts from "typescript";

// Static detector for the #3325 guard: a call to the confirm line that is not
// awaited. See scripts/test-unawaited-line-calls.ts for why it matters and the
// controls that prove it catches the pattern.
//
// A line call is a seat method (`claim`, `claimFirst`, `claimBeside`, `pass`,
// `claimedByOthers`) reached through a `seat`, or a turn's `done`. It is flagged on
// a line where it is not preceded by `await` or `return`, ignoring comments. That
// is a line based check, deliberately: every call site the confirm path has is one
// statement on one line, and a multi line call would have to start with `await`
// on its first line to pass, which is the shape wanted anyway.

/** The two files that hold the SYNCHRONOUS in memory seat, which is not a promise. */
export const LINE_CALL_EXEMPT_FILES = ["src/lib/booking/confirm-queue.ts", "src/lib/booking/confirm-line-object.ts"];

const CALL = /\b(?:seat\??\.(?:claimFirst|claimBeside|claimedByOthers|claim|pass)|turn\??\.done)\s*\(/g;

/**
 * The source with every comment blanked to spaces, newlines kept, so line numbers and
 * columns still match (#3350). The comments are found by the TypeScript parser, which
 * knows where a string, a template literal or a regular expression ends: cutting each
 * line at its first `//` hid a call written after a URL in a string.
 */
export function blankComments(file: string, source: string): string {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const chars = source.split("");
  const blank = (ranges: readonly ts.CommentRange[] | undefined) => {
    for (const r of ranges ?? []) for (let i = r.pos; i < r.end; i++) if (chars[i] !== "\n") chars[i] = " ";
  };
  const visit = (node: ts.Node) => {
    blank(ts.getLeadingCommentRanges(source, node.getFullStart()));
    blank(ts.getTrailingCommentRanges(source, node.getEnd()));
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  return chars.join("");
}

export function unawaitedLineCalls(file: string, source: string): string[] {
  const out: string[] = [];
  const code = blankComments(file, source).split("\n");
  source.split("\n").forEach((raw, i) => {
    const line = code[i] ?? "";
    for (const m of line.matchAll(CALL)) {
      const before = line.slice(0, m.index);
      if (/\b(await|return)\s+(\S+\s+)?$/.test(before) || /\bawait\s+[\w?.]*$/.test(before)) continue;
      out.push(`${file}:${i + 1}: ${raw.trim()}`);
    }
  });
  return out;
}

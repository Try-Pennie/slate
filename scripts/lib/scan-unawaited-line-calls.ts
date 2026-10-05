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

export function unawaitedLineCalls(file: string, source: string): string[] {
  const out: string[] = [];
  source.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, "");
    if (/^\s*\*/.test(line)) return; // inside a block comment
    for (const m of line.matchAll(CALL)) {
      const before = line.slice(0, m.index);
      if (/\b(await|return)\s+(\S+\s+)?$/.test(before) || /\bawait\s+[\w?.]*$/.test(before)) continue;
      out.push(`${file}:${i + 1}: ${raw.trim()}`);
    }
  });
  return out;
}

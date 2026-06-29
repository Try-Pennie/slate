// Unit test for the smoke scripts' .env loader (scripts/smoke-env.ts). The
// manual smoke scripts read keys (BOOKING_API_KEY, etc.) straight from
// process.env; this parser loads them from .env.local / .dev.vars line-by-line so
// shell-sourcing quirks (an unmatched quote on some unrelated line) can't break a
// run. Run: node --experimental-strip-types scripts/test-smoke-env.ts
import { parseEnvFile } from "./smoke-env.ts";

let failures = 0;
const assert = (c: boolean, m: string) => {
  if (!c) {
    console.error("FAIL:", m);
    failures++;
  } else console.log("ok:", m);
};

// Plain KEY=VALUE.
assert(parseEnvFile("BOOKING_API_KEY=abc123").BOOKING_API_KEY === "abc123", "parses a plain KEY=VALUE");

// Double- and single-quoted values get unquoted.
assert(parseEnvFile('K="quoted value"').K === "quoted value", "strips surrounding double quotes");
assert(parseEnvFile("K='quoted value'").K === "quoted value", "strips surrounding single quotes");

// A value containing '=' keeps everything after the first '='.
assert(parseEnvFile("URL=https://x.co/a?b=c&d=e").URL === "https://x.co/a?b=c&d=e", "keeps '=' inside the value");

// Comments and blank lines are ignored.
const c = parseEnvFile("# a comment\n\nA=1\n   \nB=2");
assert(c.A === "1" && c.B === "2" && !("# a comment" in c), "ignores comments and blank lines");

// The breakage that motivated this: an unmatched quote on one line must NOT throw
// or corrupt other keys (shell `source` dies here; the parser must not).
const robust = parseEnvFile('A=1\nWEIRD="unterminated\nB=2');
assert(robust.A === "1" && robust.B === "2", "an unmatched quote on one line does not break other keys");

// `export KEY=VALUE` prefix (some .env files use it) is tolerated.
assert(parseEnvFile("export TOKEN=xyz").TOKEN === "xyz", "tolerates an 'export ' prefix");

// Surrounding whitespace around the value is trimmed.
assert(parseEnvFile("K=  spaced  ").K === "spaced", "trims surrounding whitespace on the value");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

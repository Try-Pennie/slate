// Every wiring of the alert dispatcher forwards what a check says its page names (2026-10-26).
//
// A check hands its page to an injected `notify` (`ThrottledNotify`), whose optional
// fourth argument is the `AlertRepeat` the dispatcher's change rule reads (#3801): which
// subjects the page names, so it can tell a change from the same facts said again. The
// wiring that connects a check to the real dispatcher was written as
// `(key, ms, text) => sendThrottledAlert(key, ms, text)` in twenty four places, which
// type checks (a lambda may take fewer parameters than its type offers) and silently
// DROPS that fourth argument. So a check that names its subjects was judged on its
// message's own lines instead, and every tick whose wording moved (a read that failed,
// a nearest time that walked) read as a new subject and posted again. The below tier
// page (`belowLeadTierRepeat`) was about to be the first check that depends on it.
//
// This guard fails on the next wiring arrow into `sendThrottledAlert` or
// `sendThrottledInfo` that does not take and pass on a fourth argument. A wiring that
// hands over the function itself (`notify: sendThrottledAlert`) forwards everything
// and is not an arrow, so it is out of scope. An arrow whose arguments themselves hold
// parentheses is not read by this pattern; none exists today, and the positive
// controls below say what is read.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-notify-forwards-repeat.ts
import { readFileSync } from "node:fs";
import { assert, eq, finish } from "./lib/harness.ts";
import { sourceFiles } from "./lib/source-files.ts";

const ARROW = /\(([^()]*)\)\s*=>\s*sendThrottled(?:Alert|Info)\(([^()]*)\)/g;

const count = (list: string): number => list.split(",").filter((s) => s.trim() !== "").length;

/**
 * Lines holding a dispatcher wiring arrow that drops the fourth argument. A wiring
 * takes the seam's parameters; an arrow taking none is a deferred send of a page the
 * enclosing code built (`afterResponse(..., () => sendThrottledAlert(...))`), which
 * forwards nothing because it was handed nothing.
 */
export function droppingArrows(src: string): number[] {
  const lines: number[] = [];
  src.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(ARROW)) {
      const params = count(m[1] ?? "");
      if (params > 0 && (params < 4 || count(m[2] ?? "") < 4)) {
        lines.push(i + 1);
        break;
      }
    }
  });
  return lines;
}

// --- the predicate sees the shapes it exists to catch ---------------------------
eq(
  droppingArrows("deps({\n  notify: (key, ms, text) => sendThrottledAlert(key, ms, text),\n})").join(","),
  "2",
  "positive control: a three argument wiring is caught, on its line",
);
eq(
  droppingArrows("  notify: (key, ms, text, repeat) => sendThrottledAlert(key, ms, text),").length,
  1,
  "positive control: taking the fourth argument and not passing it on is caught",
);
eq(
  droppingArrows("  notify: (k, c, t) => sendThrottledInfo(k, c, t).catch(logIt(k)),").length,
  1,
  "positive control: the info sender, and a trailing catch, are read too",
);
eq(
  droppingArrows("  notify: (key, ms, text, repeat) => sendThrottledAlert(key, ms, text, repeat),").length,
  0,
  "a wiring that forwards the fourth argument passes",
);
eq(droppingArrows("  notify: sendThrottledAlert,").length, 0, "handing over the function itself forwards everything");
eq(
  droppingArrows('  afterResponse("x", () => sendThrottledAlert(KEY, COOLDOWN, page));').length,
  0,
  "a deferred send that takes no parameters is not a wiring",
);

// --- the real tree ------------------------------------------------------------
const files = sourceFiles({ match: /\.tsx?$/, exclude: (f) => f.includes(".test.") });
const offenders: string[] = [];
let wirings = 0;
for (const file of files) {
  const src = readFileSync(file, "utf8");
  wirings += [...src.matchAll(ARROW)].length;
  for (const line of droppingArrows(src)) offenders.push(`${file}:${line}`);
}
// Twenty four arrows were found when this guard was written; finding none would mean
// the pattern stopped reading them, not that they are all fine (L98).
assert(wirings >= 20, `the scan reads the dispatcher wiring arrows in src (found ${wirings})`);
assert(
  offenders.length === 0,
  `every dispatcher wiring passes on the page's AlertRepeat (the fourth argument); these drop it:\n  ${offenders.join("\n  ")}`,
);

finish();

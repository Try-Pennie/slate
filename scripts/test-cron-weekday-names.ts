// No Cloudflare cron may write its weekday as a number (#2814).
//
// `0 13 * * 1-5` was written as Monday to Friday. Cloudflare counts 1 = Sunday, so
// it ran Sunday to Thursday: the pending time off nudge no-opped every Sunday and
// never ran on a Friday, and the monitor then paged about a 500 that never
// happened. The day names mean the same thing on every cron system; the numbers do
// not. So this reads every expression wrangler.jsonc configures AND every key of
// worker/cron-routes.ts (test-cron-routes.ts keeps those two equal; both are read
// here so neither can be the one that slips) and refuses a digit in the fifth field.
//
// Run: node --experimental-strip-types scripts/test-cron-weekday-names.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CRON_ROUTES } from "../worker/cron-routes.ts";
import { numericWeekdayProblem, parseWeekdayField } from "./lib/cloudflare-cron-weekday.ts";
import { assert, finish } from "./lib/harness.ts";

const root = join(import.meta.dirname, "..");
const config = JSON.parse(
  readFileSync(join(root, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
) as { triggers?: { crons?: string[] } };
const configured = config.triggers?.crons ?? [];
const routed = Object.keys(CRON_ROUTES);

// Positive control: the guard must catch the exact expression that shipped, and
// pass the forms that are unambiguous (L1).
assert(numericWeekdayProblem("0 13 * * 1-5") !== null, "control: 0 13 * * 1-5 is refused");
assert(numericWeekdayProblem("0 13 * * 2-6") !== null, "control: 0 13 * * 2-6 is refused too, correct or not");
assert(numericWeekdayProblem("0 18 * * 6L") !== null, "control: a numeric L form is refused");
assert(numericWeekdayProblem("0 13 * * MON-FRI") === null, "control: 0 13 * * MON-FRI passes");
assert(numericWeekdayProblem("0 13 * * mon-fri") === null, "control: lower case names pass");
assert(numericWeekdayProblem("* * * * *") === null, "control: * * * * * passes");
assert(numericWeekdayProblem("*/5 3 * * *") === null, "control: digits outside the weekday field are fine");
assert(numericWeekdayProblem("0 13 * *") !== null, "control: a four field expression is refused, not skipped");

// The parser the bounds suite relies on reads names and refuses numbers.
const monFri = parseWeekdayField("MON-FRI");
assert(monFri !== null && [...monFri].sort().join(",") === "1,2,3,4,5", "MON-FRI parses to Monday to Friday");
assert(parseWeekdayField("sat,SUN")?.size === 2, "a comma list of names parses");
assert(parseWeekdayField("1-5") === null, "a numeric range is refused by the parser, never guessed");
assert(parseWeekdayField("FRI-MON") === null, "a backwards range is refused");

assert(configured.length > 0, `wrangler.jsonc configures cron triggers (${configured.length})`);
assert(routed.length > 0, `worker/cron-routes.ts routes cron expressions (${routed.length})`);
for (const [where, crons] of [
  ["wrangler.jsonc", configured],
  ["worker/cron-routes.ts", routed],
] as const) {
  for (const cron of crons) {
    const problem = numericWeekdayProblem(cron);
    assert(problem === null, problem ? `${where}: ${problem}` : `${where}: "${cron}" has an unambiguous weekday`);
  }
}

finish();

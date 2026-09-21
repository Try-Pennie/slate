// One list of weekday names, in Luxon's order, in one place (#2572).
//
// `WEEKDAY_NAMES` (`src/lib/schedule-core.ts`) is indexed by Luxon's weekday
// (1 = Monday .. 7 = Sunday) with a blank at 0, and three files had re-typed it as a
// local `DAY_NAMES`. A set whose meaning is its ORDER needs the order asserted (L545),
// and nothing did: a copy with Sunday first would have named every refusal after the
// wrong day and no test would have moved. So the order is pinned against Luxon
// itself, and the tree is scanned for the next hand typed copy.
//
// The cal.com list in `src/lib/calcom/overrides.ts` is NOT this constant: it is zero
// based and Sunday first, because that is cal.com's weekday convention, so it is named
// for that and deliberately outside this scan.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-weekday-names.ts
import { readFileSync } from "node:fs";
import { DateTime } from "luxon";
import { assert, eq, finish } from "./lib/harness.ts";
import { sourceFiles } from "./lib/source-files.ts";
import { WEEKDAY_NAMES } from "../src/lib/schedule-core.ts";

const HOME = "src/lib/schedule-core.ts";

// --- the order is Luxon's --------------------------------------------------------
eq(WEEKDAY_NAMES.length, 8, "eight entries: a blank at 0 and Luxon's seven weekdays");
eq(WEEKDAY_NAMES[0], "", "index 0 is blank, so a 0 weekday reads as nothing rather than as Sunday");
for (let weekday = 1; weekday <= 7; weekday++) {
  const luxon = DateTime.fromObject({ weekday }, { zone: "utc" }).setLocale("en-US").weekdayLong;
  eq(WEEKDAY_NAMES[weekday], luxon, `index ${weekday} is what Luxon calls weekday ${weekday}`);
}

// --- the scan sees a Luxon shaped copy, wherever the line breaks fall ------------
/** A Luxon shaped list: a blank, then Monday. Whitespace is collapsed first because
 *  the copies were written on one line and the home on eight. */
export function luxonWeekdayListCopies(src: string): number {
  const flat = src.replace(/\s+/g, "");
  return flat.split('"","Monday","Tuesday","Wednesday"').length - 1;
}
eq(
  luxonWeekdayListCopies(
    'const DAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];',
  ),
  1,
  "positive control: the one line copy is seen",
);
eq(
  luxonWeekdayListCopies('const X = [\n  "",\n  "Monday",\n  "Tuesday",\n  "Wednesday",\n];'),
  1,
  "positive control: the multi line spelling is the same copy",
);
eq(
  luxonWeekdayListCopies('const CALCOM = ["Sunday", "Monday", "Tuesday", "Wednesday"];'),
  0,
  "cal.com's Sunday first list is a different constant, not a copy",
);

// --- the real tree ---------------------------------------------------------------
eq(luxonWeekdayListCopies(readFileSync(HOME, "utf8")), 1, `${HOME} holds the one definition`);
const offenders: string[] = [];
for (const file of sourceFiles({ match: /\.tsx?$/, exclude: (f) => f.includes(".test.") || f === HOME })) {
  if (luxonWeekdayListCopies(readFileSync(file, "utf8")) > 0) offenders.push(file);
}
assert(
  offenders.length === 0,
  `weekday names come from WEEKDAY_NAMES in ${HOME}; hand typed copies in:\n  ${offenders.join("\n  ")}`,
);

finish();

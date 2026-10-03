// Which day a browser spec opens on the booker is owned by ONE fixture,
// `openDayWithTimes` in `e2e/fixtures.ts`.
//
// The booker keeps a day on its strip when every time left on it falls outside
// the lead's calling window (#2310), so the strip's FIRST day is not a day with
// times to pick. Late in the Eastern afternoon (after about 17:30, with the
// seeded two hour notice and the 8 PM window end) today's remaining times are
// all outside the window, and a spec that clicked the first chip and waited for
// times failed every run from then until the evening rolled today off the strip.
// That is the 2026-10-03 browser leg outage: green at 16:50 Eastern, red at 17:12.
//
// A spec therefore never addresses the day strip itself. Any line in
// `e2e/tests/` naming the strip's accessible name is a finding, unless it (or
// the comment block directly above it) carries `// day-choice-ok: <reason>`, read
// by the shared opt out reader (`scripts/lib/opt-out.ts`). The rule is on the NAME rather than on one
// spelling of a click, because the outage was spelled two ways (`.first().click()`
// on the locator, and a `days` variable clicked later), and a third spelling
// would pass a scan for either.

import { hasOptOut } from "./opt-out.ts";

export const DAY_STRIP_NAME = "Available days";

export type DayChoiceFinding = { file: string; line: number; text: string };

function optedOut(lines: string[], i: number): boolean {
  return hasOptOut(lines, i, "day-choice-ok:");
}

export function scanDayChoice(file: string, source: string): DayChoiceFinding[] {
  const lines = source.split("\n");
  const findings: DayChoiceFinding[] = [];
  lines.forEach((text, i) => {
    if (!text.includes(DAY_STRIP_NAME)) return;
    if (text.trim().startsWith("//") || text.trim().startsWith("*")) return;
    if (optedOut(lines, i)) return;
    findings.push({ file, line: i + 1, text: text.trim() });
  });
  return findings;
}

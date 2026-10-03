// A browser spec never picks the booker's day itself (the 2026-10-03 browser
// leg outage). It calls `openDayWithTimes` from `e2e/fixtures.ts`, which walks
// the strip until a day actually offers times, so the suite passes at any hour
// rather than only before about 17:30 Eastern. The reasoning lives in
// `scripts/lib/scan-e2e-day-choice.ts`.
//
// Run: node --experimental-strip-types scripts/test-e2e-day-choice.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, eq, finish } from "./lib/harness.ts";
import { DAY_STRIP_NAME, scanDayChoice } from "./lib/scan-e2e-day-choice.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SPECS = join(ROOT, "e2e", "tests");

// --- positive controls: both spellings the outage shipped in are caught (L1) -------

const firstClick = `await page.getByRole("group", { name: "${DAY_STRIP_NAME}" }).getByRole("button").first().click();`;
eq(scanDayChoice("a.spec.ts", firstClick).length, 1, "clicking the first chip directly is a finding");

const viaVariable = [
  `const days = page.getByRole("group", { name: "${DAY_STRIP_NAME}" }).getByRole("button");`,
  "await days.first().click();",
].join("\n");
eq(scanDayChoice("a.spec.ts", viaVariable).length, 1, "a strip locator held in a variable is a finding");

// --- the escape hatch needs a reason, and a comment ABOUT the strip is not a use ---

eq(
  scanDayChoice("a.spec.ts", `// day-choice-ok: only checks the chip is drawn\nconst x = "${DAY_STRIP_NAME}";`).length,
  0,
  "an opt out with a reason above the line is honoured",
);
eq(
  scanDayChoice("a.spec.ts", `const x = "${DAY_STRIP_NAME}"; // day-choice-ok: only checks the chip is drawn`).length,
  0,
  "an opt out with a reason on the line is honoured",
);
eq(
  scanDayChoice("a.spec.ts", `// day-choice-ok:\nconst x = "${DAY_STRIP_NAME}";`).length,
  1,
  "an opt out with no reason is not honoured",
);
eq(
  scanDayChoice("a.spec.ts", `// the ${DAY_STRIP_NAME} strip keeps a day with no offerable times`).length,
  0,
  "a comment naming the strip is not a use of it",
);

// --- the real specs ----------------------------------------------------------------

const files = readdirSync(SPECS).filter((f) => f.endsWith(".spec.ts"));
assert(files.length >= 3, `the scan read the real spec directory (${files.length} specs)`);
const findings = files.flatMap((f) => scanDayChoice(f, readFileSync(join(SPECS, f), "utf8")));
assert(
  findings.length === 0,
  `no spec picks the booker's day itself; use openDayWithTimes from e2e/fixtures.ts:\n${findings
    .map((f) => `  ${f.file}:${f.line}  ${f.text}`)
    .join("\n")}`,
);

// The fixture the specs are pointed at must exist and must be the one walking the
// strip, or the message above sends people to nothing (L406).
const fixtures = readFileSync(join(ROOT, "e2e", "fixtures.ts"), "utf8");
assert(
  /export async function openDayWithTimes\(/.test(fixtures) && fixtures.includes(DAY_STRIP_NAME),
  "e2e/fixtures.ts exports openDayWithTimes and owns the strip's name",
);

finish();

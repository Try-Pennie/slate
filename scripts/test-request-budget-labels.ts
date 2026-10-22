// Only the booking confirm opens a request; every other budget is one Google call's own (#3980).
//
// The rule and why it is a scan lives in `scripts/lib/scan-request-budgets.ts`. In short:
// the mint and token read lines name a lead's confirm only by `request="the booking confirm"`,
// and every other label is a single Google call's, so a second request level budget would
// make any reading of those lines count the wrong ones as the confirm path again.
// Run: node --experimental-strip-types scripts/test-request-budget-labels.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { EXPECTED_BUDGET_OPENERS, findBudgetOpeners } from "./lib/scan-request-budgets.ts";

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

// --- the decision, on fixtures ----------------------------------------------

eq(
  findBudgetOpeners(`return withinCallBudget(BOOKING_CONFIRM_BUDGET_MS, "the booking confirm", work);`),
  ["\"the booking confirm\""],
  "a string label is read",
);
eq(
  findBudgetOpeners("return withinCallBudget(deadline, `google ${label}`, call);"),
  ["`google ${label}`"],
  "a template label is read as written",
);
eq(
  findBudgetOpeners(`withinCallBudget(\n  12_000,\n  "the lead's move",\n  work,\n);`),
  ["\"the lead's move\""],
  "a call spread over several lines is read",
);
eq(
  findBudgetOpeners(`export function withinCallBudget<T>(\n  ms: number,\n  label: string,\n) {}`),
  [],
  "the definition is not an opener",
);
eq(
  findBudgetOpeners(`// withinCallBudget(1, "old", w)\n/* withinCallBudget(2, "older", w) */`),
  [],
  "a call quoted in a comment is not an opener",
);
eq(findBudgetOpeners(`withinCallBudgetish(1, "x", w)`), [], "only the function itself is read");

// --- the tree ----------------------------------------------------------------

const found: string[] = [];
const files = sources("src");
for (const file of files) {
  if (file === join("src", "lib", "call-budget.ts")) continue;
  for (const label of findBudgetOpeners(readFileSync(file, "utf8"))) found.push(`${file} ${label}`);
}
eq(
  found.sort(),
  [...EXPECTED_BUDGET_OPENERS].sort(),
  "the booking confirm is the only request level budget; every other is one Google call's own. " +
    "A new opener changes what a request label means: update the readings on DELEGATED_TOKEN_TIMEOUT_MS " +
    "(src/lib/google/dwd.ts) and the comments on requestLabel and MintContext.request, then this list",
);
// The scan has to have READ the tree, or an empty list means nothing (L98).
assert(files.length > 300, `the scan read the tree (${files.length} files)`);

// Positive control on REAL code: the calendar wrapper opening a request labelled like the
// confirm, in memory, is caught as a change.
{
  const calendar = readFileSync(join("src", "lib", "google", "calendar.ts"), "utf8");
  assert(calendar.includes("withinCallBudget(deadline, `google ${label}`, call)"), "calendar.ts still opens its own budget (control premise)");
  const broken = calendar.replace("withinCallBudget(deadline, `google ${label}`, call)", 'withinCallBudget(deadline, "the booking confirm", call)');
  eq(findBudgetOpeners(broken), ["\"the booking confirm\""], "a calendar budget relabelled as the confirm is seen");
}

finish();

// #3124: the booking load run's bar is ONE number, `LOAD_RUN_BOOKINGS_PER_MINUTE` in
// src/lib/load-bar.ts, and the load test code may not hold its own copy of it again.
//
// Until #3124 the run held its own 60 (four drivers at fifteen in
// scripts/loadtest/book-plan.ts) beside the 70 Dan set, so the bar the daily busy
// minute alert judged and the bar the run drove were two numbers nothing tied together.
// Pointing the run at the constant fixes this instance; this guard is what stops the
// next copy (L613), since a copy never reaches for the shared constant (L370).
//
// The decisions are in scripts/lib/scan-load-bar-literals.ts. This drives them with
// fixtures, then over the real scripts/loadtest tree and the load test workflow (must
// be clean), then plants the old hand set pacing back into the REAL book-plan.ts, in
// memory only, and requires the scan to catch it (L1).
//
// Run: node --experimental-strip-types scripts/test-load-bar-literals.ts
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { LOAD_RUN_BOOKINGS_PER_MINUTE } from "../src/lib/load-bar.ts";
import { scanLoadBarLiterals, RETIRED_LOAD_BARS, type LoadBarFile } from "./lib/scan-load-bar-literals.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const SIZING = "scripts/loadtest/book-plan.ts";
const DERIVED = ["PER_DRIVER_PER_MINUTE", "STEADY_DRIVERS_AT_PRODUCTION", "STEADY_CONFIRMS_PER_ADVISOR_PER_MINUTE"];
const IMPORT = `import { LOAD_RUN_BOOKINGS_PER_MINUTE } from "../../src/lib/load-bar.ts";\n`;

const scan = (files: LoadBarFile[], bar = 70) =>
  scanLoadBarLiterals({ files, bar, derivedNames: DERIVED, sizingFile: SIZING });
const one = (text: string, path = "scripts/loadtest/x.ts") =>
  scan([{ path: SIZING, text: IMPORT }, { path, text }]);

// --- fixtures ----------------------------------------------------------------------

eq(RETIRED_LOAD_BARS, [60], "60 is the bar Dan raised past (2026-10-20)");

{
  const r = one("export const TARGET_PER_MINUTE = 70;\n");
  eq(r.findings.length, 1, "a rate shaped constant holding the bar is a copy");
  assert(/load-bar\.ts/.test(r.findings[0]?.why ?? ""), "and the finding names where the bar lives");
  eq(r.findings[0]?.line, 1, "on the line it is written");
}
eq(one("const plan = { total: 140, perMinute: 60 };\n").findings.length, 1, "the retired 60 as a pace is a copy too");
eq(one("const LOAD_BAR = 70\n").findings.length, 1, "a name ending in bar holding it is a copy");
eq(one("  bar: 70,\n").findings.length, 1, "and so is a property called bar");
eq(one("const LOAD_RUN_BOOKINGS_PER_MINUTE = 70;\n").findings.length, 1, "a shadow of the constant itself is a copy");
eq(one("perMinute: 70\n", ".github/workflows/loadtest.yml").findings.length, 1, "a workflow key holding it is a copy");
eq(one("const total = 70;\n").findings.length, 0, "a number that is not a rate is not the bar");
eq(one("const perMinute = 30;\n").findings.length, 0, "a rate that is not the bar is not flagged");
eq(one("const gap = 60_000 / perMinute;\n").findings.length, 0, "milliseconds in a minute are not the bar");
eq(one("const perMinute = 60_000 / gap;\n").findings.length, 0, "and neither is a rate computed from them");
eq(one("if (perMinute == 70) go();\n").findings.length, 0, "a comparison is not a binding");
eq(one("// perMinute: 60, as the old run drove\n").findings.length, 0, "a comment is prose about old runs");
eq(one(" * PER_DRIVER_PER_MINUTE = 15 at the old bar\n").findings.length, 0, "and so is a doc comment");
eq(one("const perMinute = 70; // the bar\n").findings.length, 1, "a trailing comment does not excuse the code before it");
eq(one("const perMinute = 70;\n", "scripts/loadtest/x.ts").findings.length, 1, "a const binding");
eq(scan([{ path: SIZING, text: IMPORT }, { path: "a.ts", text: "x = 1;\nperMinute: 60\n" }]).findings[0]?.line, 2, "line numbers count from one");
// The bar is read from the constant, so raising it moves the scan with it.
eq(scan([{ path: SIZING, text: IMPORT }, { path: "a.ts", text: "perMinute: 80\n" }], 80).findings.length, 1, "at a bar of 80, 80 is the copy");
eq(scan([{ path: SIZING, text: IMPORT }, { path: "a.ts", text: "perMinute: 70\n" }], 80).findings.length, 0, "and 70 is then just a rate");

// The derived names: any literal at all, whatever its value, and no hatch excuses it.
{
  const r = one("export const PER_DRIVER_PER_MINUTE = 15;\n");
  eq(r.findings.length, 1, "a hand set pace per driver is a second bar");
  assert(/derived/.test(r.findings[0]?.why ?? ""), "and it says the pace must be derived");
  eq(one("export const STEADY_DRIVERS_AT_PRODUCTION = 5;\n").findings.length, 1, "so is a hand set driver count");
  eq(
    one("// load-bar-ok: this is fine because I say it is\nexport const PER_DRIVER_PER_MINUTE = 14;\n").findings.length,
    1,
    "and no hatch excuses a derived name",
  );
  eq(one("export const PER_DRIVER_PER_MINUTE = steadyPacingFor(LOAD_RUN_BOOKINGS_PER_MINUTE).perDriverPerMinute;\n").findings.length, 0, "a derived one is clean");
}

// The hatch.
{
  const reasoned = one("// load-bar-ok: the warm up reads once a second, not the bar\nconst plan = { perMinute: 60 };\n");
  eq(reasoned.findings.length, 0, "a reasoned hatch in the block above excuses a rate that is not the bar");
  eq(reasoned.unreasonedHatches.length, 0, "and is not reported");
  const inline = one("const plan = { perMinute: 60 }; // load-bar-ok: one read a second for the warm up\n");
  eq(inline.findings.length, 0, "a reasoned hatch on the line excuses it too");
  const bare = one("// load-bar-ok:\nconst plan = { perMinute: 60 };\n");
  eq(bare.findings.length, 0, "an unreasoned hatch is not reported as a plain copy");
  eq(bare.unreasonedHatches.length, 1, "it is reported as a hatch with no reason");
  eq(one("// load-bar-ok: fine\nconst plan = { perMinute: 60 };\n").unreasonedHatches.length, 1, "one word is not a reason");
  eq(one("// load-bar-ok: one read a second\n\nconst plan = { perMinute: 60 };\n").findings.length, 1, "a hatch across a blank line governs nothing");
}

// The sizing file must import the bar.
{
  const r = scan([{ path: SIZING, text: "export const RUN_MINUTES = 10;\n" }]);
  eq(r.findings.length, 1, "a sizing file that never imports the bar is a finding");
  assert(/does not import/.test(r.findings[0]?.why ?? ""), "naming the missing import");
  const absent = scan([{ path: "scripts/loadtest/other.ts", text: "" }]);
  eq(absent.findings.length, 1, "a scan that never saw the sizing file says so rather than passing");
  assert(/not among the files scanned/.test(absent.findings[0]?.why ?? ""), "in its own words");
}

// --- the real tree -----------------------------------------------------------------

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const realFiles: LoadBarFile[] = [
  ...walk(join(ROOT, "scripts", "loadtest")),
  join(ROOT, ".github", "workflows", "loadtest.yml"),
].map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, "utf8") }));

assert(realFiles.length > 20, `the scan read the load test tree (${realFiles.length} files)`);
assert(realFiles.some((f) => f.path === SIZING), "including the file that sizes the steady pass");
assert(realFiles.some((f) => f.path === ".github/workflows/loadtest.yml"), "and the workflow");

const real = scanLoadBarLiterals({
  files: realFiles,
  bar: LOAD_RUN_BOOKINGS_PER_MINUTE,
  derivedNames: DERIVED,
  sizingFile: SIZING,
});
for (const f of real.findings) console.error(`  ${f.path}:${f.line}: ${f.why}\n    ${f.text}`);
for (const f of real.unreasonedHatches) console.error(`  ${f.path}:${f.line}: ${f.why}\n    ${f.text}`);
eq(real.findings.length, 0, "the load test code holds no copy of the bar");
eq(real.unreasonedHatches.length, 0, "and every load-bar-ok hatch carries its reason");

// Every derived name really is declared in the sizing file, so the derived rule is
// aimed at something rather than at names nobody writes (L96).
{
  const sizing = realFiles.find((f) => f.path === SIZING)?.text ?? "";
  for (const name of DERIVED) {
    assert(new RegExp(`export const ${name}\\b`).test(sizing), `${SIZING} declares ${name}`);
  }
}

// --- positive controls on the REAL sizing file, in memory -----------------------------

{
  const sizing = realFiles.find((f) => f.path === SIZING)!;
  const others = realFiles.filter((f) => f.path !== SIZING);
  const planted = (text: string) =>
    scanLoadBarLiterals({
      files: [...others, { path: SIZING, text }],
      bar: LOAD_RUN_BOOKINGS_PER_MINUTE,
      derivedNames: DERIVED,
      sizingFile: SIZING,
    }).findings;

  // The pre #3124 pacing, put back.
  const handSet = sizing.text.replace(
    /export const PER_DRIVER_PER_MINUTE = [^;]+;/,
    "export const PER_DRIVER_PER_MINUTE = 15;",
  );
  assert(handSet !== sizing.text, "control: the plant found the pacing line to replace");
  assert(
    planted(handSet).some((f) => f.path === SIZING && /PER_DRIVER_PER_MINUTE/.test(f.why)),
    "control: a hand set pace in the real book-plan.ts is caught",
  );

  // A second constant beside the real one.
  assert(
    planted(`${sizing.text}\nexport const STEADY_TARGET_PER_MINUTE = ${LOAD_RUN_BOOKINGS_PER_MINUTE};\n`).some(
      (f) => /STEADY_TARGET_PER_MINUTE/.test(f.why),
    ),
    "control: a copy of the bar added beside the real code is caught",
  );

  // The import removed.
  const unimported = sizing.text.replace(/^import \{ LOAD_RUN_BOOKINGS_PER_MINUTE \} from [^\n]+\n/m, "");
  assert(unimported !== sizing.text, "control: the plant found the import to remove");
  assert(planted(unimported).some((f) => /does not import/.test(f.why)), "control: a sizing file that stops importing the bar is caught");
}

finish();

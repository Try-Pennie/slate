// Every `<label>` in src/ is associated with a control (#3080).
//
// The rule and why it is a scan rather than a list of fixed sites lives in
// `scripts/lib/scan-bare-labels.ts`. In short: a label that neither carries
// `htmlFor` nor wraps its control names nothing, and the shape kept coming back
// after #1950 fixed it in one component (L613).
// Run: node --experimental-strip-types scripts/test-label-association.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { findBareLabels } from "./lib/scan-bare-labels.ts";

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

// --- the decision, on fixtures ----------------------------------------------

eq(findBareLabels(`<label className={labelCls}>Role</label>\n<SelectField name="role" />`).length, 1,
  "a bare label above a control is caught");
eq(findBareLabels(`<label className={labelCls} htmlFor="role">Role</label>`).length, 0,
  "a label with htmlFor passes");
eq(findBareLabels(`<label className="flex">\n  <input type="checkbox" name="x" />\n  All day\n</label>`).length, 0,
  "a label wrapping an input passes");
eq(findBareLabels(`<label className="flex">\n  <span>Timezone</span>\n  <SelectField name="tz" />\n</label>`).length, 0,
  "a label wrapping the design system select passes");
eq(findBareLabels(`<label className="flex">Caption only</label>\n<input name="y" />`).length, 1,
  "a label whose control is its SIBLING, not its child, is caught");
eq(findBareLabels(`<label\n  className={x}\n  onClick={() => a > b}\n>Role</label>`).length, 1,
  "a > inside an attribute expression does not end the tag early");
eq(findBareLabels(`{/* it used to render a bare <label>Role</label> */}\n// <label>Old</label>`).length, 0,
  "a label quoted in a comment is not a label");
eq(findBareLabels(`<labelish>x</labelish>`).length, 0, "only the label element itself is read");
eq(findBareLabels(`<label className={x} />`).length, 1, "a self closing label is caught");

// --- the tree ----------------------------------------------------------------

const offenders: string[] = [];
let labels = 0;
const files = sources("src");
for (const file of files) {
  const text = readFileSync(file, "utf8");
  labels += (text.match(/<label(?=[\s>])/g) ?? []).length;
  for (const b of findBareLabels(text)) offenders.push(`${file}:${b.line} ${b.tag}`);
}
assert(
  offenders.length === 0,
  `every <label> carries htmlFor or wraps its control:\n    ${offenders.join("\n    ")}`,
);

// The scan has to have READ labels, or a clean result means nothing (L98).
assert(labels > 30, `the scan read the tree's labels (${labels} across ${files.length} files)`);

// Positive control on REAL code: the shared Field with its association removed,
// in memory, must be caught. Field is the component #1950 fixed, so this is the
// exact regression the guard exists for.
{
  const field = readFileSync(join("src", "components", "admin", "Field.tsx"), "utf8");
  assert(/htmlFor=\{id\}/.test(field), "Field still associates its label (control premise)");
  const broken = field.replace(/\s*htmlFor=\{id\}/, "");
  eq(findBareLabels(broken).length, 1, "Field with htmlFor removed is caught");
}

finish();

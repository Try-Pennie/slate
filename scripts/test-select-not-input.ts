// A select is not a text input, and may not borrow its padding (#1854).
//
// Dan, on the roster filters: the dropdown arrows sat hard against the right
// edge of their boxes. The cause was not those four controls. Every `<select>`
// in the app took its padding from a class written for a text INPUT, and the two
// cannot share one horizontal value and both look right: an input spends its
// right padding on empty space after the text, a select spends it on the arrow.
// A select needs MORE room on the right than an input, and it was getting the
// same or less.
//
// So the guard is not "the padding is 36px", which would pass the moment
// somebody reached for the nearest existing style again. It is that a select
// does not use the INPUT's class at all: the two classes must stay separate, or
// this comes back the next time a select is added (L63, L96).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-select-not-input.ts
import { readFileSync, readdirSync } from "node:fs";
import { assert, eq, finish } from "./lib/harness.ts";
import { inputCls, selectCls } from "../src/components/ui/styles.ts";

// --- the two classes are distinct, and distinct in the right direction -------
assert(selectCls !== inputCls, "a select does not simply reuse the input's class");

const padding = (cls: string) => {
  const l = /(?:^|\s)p[lx]-(\d+)/.exec(cls);
  const r = /(?:^|\s)p[rx]-(\d+)/.exec(cls);
  return { left: l ? Number(l[1]) : NaN, right: r ? Number(r[1]) : NaN };
};
const sel = padding(selectCls);
// Positive controls: a regex that stopped matching yields NaN, and every
// comparison with NaN is false, so the assertion below would pass while
// measuring nothing (L50).
assert(Number.isFinite(sel.left), `the select's left padding was read (${sel.left})`);
assert(Number.isFinite(sel.right), `the select's right padding was read (${sel.right})`);
assert(
  sel.right > sel.left,
  `a select reserves more room on the right than the left (${sel.right} > ${sel.left}), because the arrow lives there`,
);

// --- and nothing in the tree hands a select the input's class ----------------
const files = readdirSync("src", { recursive: true, encoding: "utf8" })
  .filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f))
  .map((f) => `src/${f}`);
assert(files.length > 50, `the sweep really walked src (${files.length} files)`);

/** The class expression on a `<select ...>` tag, or null when it carries none. */
function selectClassNames(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/<select\b/g)) {
    const rest = text.slice(m.index);
    let depth = 0;
    let end = rest.length;
    for (let i = 0; i < rest.length; i++) {
      const ch = rest[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) { end = i; break; }
    }
    out.push(rest.slice(0, end));
  }
  return out;
}

const INPUT_STYLES = /\binputCls\b|\bfilterCtl\b|\btzInputCls\b/;
const offenders: string[] = [];
for (const f of files) {
  const text = readFileSync(f, "utf8");
  selectClassNames(text).forEach((tag, i) => {
    if (INPUT_STYLES.test(tag)) offenders.push(`${f} (select #${i + 1})`);
  });
}
eq(
  offenders.join(", "),
  "",
  "no select borrows a text input's class; use selectCls",
);

// A positive control on the scan: it must still recognise the shape it hunts
// for, or an expression that stopped matching would report a clean tree (L98).
eq(
  selectClassNames('<select name="role" className={inputCls}>').length,
  1,
  "the scan still finds a select tag",
);
assert(
  INPUT_STYLES.test('<select name="role" className={inputCls}>'),
  "and still recognises the input class on one",
);
assert(
  INPUT_STYLES.test('<select className={`${inputCls} w-40`}>'),
  "including inside a template string, which is how most of them were written",
);
assert(
  !INPUT_STYLES.test('<select className={`${selectCls} w-40`}>'),
  "and does not flag the select's own class, or every fixed call site would fail",
);

finish();

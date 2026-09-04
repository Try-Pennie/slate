// Nothing points at the retired settings hub, and no textarea wears the single
// line input style (#1949, #1945).
//
// #1748 split `/admin/settings` into its own routes and left the page as a bare
// `redirect("/admin")`, kept so an old bookmark lands somewhere real. Two kinds
// of leftover survived that split, and both were found by eye rather than by
// anything failing:
//
//   the ACTION side (#1922)  six server actions redirected there, so a save
//                            landed on Health and the outcome query was dropped
//                            by the second redirect: a refusal reached nobody.
//   the LINK side (#1949)    three pages carried "Back to settings", a link
//                            whose label named a screen that no longer exists.
//
// So this holds the whole app to it, rather than the three files that happened
// to have one (L96).
//
// The textarea half is here because it is the same shape of mistake: a shared
// constant applied where it does not fit, invisible until somebody looked. A
// `<textarea>` wearing `inputCls` renders with `h-[44px]` overriding its `rows`,
// no vertical padding so its text touches both edges, and `inline-block` so a
// sibling button lands on the same line 0px away. All four measured on the live
// page before the fix.
// Run: node --experimental-strip-types scripts/test-retired-hub-and-textareas.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Source with the prose blanked, so a comment ABOUT the hub is not a pointer AT it. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => (/^\s*\/\//.test(line) ? "" : line))
    .join("\n");
}

const files = sources("src");
assert(files.length > 100, `the scanner found the app to judge (saw ${files.length} files)`);

// --- nothing points at the retired hub ---------------------------------------
//
// The redirect page itself is the one thing allowed to name it, since being that
// redirect is its whole job.
const HUB_PAGE = join("src", "app", "admin", "settings", "page.tsx");
const pointers: string[] = [];
for (const file of files) {
  if (file === HUB_PAGE) continue;
  const text = code(readFileSync(file, "utf8"));
  text.split("\n").forEach((line, i) => {
    if (/["\`]\/admin\/settings/.test(line)) pointers.push(`${file}:${i + 1}`);
  });
}
assert(
  pointers.length === 0,
  `nothing sends a reader or a save to the retired hub:\n    ${pointers.join("\n    ")}`,
);

// --- no textarea wears the single line style ---------------------------------
//
// Both tag shapes are read. A textarea written with a closing tag rather than as
// self closing is the same element, and a scan that saw only `/>` would report a
// tree full of them as clean (L98).
const TEXTAREA_TAG = /<textarea(?:[^>]|\n)*?(?:\/>|>)/g;

const seen: { file: string; line: number; tag: string }[] = [];
for (const file of files) {
  const text = code(readFileSync(file, "utf8"));
  for (const m of text.matchAll(TEXTAREA_TAG)) {
    seen.push({
      file,
      line: text.slice(0, m.index).split("\n").length,
      tag: m[0],
    });
  }
}
assert(seen.length >= 3, `the scanner found the textareas to judge (saw ${seen.length})`);

const wrong = seen
  .filter((t) => /\binputCls\b/.test(t.tag))
  .map((t) => `${t.file}:${t.line}`);
assert(
  wrong.length === 0,
  `every textarea uses textareaCls, not the single line inputCls:\n    ${wrong.join("\n    ")}`,
);

// An admin textarea must reach the shared constant rather than carry its own
// class list, because a hand rolled one is how the next copy of this defect
// arrives under a name no check knows (L30). The rule is by LOCATION, not by a
// list of filenames: a new admin page is covered the day it is written (L96).
// The booker's own textarea (`ReasonPicker`) is deliberately outside that scope,
// styled for the lead facing panel rather than the admin field.
const adminHandRolled = seen
  .filter((t) => t.file.startsWith(join("src", "app", "admin")))
  .filter((t) => !/\btextareaCls\b/.test(t.tag))
  .map((t) => `${t.file}:${t.line}`);
assert(
  adminHandRolled.length === 0,
  `every admin textarea uses textareaCls:\n    ${adminHandRolled.join("\n    ")}`,
);

// The style itself has to keep the three properties it exists for, or a textarea
// pointed at it inherits the same defect under a new name.
const styles = readFileSync(join("src", "components", "ui", "styles.ts"), "utf8");
const decl = styles.match(/export const textareaCls\s*=([\s\S]*?);\n/)?.[1] ?? "";
assert(decl.length > 0, "textareaCls is declared");
assert(!/\bh-\[/.test(decl), "textareaCls sets no fixed height, so `rows` decides the size");
assert(/\bpy-/.test(decl), "textareaCls has vertical padding, so its text does not touch the edges");
// Read as CLASS TOKENS, not as a substring. `\bblock\b` is satisfied by
// `inline-block`, since the hyphen is a word boundary, so the one value this
// assertion exists to reject passed it.
const tokens = decl.split(/[\s"'`+]+/).filter(Boolean);
assert(
  tokens.includes("block"),
  `textareaCls is display block, so a sibling button cannot flow beside it (tokens: ${tokens.join(" ")})`,
);
assert(
  !tokens.some((t) => t.startsWith("inline")),
  `textareaCls is not inline, which would put a sibling button on its line (tokens: ${tokens.join(" ")})`,
);

finish();

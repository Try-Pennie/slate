// #2008: a field that holds its own value and forgets to opt into the restore.
//
// #1994 keeps what was typed across the reload a stale save forces. `SaveForm`
// restores ordinary uncontrolled inputs by walking the form and assigning to
// them. A control that owns its value in React state cannot be restored that
// way: an assignment to its hidden input is overwritten by the next render and
// the form posts the stored value instead. Those read `useRestoredValue(name)`
// as their INITIAL state, and mark their input `data-restore-own` so the blanket
// restore leaves it alone.
//
// Neither half is enforced by anything, and both fail silently. A new stateful
// field, or an existing one refactored to hold its own state, simply does not
// come back after a deploy killed the save: the person sees it empty and has no
// way to know whether it was ever kept.
//
// THE TWO HALVES CANNOT BE INFERRED FROM EACH OTHER, which is why this is two
// rules. A field that reads the value but does not mark its input has the
// blanket restore fighting its state. A field that marks its input but never
// reads the value is excluded from the blanket restore AND restores nothing,
// which is strictly worse than not opting in at all.
//
// Run: node --experimental-strip-types scripts/test-restore-optin.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, fail, finish } from "./lib/harness.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(p) && !/\.test\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * A component that RENDERS A HIDDEN INPUT FROM ITS OWN STATE, which is the shape
 * that cannot be restored from outside.
 *
 * A hidden input whose value is a literal or a prop is fine: nothing re-renders
 * it out from under an assignment. It is `value={somethingDerivedFromState}`
 * that fights the blanket restore, so the test is whether the file holds state
 * at all and renders a hidden input with an expression.
 */
/**
 * Source with comments removed.
 *
 * Every check below looks for a marker in the code, and the code that carries
 * one also EXPLAINS it directly above: reading the raw file, a component that
 * had `data-restore-own` deleted still passed, because the sentence saying what
 * `data-restore-own` does was still there. A guard satisfied by its own
 * documentation is one that cannot fail (L103).
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Whether the value read back is actually USED.
 *
 * Asking only whether `useRestoredValue` is CALLED passes a component that calls
 * it, assigns the result, and then ignores it, which restores nothing while
 * every marker is present. So the name it is assigned to has to appear again.
 */
function readsAndUses(src: string): boolean {
  const m = src.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*useRestoredValue\s*\(/);
  if (!m) return false;
  const uses = src.split(new RegExp(`\\b${m[1]}\\b`)).length - 1;
  return uses >= 2;
}

function ownsItsValue(src: string): boolean {
  const hidden = /<input[^>]*type="hidden"[^>]*value=\{/s.test(src);
  const holdsState = /\buseState\s*[(<]/.test(src);
  return hidden && holdsState;
}

const files = walk("src/components").concat(walk("src/app"));
assert(files.length > 50, `the scanner found components to judge (${files.length})`);

const WRAPPER = join("src", "components", "ui", "SaveForm.tsx");

/**
 * SCOPED TO WHAT IS ACTUALLY INSIDE THE WRAPPER.
 *
 * The restore only exists for a form that goes through `SaveForm`. Judging a
 * form that still posts straight at a server action would accuse a component of
 * not taking part in something that does not happen to it, which is noise, and
 * noise is what gets a rule switched off rather than obeyed.
 *
 * A file is in scope when it renders a `<SaveForm>` itself, or when a file that
 * does renders it. One hop, deliberately: it is what the app's composition
 * actually is today, and a deeper walk would claim a reach nobody has measured.
 * The rest arrive as their own form migrates, which is #1998.
 */
const wrapperFiles = files.filter((f) => /<SaveForm\b/.test(readFileSync(f, "utf8")));
assert(wrapperFiles.length > 0, "some form goes through the wrapper");

const inScope = new Set(wrapperFiles);
for (const f of wrapperFiles) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/from "@\/components\/([\w/.-]+)"/g)) {
    for (const cand of files) {
      if (cand.endsWith(join("src", "components", ...m[1].split("/")) + ".tsx")) inScope.add(cand);
    }
  }
}

const findings: string[] = [];
let stateful = 0;
for (const f of files) {
  if (f === WRAPPER) continue;
  if (!inScope.has(f)) continue;
  const raw = readFileSync(f, "utf8");
  const src = code(raw);
  if (!ownsItsValue(src)) continue;
  // The escape hatch, for a component whose own form has not moved onto the
  // wrapper yet: there is no restore for it to take part in, so demanding it
  // would be asking for something that cannot happen. It needs a reason, and the
  // reason is expected to name the issue that removes it (L233, L65).
  const exempt = raw.match(/restore-optin-ok:\s*(.+)/);
  if (exempt) {
    if (exempt[1].trim().length < 12) {
      findings.push(`${f}: restore-optin-ok with no real reason`);
    } else if (!/#\d+/.test(raw.slice(raw.indexOf("restore-optin-ok:"), raw.indexOf("restore-optin-ok:") + 300))) {
      findings.push(`${f}: restore-optin-ok names no issue that will remove it`);
    }
    continue;
  }
  stateful++;
  const reads = readsAndUses(src);
  const marks = /data-restore-own/.test(src);
  if (reads && marks) continue;
  if (!reads && !marks) {
    findings.push(
      `${f}: renders a hidden input from its own state and does neither half, so it will not come back after a deploy killed the save`,
    );
  } else if (!marks) {
    findings.push(
      `${f}: reads useRestoredValue but does not mark its input data-restore-own, so the blanket restore fights its state`,
    );
  } else {
    findings.push(
      `${f}: marks its input data-restore-own but never reads useRestoredValue, so it is excluded from the blanket restore and restores nothing, which is worse than not opting in`,
    );
  }
}

if (findings.length) {
  for (const x of findings) fail(x);
} else {
  assert(true, "every field that owns its value takes part in the restore");
}

// THE RULE HAS SUBJECTS. Without this the whole file passes over an app where
// nothing owns its value at all, in exactly the same words (L98).
assert(stateful >= 1, `there are fields that own their value to judge (${stateful})`);

// And the one that DOES take part really does, so this is not passing because
// the detector reads nothing.
{
  const tf = code(readFileSync(join("src", "components", "ui", "TimeField.tsx"), "utf8"));
  assert(ownsItsValue(tf), "the time field is seen to own its value");
  assert(readsAndUses(tf), "and to read the restored value AND use it");
  assert(/data-restore-own/.test(tf), "and to mark its input");
}

// ---------------------------------------------------------------------------
// Positive controls, one per way of getting it wrong.
// ---------------------------------------------------------------------------
{
  const stateHidden = `
const [text, setText] = useState("");
return <input type="hidden" name={name} value={resolved} />;
`;
  assert(ownsItsValue(stateHidden), "a hidden input rendered from state is recognised");

  // A hidden input carrying a prop or a literal is NOT this shape: nothing
  // re-renders it out from under the blanket restore, so accusing it would make
  // the rule noise on the commonest hidden input in the app.
  assert(
    !ownsItsValue(`return <input type="hidden" name="user_id" value={userId} />;`),
    "a hidden input with no state behind it is left alone",
  );
  assert(
    !ownsItsValue(`const [open, setOpen] = useState(false);\nreturn <p>hi</p>;`),
    "and so is a component that holds state but renders no hidden input",
  );
}

// A control over the REAL tree: take each half away in memory and require the
// rule to catch it. A synthetic fixture agrees with my assumption by
// construction (L52); this asserts it would catch the real component.
{
  const path = join("src", "components", "ui", "TimeField.tsx");
  const real = readFileSync(path, "utf8");
  for (const [label, broken] of [
    ["the read", real.replace(/useRestoredValue\s*\(/g, "noRestore(")],
    // The result assigned but never used, which is the shape that passed a
    // check on whether the function was merely called.
    ["the use", real.replace(/restored \?\? defaultValue/g, "defaultValue")],
    ["the marker", real.replace(/data-restore-own="true"/g, 'data-nothing="true"')],
  ] as [string, string][]) {
    assert(broken !== real, `the overlay removing ${label} changed the real source`);
    const reads = readsAndUses(code(broken));
    const marks = /data-restore-own/.test(code(broken));
    assert(
      ownsItsValue(broken) && !(reads && marks),
      `removing ${label} from the real component is caught`,
    );
  }
}

eq(findings.length, 0, "no field owning its value is left out of the restore");

finish();

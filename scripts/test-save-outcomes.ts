// #1990: a form that saves and says nothing.
//
// The confirmation on the admin pages travels as `?ok=` on a redirect and is
// drawn by `SettingsSaveNotice`. That worked while a page held one form. Several
// hold three or four, and the flag carried no NAME, so whichever form redirected
// lit whatever sentence the page had hardcoded. On /admin/business-hours saving
// the booking horizon printed "Hours saved.", naming a week it had not touched.
// On /admin/buckets changing the direct booking fallback confirmed and creating
// an actual pool did not.
//
// Silence on such a page is worse than on a page with no notice at all: the page
// has already shown somebody that it confirms saves, so the next silence reads
// as a failure rather than as a feature nobody built.
//
// Two rules here, and the guard matters as much as the fix: without it the next
// hand rolled silent form grows back, and nothing would say so.
//
// Run: node --experimental-strip-types scripts/test-save-outcomes.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  findReasonlessExemptions,
  findSilentActions,
  scanActions,
  scanFormActions,
  type SaveOutcomeFinding,
} from "./lib/scan-save-outcomes.ts";
import {
  DYNAMIC_OUTCOME_REASONS,
  SAVE_OUTCOMES,
  SAVE_OUTCOME_COPY,
  savedOutcome,
  savedQuery,
  savedSentence,
  type SaveOutcome,
} from "../src/lib/admin/save-outcomes.ts";
import { assert, eq, fail, finish } from "./lib/harness.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const FILES = [...walk("src/app"), ...walk("src/components")];
const ACTION_FILES = FILES.filter((f) => /actions\.ts$/.test(f));

// ---------------------------------------------------------------------------
// The vocabulary: every outcome has a sentence, somewhere, and one only.
// ---------------------------------------------------------------------------
{
  for (const key of SAVE_OUTCOMES) {
    const fixed = key in SAVE_OUTCOME_COPY;
    const dynamic = key in DYNAMIC_OUTCOME_REASONS;
    // An outcome with NO sentence anywhere is the defect wearing a new coat: the
    // action redirects, the page renders nothing, and the save is silent again
    // while every part reads as wired up.
    assert(fixed || dynamic, `${key} has a sentence, fixed or built by the page`);
    assert(
      !(fixed && dynamic),
      `${key} has one sentence, not two that can disagree (L41)`,
    );
  }
  eq(
    Object.keys(SAVE_OUTCOME_COPY).length + Object.keys(DYNAMIC_OUTCOME_REASONS).length,
    SAVE_OUTCOMES.length,
    "no sentence exists for an outcome the union does not name",
  );
  for (const [key, sentence] of Object.entries(SAVE_OUTCOME_COPY)) {
    // Every sentence names what was saved. "Saved." on a page with four forms is
    // the thing this whole change exists to remove, so a bare one fails here.
    assert(
      sentence.trim().split(/\s+/).length >= 2,
      `"${sentence}" says what was saved, not just that something was (${key})`,
    );
  }
  for (const reason of Object.values(DYNAMIC_OUTCOME_REASONS)) {
    assert(reason.length > 20, "a page built sentence says why it is built there");
  }
}

// The parser refuses what it does not know, which is not tidiness: `ok=1` is
// still in bookmarks and pasted links, and resolving it to any sentence would
// confirm a save nobody performed on a page that was just opened.
{
  eq(savedOutcome("alerts"), "alerts", "a real outcome resolves");
  eq(savedOutcome("1"), null, "the old unnamed flag resolves to nothing");
  eq(savedOutcome("Alerts"), null, "an outcome is matched exactly, not loosely");
  eq(savedOutcome(""), null, "an empty value is nothing");
  eq(savedOutcome(undefined), null, "an absent value is nothing");
  eq(savedSentence(null), null, "nothing to say about no outcome");
  // #1997: `working-hours` is ordinary fixed copy now ("Hours saved."), because
  // reciting the week put it on screen three times at once. The DYNAMIC map is
  // empty as a result, so the assertion that a page built sentence is not
  // invented here is made against the mechanism rather than against an entry
  // that no longer exists.
  eq(savedSentence("alerts"), SAVE_OUTCOME_COPY.alerts, "a fixed outcome reads its own copy");
  {
    const invented = (Object.keys(DYNAMIC_OUTCOME_REASONS) as SaveOutcome[]).map((k) =>
      savedSentence(k),
    );
    eq(
      invented.filter((x) => x !== null).length,
      0,
      "no page built outcome has a sentence invented here",
    );
  }
  assert((savedSentence("alerts") ?? "").length > 0, "a fixed outcome has its sentence");
  eq(savedQuery("bucket-created"), "?ok=bucket-created", "the query is built in one place");
}

// ---------------------------------------------------------------------------
// Rule one: an action a form submits to, which changes something, has to report
// what happened.
// ---------------------------------------------------------------------------

/** Every action name used as a form's action anywhere in the app. */
const submitted = new Set<string>();
for (const f of FILES) {
  for (const name of scanFormActions(readFileSync(f, "utf8"))) submitted.add(name);
}
assert(submitted.size > 5, `forms were actually found (${submitted.size} action names)`);
// A control on the collector itself, because a regex that matched nothing would
// make every action exempt and the whole rule silently inert (L98).
assert(submitted.has("setBusinessHours"), "the collector finds a plain `action={x}`");
assert(
  submitted.has("createBucket") && submitted.has("updateBucket"),
  "the collector follows a conditional `action={a ? b : c}`, which is where two of these hid",
);

const findings: SaveOutcomeFinding[] = [];
for (const f of ACTION_FILES) {
  const src = readFileSync(f, "utf8");
  findings.push(...findSilentActions(f, src, submitted));
  findings.push(...findReasonlessExemptions(f, src));
}
if (findings.length) {
  for (const x of findings) fail(`${x.file}: ${x.name} ${x.why}`);
} else {
  assert(true, "every form action that changes something reports what happened");
}

// The rule has real subjects. A scan whose file list or shapes stopped matching
// would report a clean tree in exactly the same words.
{
  const all = ACTION_FILES.flatMap((f) => scanActions(readFileSync(f, "utf8")));
  const subjects = all.filter((a) => submitted.has(a.name) && a.writes);
  assert(subjects.length >= 8, `the rule has subjects to judge (${subjects.length})`);
  assert(
    subjects.some((a) => a.reportsOutcome),
    "and at least one of them is seen to satisfy it, so the shapes really match",
  );
}

// ---------------------------------------------------------------------------
// Rule two: a page that mounts the notice must be able to light it.
// ---------------------------------------------------------------------------
{
  const pages = FILES.filter((f) => /page\.tsx$/.test(f)).filter((f) =>
    readFileSync(f, "utf8").includes("SettingsSaveNotice"),
  );
  assert(pages.length >= 5, `pages mounting the notice were found (${pages.length})`);
  for (const f of pages) {
    const src = readFileSync(f, "utf8");
    // It has to READ the outcome. A page mounting the notice while never
    // consulting `?ok=` can only ever draw nothing, which looks exactly like a
    // page whose forms happen not to have saved yet.
    assert(
      /savedOutcome\s*\(/.test(src),
      `${f} reads the save outcome rather than mounting a notice it cannot light`,
    );
    // And it must not go back to a bare truthiness check, which is what let one
    // form's flag light another form's sentence.
    assert(
      !/ok=\{!!\s*(?:sp|query)\??\.ok\s*\}/.test(src),
      `${f} decides by the outcome's NAME, not by whether any flag is present`,
    );
  }
}

// ---------------------------------------------------------------------------
// Positive controls: the scan is shown catching each thing it exists to catch.
// ---------------------------------------------------------------------------
{
  const silent = `
export async function saveThing(form: FormData): Promise<void> {
  await db.from("things").update({ a: 1 });
  revalidatePath("/admin/things");
}
`;
  eq(
    findSilentActions("fixture.ts", silent, new Set(["saveThing"])).length,
    1,
    "a writing form action that reports nothing is caught",
  );
  eq(
    findSilentActions("fixture.ts", silent, new Set()).length,
    0,
    "and the same action is not judged when no form submits to it",
  );

  // Each of the three ways of confirming a save is accepted, so the rule cannot
  // be satisfied only by the redirect it was written around.
  const ways: [string, string][] = [
    ["a named redirect", `  redirect(\`/admin/things\${savedQuery("bucket-created")}\`);`],
    ["another named param", `  redirect("/admin/things?done=1");`],
    ["a returned state", `  return { ok: true };`],
  ];
  for (const [label, line] of ways) {
    const src = `
export async function saveThing(form: FormData): Promise<void> {
  await db.from("things").update({ a: 1 });
${line}
}
`;
    eq(
      findSilentActions("fixture.ts", src, new Set(["saveThing"])).length,
      0,
      `${label} counts as reporting what happened`,
    );
  }

  // The escape hatch works, and only with a reason.
  const exempt = `
// outcome-ok: the toggle it drives visibly flips, which is the confirmation
export async function toggleThing(form: FormData): Promise<void> {
  await db.from("things").update({ a: 1 });
}
`;
  eq(
    findSilentActions("fixture.ts", exempt, new Set(["toggleThing"])).length,
    0,
    "an exemption with a reason is honoured",
  );
  eq(
    findReasonlessExemptions("fixture.ts", "// outcome-ok: ok\nexport async function x() {}").length,
    1,
    "an exemption with no real reason is caught (L233)",
  );

  // A THROW is not a save confirmation, and this is the assertion that keeps it
  // out. Accepting one exempted nearly every action here, because they validate
  // their input; the real-tree control below is what found it.
  const throwsOnly = `
export async function saveThing(form: FormData): Promise<void> {
  if (!form.get("a")) throw new Error("nothing to save");
  await db.from("things").update({ a: 1 });
}
`;
  eq(
    findSilentActions("fixture.ts", throwsOnly, new Set(["saveThing"])).length,
    1,
    "an action that only ever throws still says nothing when it succeeds",
  );

  // An exemption must not be inherited by the NEXT action below it, which is how
  // one considered decision silently covers a second nobody looked at.
  const inherited = `
// outcome-ok: the toggle it drives visibly flips, which is the confirmation
export async function toggleThing(form: FormData): Promise<void> {
  await db.from("things").update({ a: 1 });
}

export async function saveOther(form: FormData): Promise<void> {
  await db.from("things").update({ b: 2 });
}
`;
  const inheritedFindings = findSilentActions(
    "fixture.ts",
    inherited,
    new Set(["toggleThing", "saveOther"]),
  );
  eq(inheritedFindings.length, 1, "the exemption covers only the action it sits above");
  eq(inheritedFindings[0]?.name, "saveOther", "and it is the uncovered one that is named");

  // The form-action collector, on the shape that hid two of these.
  const conditional = `<BucketForm action={editing ? updateBucket : createBucket} />`;
  const names = scanFormActions(conditional);
  assert(
    names.includes("updateBucket") && names.includes("createBucket"),
    "both arms of a conditional action are collected",
  );
}

// A control over the REAL tree: revert the fix in memory and require it caught.
// A synthetic fixture agrees with my assumption about the shape by construction
// (L52); this one asserts the guard would have caught the actual defect.
{
  const real = readFileSync("src/app/admin/actions.ts", "utf8");
  const reverted = real
    .replace(/\n\s*redirect\(`\/admin\/buckets\$\{savedQuery\("bucket-created"\)\}`\);/, "")
    .replace(/\n\s*redirect\(`\/admin\/buckets\$\{savedQuery\("bucket-updated"\)\}`\);/, "");
  assert(reverted !== real, "the overlay actually changed the real source");
  const caught = findSilentActions("src/app/admin/actions.ts", reverted, submitted).map((f) => f.name);
  assert(
    caught.includes("createBucket") && caught.includes("updateBucket"),
    `the guard catches the real defect it was written for (caught: ${caught.join(", ") || "nothing"})`,
  );
}

finish();

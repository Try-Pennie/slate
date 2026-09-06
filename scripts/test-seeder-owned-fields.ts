// #1935: a field the editor offers and the seeder reverts.
//
// `scripts/seed-buckets.ts` used to write every column of every bucket on every
// run. Two of those columns are offered as a per bucket choice in the editor, so
// editing them looked like it worked and the next seed run replaced them:
// `event_type_id` with whatever row an unordered `limit=1` returned, and
// `assignment` with "round_robin". That is the #1874 defect exactly, where three
// routing attributes were hand editable and Salesforce reverted them within the
// hour. An override that is silently undone is worse than none.
//
// Dan's call on 2026-09-06: the event type is a genuine per bucket choice, so the
// seeder sets it only when it CREATES a bucket. What it still refreshes is what
// it exists for, a name or a routing rule changing in `src/lib/xbc.ts` and
// needing to reach all sixty buckets.
//
// THE BOUNDARY IS DERIVED, not written down twice. Both halves come from the
// files that actually decide them: the seeder's own row literals, and the action
// that writes an edit. A list kept beside either would be right on the day it was
// written and wrong the next time the seeder grew a column (L41), which is the
// whole shape of the defect this guards.
//
// Run: node --experimental-strip-types scripts/test-seeder-owned-fields.ts
import { readFileSync } from "node:fs";
import { assert, eq, fail, finish } from "./lib/harness.ts";

const SEEDER = readFileSync("scripts/seed-buckets.ts", "utf8");
const ACTIONS = readFileSync("src/app/admin/actions.ts", "utf8");
const FORM = readFileSync("src/components/admin/BucketForm.tsx", "utf8");

/** The keys of one `.map((spec) => ({ ... }))` row literal in the seeder. */
function rowKeys(after: string): string[] {
  const at = SEEDER.indexOf(after);
  if (at < 0) throw new Error(`seeder has no \`${after}\` row literal any more`);
  const open = SEEDER.indexOf("({", at);
  const close = SEEDER.indexOf("}))", open);
  if (open < 0 || close < 0) throw new Error(`could not read the ${after} row literal`);
  return [...SEEDER.slice(open, close).matchAll(/^\s{4}([a-z_]+):/gm)].map((m) => m[1]);
}

const createdKeys = rowKeys("const created =");
const refreshedKeys = rowKeys("const refreshed =");

// The literals were really read. A regex that matched nothing would make every
// later assertion vacuously true, and the run would look identical to a clean
// tree (L98).
assert(createdKeys.length >= 4, `the created row literal was read (${createdKeys.join(", ")})`);
assert(refreshedKeys.length >= 3, `the refreshed row literal was read (${refreshedKeys.join(", ")})`);

// The identity of a row is not a field anybody edits; it is how the upsert finds
// the row at all.
const IDENTITY = new Set(["org_id", "code"]);
const seederRefreshes = refreshedKeys.filter((k) => !IDENTITY.has(k));
const seededOnce = createdKeys.filter((k) => !refreshedKeys.includes(k));

assert(
  seededOnce.includes("event_type_id"),
  `the event type is set at creation and never refreshed (set once: ${seededOnce.join(", ") || "nothing"})`,
);
assert(
  seededOnce.includes("assignment"),
  "the assignment mode goes with it, by the same argument",
);
assert(
  seederRefreshes.length > 0,
  `the seeder still refreshes something, or it has stopped being a seeder (${seederRefreshes.join(", ")})`,
);

// ---------------------------------------------------------------------------
// The rule: what the seeder REFRESHES, an edit must not write.
// ---------------------------------------------------------------------------
const updateBody = (() => {
  const at = ACTIONS.indexOf("export async function updateBucket(");
  if (at < 0) throw new Error("updateBucket is gone");
  const end = ACTIONS.indexOf("\n}\n", at);
  return ACTIONS.slice(at, end);
})();

/** The `after` object updateBucket writes, key by key, with the expression. */
function writtenFields(body: string): Map<string, string> {
  const at = body.indexOf("const after = {");
  if (at < 0) throw new Error("updateBucket no longer builds an `after` object");
  const close = body.indexOf("\n  };", at);
  const out = new Map<string, string>();
  for (const m of body.slice(at, close).matchAll(/^\s{4}([a-z_]+):\s*(.+?),?\s*$/gm)) {
    out.set(m[1], m[2]);
  }
  return out;
}

const written = writtenFields(updateBody);
assert(written.size >= 4, `updateBucket's written fields were read (${[...written.keys()].join(", ")})`);

for (const key of seederRefreshes) {
  const expr = written.get(key);
  if (expr === undefined) {
    // Not written at all is the strongest form of not overriding it.
    assert(true, `updateBucket does not write ${key}, which the seeder refreshes`);
    continue;
  }
  // Written, so it must come from the STORED ROW rather than from the form. A
  // field read out of the form here is an edit the next seed run replaces, and
  // it reads as a working feature until somebody re-runs the seeder.
  if (/form\.get/.test(expr)) {
    fail(
      `updateBucket writes ${key} from the form (${expr.trim()}), and the seeder refreshes it, so the edit is silently reverted`,
    );
  } else {
    assert(true, `updateBucket takes ${key} from the stored row, not the form`);
  }
}

// And the converse, so this is not one sided: a field the seeder sets ONCE has
// to be editable, or the picker offering it is decoration. `assignment` is not
// on the form at all and is not required to be; the event type is.
{
  const expr = written.get("event_type_id");
  assert(
    expr !== undefined && /form\.get/.test(expr),
    `the event type is a real per bucket choice, taken from the form (${expr ?? "not written"})`,
  );
}

// ---------------------------------------------------------------------------
// The form: a field nobody can change must not look like one.
// ---------------------------------------------------------------------------
{
  // This is the WEAKER half deliberately, and it is second for that reason: the
  // markup is a request and the action above is what writes. It is still worth
  // asserting, because a text box that accepts typing and discards it is its own
  // defect even when nothing is lost.
  for (const key of seederRefreshes) {
    if (key === "criteria") continue; // its own control, asserted below
    const editable = new RegExp(`<input[^>]*\\bname="${key}"`, "s").test(FORM);
    if (!editable) {
      assert(true, `the form draws no plain input for ${key}`);
      continue;
    }
    // It may still appear for CREATION, where the value is genuinely being
    // chosen for the first time. What it must not be is unconditional.
    assert(
      /\{editing \?/.test(FORM),
      `the ${key} field is offered only when creating a bucket, not when editing one`,
    );
  }
  assert(
    /readOnly=\{editing\}/.test(FORM),
    "the criteria picker is read only on an existing bucket",
  );
}

// ---------------------------------------------------------------------------
// A control over the real tree: put the defect back and require it caught.
// ---------------------------------------------------------------------------
{
  // `name`, not `code`: the code is the row's IDENTITY and is excluded above, so
  // restoring a form read on it would not be judged and the control would prove
  // nothing. The first version of this used `code` and said so out loud when it
  // failed, which is the guard doing its job on its own test.
  const reverted = updateBody.replace(
    'name: String(before?.name ?? ""),',
    'name: String(form.get("name") ?? "").trim(),',
  );
  assert(reverted !== updateBody, "the overlay changed the real source");
  const back = writtenFields(reverted).get("name") ?? "";
  assert(
    /form\.get/.test(back),
    "the overlay really restores a form read, so the rule above would have fired",
  );
  eq(
    seederRefreshes.includes("name"),
    true,
    "and `name` is one the seeder refreshes, which is what makes that a defect",
  );
}

finish();

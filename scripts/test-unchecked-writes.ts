// Repo invariant (#2379): a server action may not await a Supabase WRITE and
// throw the result away.
//
// THE BUG CLASS. supabase-js resolves `{ error }` on a refused statement rather
// than throwing, so `await db.from("booking_settings").upsert(...)` with nothing
// bound runs to completion whether Postgres wrote the row or not. Eleven writes
// in src/app/admin/actions.ts were written that way. The headline is the kill
// switch: an admin presses Stop online booking, Postgres refuses the upsert, and
// the action records an audit entry saying `public_booking_paused: true`,
// revalidates, and lands on "Online booking is stopped" while the embed keeps
// taking bookings. `setUserRole` is the revocation twin: the trail says `admin`
// to `agent` and the person keeps admin.
//
// Nothing could see the class. `scripts/test-swallowed-error-reads.ts` skips a
// chain whose mutator is reached before its `.select(` and said in its own header
// that a write is "a different concern", which with nothing on the far side read
// as a class somebody had already handled (L400). The two guards are siblings and
// each is blind where the other looks: that one asks whether an `error` was BOUND
// on a read, this one asks whether the result of a write went anywhere at all.
//
// The scan logic lives in scripts/lib/scan-unchecked-writes.ts (unit testable,
// and where the scope boundary is written down). This file exercises it against
// fixtures, against overlays of the REAL tree with the fix stripped back out (so
// it cannot rot into a no-op: a scanner that reads nothing and a clean tree
// produce the same empty result, L1 and L98), and against the real surface, which
// must be clean.
//
// Run: node --experimental-strip-types scripts/test-unchecked-writes.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scanUncheckedWrites } from "./lib/scan-unchecked-writes.ts";
import { assert, finish } from "./lib/harness.ts";

const HERE = import.meta.dirname; // scripts/
const ROOT = join(HERE, "..");

// --- positive control: flag the bad shape, allow the safe ones ----------------

interface Fixture {
  name: string;
  flagged: boolean;
  src: string;
}

const FIXTURES: Fixture[] = [
  // FLAGGED: the result of the write has nowhere to go ------------------------
  {
    name: "the kill switch shape: an awaited upsert as a bare statement",
    flagged: true,
    src: `await db.from("booking_settings").upsert(\n  { id: 1, public_booking_paused: paused },\n  { onConflict: "id" },\n);\nawait recordAudit({ details: { public_booking_paused: paused } });`,
  },
  {
    name: "an awaited update with an .eq filter",
    flagged: true,
    src: `await db.from("users").update({ role: next }).eq("id", userId);\nrevalidatePath("/admin");`,
  },
  {
    name: "an awaited insert",
    flagged: true,
    src: `await db.from("webhook_endpoints").insert({ org_id: o, url, secret: nanoid(32) });`,
  },
  {
    name: "an awaited delete",
    flagged: true,
    src: `await supabaseAdmin().from("business_hours_exceptions").delete().eq("on_date", d);`,
  },
  {
    name: "the chain built off supabaseAdmin() rather than a db local",
    flagged: true,
    src: `await supabaseAdmin()\n  .from("organizations")\n  .update({ default_timezone: tz })\n  .eq("id", orgId);`,
  },
  {
    name: "a write whose argument carries a callback with a semicolon in its body",
    flagged: true,
    // The depth-aware statement scan is what keeps this whole: a naive stop at
    // the first `;` cuts the chain before `.upsert(` and the mutator is lost.
    src: `await db.from("reason_options").upsert(\n  rows.map((r) => { const at = now; return { ...r, updated_at: at }; }),\n  { onConflict: "action,code" },\n);`,
  },
  {
    name: "a builder defined on an earlier line and awaited bare",
    flagged: true,
    src: `let q = db.from("users").update({ role: next });\nq = q.eq("id", userId);\nawait q;`,
  },
  {
    name: "a write inside a Promise.all whose combined result is discarded",
    flagged: true,
    src: `await Promise.all([\n  db.from("users").update({ a: 1 }).eq("id", x),\n  db.from("users").update({ b: 2 }).eq("id", y),\n]);`,
  },

  // NOT FLAGGED: the result goes somewhere a caller can read it ---------------
  {
    name: "error destructured off the write",
    flagged: false,
    src: `const { error } = await db.from("buckets").update(after).eq("id", id);\nif (error) throw new Error(error.message);`,
  },
  {
    name: "the whole result bound to a name",
    flagged: false,
    src: `const res = await db.from("users").update({ role: next }).eq("id", userId);\nif (res.error) throw res.error;`,
  },
  {
    name: "returned to the caller",
    flagged: false,
    src: `return db.from("business_hours").upsert(rows, { onConflict: "weekday" });`,
  },
  {
    name: "returned to the caller, awaited",
    flagged: false,
    src: `return await db.from("business_hours").upsert(rows, { onConflict: "weekday" });`,
  },
  {
    name: "the write is an argument to something else",
    flagged: false,
    src: `const n = unwrapCount(await db.from("busy_blocks").delete({ count: "exact" }).eq("id", i));\nreturn n;`,
  },

  // NOT FLAGGED: not a write, or not Supabase at all --------------------------
  {
    name: "an awaited READ as a statement (the sibling guard's territory)",
    flagged: false,
    src: `await db.from("users").select("id").eq("org_id", o);`,
  },
  {
    name: "an awaited call that is not a Supabase chain",
    flagged: false,
    src: `await recordAudit({ orgId: o, actorId: a, action: "role.set" });\nawait revalidatePath("/admin");`,
  },
  {
    name: "a non-Supabase client that happens to have an update method",
    flagged: false,
    src: `await cache.update({ key: k, value: v });`,
  },
  {
    name: "a Map or Set delete, which is not a database write",
    flagged: false,
    src: `await queue.delete(id);`,
  },

  // NOT FLAGGED: the documented escape hatch ---------------------------------
  {
    name: "write-ok opt-out on the line above",
    flagged: false,
    src: `// write-ok: a best effort touch; the next tick rewrites this row from scratch\nawait db.from("sync_locks").update({ touched_at: now }).eq("key", k);`,
  },
  {
    name: "write-ok opt-out inside a multi-line comment block",
    flagged: false,
    src: `// nothing after this reads the write as having happened: no audit entry,\n// write-ok: no notice, and the every minute lane rewrites the row anyway\nawait db.from("sync_locks").update({ touched_at: now }).eq("key", k);`,
  },
  {
    name: "a read's error-ok opt-out does NOT exempt a write under it (L448)",
    flagged: true,
    // The pairing that occurs in a real action: a tolerated read and a write
    // sharing one comment block. Reusing the siblings' token would have silently
    // widened every existing use of it.
    src: `// error-ok: an unreadable count leaves the badge blank and the next render refills it\nawait db.from("users").update({ role: next }).eq("id", userId);`,
  },
];

for (const f of FIXTURES) {
  const found = scanUncheckedWrites(f.src, "fixture").length > 0;
  assert(found === f.flagged, `${f.flagged ? "flags" : "allows"}: ${f.name}`);
}

// A finding has to NAME what it found, or the reader goes hunting.
const named = scanUncheckedWrites(
  `await db.from("booking_settings").upsert({ id: 1, public_booking_paused: p }, { onConflict: "id" });`,
  "fixture",
);
assert(named.length === 1, `one statement produces one finding (got ${named.length})`);
assert(named[0]?.mutator === "upsert", `the finding names the mutator (got ${named[0]?.mutator})`);
assert(
  named[0]?.table === "booking_settings",
  `the finding names the table (got ${named[0]?.table})`,
);

// --- the scan surface: every server action file ------------------------------
// Derived by walking src/app for files named actions.ts, never a hand written
// list, so a new action file is covered by construction rather than exempt from
// the guard meant to catch it (L96).

function actionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...actionFiles(full));
    else if (e.name === "actions.ts") out.push(full);
  }
  return out;
}

const surface = actionFiles(join(ROOT, "src", "app"));
assert(surface.length > 0, `found server action files to scan (got ${surface.length})`);

const adminActionsPath = join(ROOT, "src", "app", "admin", "actions.ts");
assert(
  surface.includes(adminActionsPath),
  "src/app/admin/actions.ts, the file #2379 is about, is really in the scanned surface",
);

// --- real-file control: put the kill switch back the way it was ---------------
// The one that matters. A guard over a file that has just been fixed reports
// clean whether it reads the file or not, so the fix is stripped back out IN
// MEMORY (nothing is written to the repo) and the guard must catch it, catch
// exactly one thing, and blame the right table.
const adminSrc = readFileSync(adminActionsPath, "utf8");
assert(
  scanUncheckedWrites(adminSrc, adminActionsPath).length === 0,
  "the real admin/actions.ts is clean",
);

const killSwitchReverted = adminSrc.replace(
  /const \{ error \} = await db\.from\("booking_settings"\)\.upsert\(\n(\s*)\{\n\s*id: 1,\n\s*public_booking_paused: paused,/,
  'await db.from("booking_settings").upsert(\n$1{\n$1  id: 1,\n$1  public_booking_paused: paused,',
);
assert(
  killSwitchReverted !== adminSrc,
  "the kill switch revert control actually changed actions.ts (else it proves nothing)",
);
const killSwitchFindings = scanUncheckedWrites(killSwitchReverted, adminActionsPath);
// An exact count, not "some findings": one reverted write must produce one
// finding, or the control is equally satisfied by a scanner that flags the whole
// file, which would hide every other write going unguarded (L63).
assert(
  killSwitchFindings.length === 1,
  `positive control: the reverted kill switch write is caught (got ${killSwitchFindings.length})`,
);
assert(
  killSwitchFindings[0]?.table === "booking_settings" &&
    killSwitchFindings[0]?.mutator === "upsert",
  `the finding names the kill switch write (got ${killSwitchFindings[0]?.mutator} on ${killSwitchFindings[0]?.table})`,
);

// The same control on the role change, because the two are different remedies to
// different people and a control on one says nothing about the other.
const roleReverted = adminSrc.replace(
  /const \{ error: roleWriteError \} = await db\n(\s*)\.from\("users"\)\n\s*\.update\(\{ role: next \}\)/,
  'await db\n$1.from("users")\n$1.update({ role: next })',
);
assert(
  roleReverted !== adminSrc,
  "the role revert control actually changed actions.ts (else it proves nothing)",
);
const roleFindings = scanUncheckedWrites(roleReverted, adminActionsPath);
assert(
  roleFindings.length === 1 && roleFindings[0]?.table === "users",
  `positive control: the reverted role write is caught (got ${JSON.stringify(
    roleFindings.map((f) => `${f.mutator} on ${f.table}`),
  )})`,
);

// --- real-file control: the scan reaches the files that have no writes today --
// src/app/me/actions.ts and src/app/admin/ooo/actions.ts carry no direct Supabase
// write at all, so they are clean whether the scan reads them or not. A path list
// that reaches nothing and a clean tree look identical (L98), so each gets a
// planted write and must be caught and blamed on itself.
for (const rel of [
  join("src", "app", "me", "actions.ts"),
  join("src", "app", "admin", "ooo", "actions.ts"),
]) {
  const path = join(ROOT, rel);
  assert(surface.includes(path), `${rel} is in the scanned surface`);
  const src = readFileSync(path, "utf8");
  assert(scanUncheckedWrites(src, rel).length === 0, `the real ${rel} is clean`);
  const planted =
    src +
    `\nasync function _regression() {\n  await supabaseAdmin().from("users").update({ role: "admin" }).eq("id", id);\n}\n`;
  const plantedFindings = scanUncheckedWrites(planted, rel);
  assert(
    plantedFindings.length === 1 && plantedFindings[0]?.file === rel,
    `positive control: a planted unchecked write in ${rel} is caught and blamed on it`,
  );
}

// --- the opt-out is real, on a real file -------------------------------------
// Annotating the reverted kill switch must silence it. A hatch nobody has driven
// is a hatch that may not work, and finding that out during an incident is the
// worst moment for it.
const revertedWithOptOut = killSwitchReverted.replace(
  '  await db.from("booking_settings").upsert(',
  '  // write-ok: driven by the guard\'s own test, never committed in this state\n  await db.from("booking_settings").upsert(',
);
assert(
  revertedWithOptOut !== killSwitchReverted,
  "the opt-out control actually annotated the reverted write (else it proves nothing)",
);
assert(
  scanUncheckedWrites(revertedWithOptOut, adminActionsPath).length === 0,
  "the // write-ok: opt-out silences a write that is otherwise flagged",
);

// --- repo invariant: the whole scan surface is clean --------------------------

let siteCount = 0;
for (const file of surface) {
  const rel = file.slice(ROOT.length + 1);
  const findings = scanUncheckedWrites(readFileSync(file, "utf8"), rel);
  siteCount += findings.length;
  for (const fnd of findings) {
    assert(
      false,
      `${fnd.file}:${fnd.line} awaited \`.${fnd.mutator}(\` on ` +
        `${fnd.table ?? "a table"} with the result discarded, so nothing can consult its ` +
        `\`error\` and a refused write reaches the audit entry and the saved notice as a ` +
        `success. Bind \`{ error }\` and refuse before the audit, the revalidate and the ` +
        `redirect, or annotate // write-ok: <reason> if nothing after it tells anybody it ` +
        `succeeded. [${fnd.snippet}]`,
    );
  }
}
if (siteCount === 0) {
  console.log(`ok: no unchecked Supabase writes across ${surface.length} server action files`);
}

finish();

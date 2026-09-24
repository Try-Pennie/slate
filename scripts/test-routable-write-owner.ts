// Repo invariant (#2085): exactly ONE module writes `users.bookable` and
// `users.deactivated_at`, and it is the module that tells Regal whether Slate can
// route to the agent.
//
// The trait is sent from INSIDE `src/lib/bookable/routable-write.ts`, because a
// behaviour every writer has to remember to opt into is enforced by nothing, and a
// site that never opts in looks exactly like a site where the condition never
// arises (L621). So the next writer of either column has to fail the build rather
// than quietly leave Regal holding a stale trait.
//
// The scan lives in scripts/lib/scan-routable-writes.ts. This file is the positive
// control, a real-file mutation control, and the whole-tree invariant.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-routable-write-owner.ts
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { scanRoutableWrites } from "./lib/scan-routable-writes.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const OWNER = "src/lib/bookable/routable-write.ts";

// --- positive control: the shapes it must catch, and the ones it must not -------

interface Fixture {
  name: string;
  flagged: boolean;
  src: string;
}

const FIXTURES: Fixture[] = [
  {
    name: "the #2085 defect itself: a second bookable flip",
    flagged: true,
    src: `await db.from("users").update({ bookable: true }).eq("id", id);`,
  },
  {
    name: "a flip that also settles the pending mark",
    flagged: true,
    src: `await db.from("users").update({ bookable: false, bookable_pending_since: null }).eq("id", id);`,
  },
  {
    name: "a departure",
    flagged: true,
    src: `await db.from("users").update({ deactivated_at: stamp }).in("id", ids);`,
  },
  {
    name: "a multi-line patch object",
    flagged: true,
    src: [`await db.from("users").update({`, `  role: "agent",`, `  bookable: false,`, `}).eq("id", id);`].join("\n"),
  },
  {
    name: "shorthand property",
    flagged: true,
    src: `await db.from("users").update({ bookable }).eq("id", id);`,
  },
  {
    name: "one hop through a local const",
    flagged: true,
    src: [`const patch = { bookable: true };`, `await db.from("users").update(patch).eq("id", id);`].join("\n"),
  },
  {
    name: "the shared departure patch applied from a second site",
    flagged: true,
    src: `await db.from("users").update(deactivationPatch(stamp)).eq("id", id);`,
  },
  {
    name: "the shared return patch one hop away",
    flagged: true,
    src: [`const p = reactivationPatch();`, `await db.from("users").update(p).eq("id", id);`].join("\n"),
  },
  {
    name: "an upsert carrying bookable",
    flagged: true,
    src: `await db.from("users").upsert({ id, bookable: true }, { onConflict: "id" });`,
  },
  {
    name: "an insert that makes somebody bookable on arrival",
    flagged: true,
    src: `await db.from("users").insert({ email, role: "agent", bookable: true });`,
  },
  {
    name: "an insert whose bookable is computed",
    flagged: true,
    src: `await db.from("users").insert({ email, bookable: isAgent });`,
  },
  {
    name: "an insert that starts somebody NOT bookable owes no trait",
    flagged: false,
    src: `await db.from("users").insert({ email, role: "agent", bookable: false });`,
  },
  {
    name: "the pending mark on its own is not the flag",
    flagged: false,
    src: `await db.from("users").update({ bookable_pending_since: now }).eq("id", id);`,
  },
  {
    name: "a write of some other column",
    flagged: false,
    src: `await db.from("users").update({ role: "manager" }).in("id", ids);`,
  },
  {
    name: "a READ that merely selects the columns",
    flagged: false,
    src: `const r = await db.from("users").select("id, bookable, deactivated_at").eq("id", id);`,
  },
  {
    name: "the escape hatch, carrying a reason",
    flagged: false,
    src: [
      `// routable-write-ok: a one-off correction on a test fixture no trait is owed for`,
      `await db.from("users").update({ bookable: false }).eq("id", id);`,
    ].join("\n"),
  },
  {
    name: "the escape hatch with no reason is refused",
    flagged: true,
    src: [`// routable-write-ok:`, `await db.from("users").update({ bookable: false }).eq("id", id);`].join("\n"),
  },
  {
    name: "another guard's hatch does not exempt this one (L448)",
    flagged: true,
    src: [
      `// lifecycle-write-ok: a one-off correction`,
      `await db.from("users").update({ deactivated_at: null }).eq("id", id);`,
    ].join("\n"),
  },
];

for (const f of FIXTURES) {
  const hits = scanRoutableWrites("fixture.ts", f.src);
  eq(hits.length > 0, f.flagged, `fixture: ${f.name}`);
}

// --- the whole-tree invariant ---------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "worker"))];
assert(files.length > 100, `scanned the real src and worker trees (${files.length} files)`);

const violations = files.flatMap((full) => {
  const rel = relative(ROOT, full);
  if (rel === OWNER) return [];
  return scanRoutableWrites(rel, readFileSync(full, "utf8"));
});
for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.text}`);
eq(violations.length, 0, "no write of users.bookable or users.deactivated_at outside the owning module");

// --- mutation control over the REAL tree ---------------------------------------
//
// A scanner that reads a clean tree and a scanner that reads nothing produce the
// same empty list (L98). So a second writer is planted in the real admin actions
// file, in memory, and the guard must catch it and blame the right file.

const PLANT = "src/app/admin/actions.ts";
const plantSource = readFileSync(join(ROOT, PLANT), "utf8");
const planted =
  plantSource +
  `\nexport async function plantedFlip(id: string) {\n  await supabaseAdmin().from("users").update({ bookable: true }).eq("id", id);\n}\n`;
eq(scanRoutableWrites(PLANT, plantSource).length, 0, "the admin actions file is clean as shipped");
const caught = scanRoutableWrites(PLANT, planted);
eq(caught.length, 1, "a planted second bookable writer in the real admin actions is caught");
eq(caught[0]?.file, PLANT, "and is blamed on that file");

// The owner is exempt, so it must really be the owner: every write kind lives
// there, or the exemption would be exempting a file that decides nothing.
assert(existsSync(join(ROOT, OWNER)), "the owning module exists");
const ownerSource = readFileSync(join(ROOT, OWNER), "utf8");
assert(
  scanRoutableWrites("owner-as-if-elsewhere.ts", ownerSource).length >= 3,
  "the owning module holds the flip, the departure and the return (read as if it were anywhere else)",
);
assert(/planTraitEmissions\(/.test(ownerSource), "and it decides the Regal trait inside the write");

finish();

// Every staff photo goes through one resolver, and image bytes ride only on the
// reads that serve them (#3027). The scans live in
// scripts/lib/scan-advisor-photo-reads.ts; each is seen to fail on a planted
// instance below before its clean result over the real tree is believed (L1, L98).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-advisor-photo-reads.ts
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RESOLVE_PATH,
  scanNeverReadJudges,
  scanPhotoTableReads,
  scanRawAvatarReads,
  scanRefreshCoverageDefinitions,
  STORE_PATH,
  type SourceFile,
} from "./lib/scan-advisor-photo-reads.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): SourceFile[] {
  const out: SourceFile[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push({ path: relative(ROOT, p).split("\\").join("/"), text: readFileSync(p, "utf8") });
    }
  }
  return out;
}

const tree = sources(join(ROOT, "src"));
assert(tree.length > 200, `the scan reads the source tree (${tree.length} files)`);
assert(tree.some((f) => f.path === STORE_PATH), "including the photo store");

// --- raw avatar reads -------------------------------------------------------------
eq(scanRawAvatarReads(tree), [], "no surface outside the resolver reads users.avatar_url");
{
  // The shape #3027 removed: a page drawing the sign in photo itself.
  const planted: SourceFile = { path: "src/app/admin/layout.tsx", text: "<AppHeader avatarUrl={me.avatar_url} />" };
  eq(scanRawAvatarReads([planted]), ["src/app/admin/layout.tsx:1"], "a planted raw read is caught");
  const select: SourceFile = { path: "src/app/x.ts", text: 'db.from("users").select("id, avatar_url")' };
  eq(scanRawAvatarReads([select]).length, 1, "a select naming the column is caught");
  const comment: SourceFile = { path: "src/app/x.ts", text: "// never reads avatar_url itself\n/* avatar_url */" };
  eq(scanRawAvatarReads([comment]), [], "a comment naming it is not a read");
  eq(scanRawAvatarReads([{ path: "src/lib/provision.ts", text: "x.avatar_url" }]), [], "provisioning may write it");
}

// --- image bytes ------------------------------------------------------------------
eq(scanPhotoTableReads(tree), [], "advisor_photos is read only in the store, and bytes only by the serving readers");
{
  const outside: SourceFile = { path: "src/app/admin/agents/page.tsx", text: 'db.from("advisor_photos").select("user_id, state");' };
  eq(scanPhotoTableReads([outside]).length, 1, "a read outside the store is caught");
  const embed: SourceFile = { path: "src/app/admin/agents/page.tsx", text: 'db.from("users").select("*, advisor_photos(*)");' };
  eq(scanPhotoTableReads([embed]).length, 1, "an embed of the table is caught");
  const store = readFileSync(join(ROOT, STORE_PATH), "utf8");
  const star = store.replace('.select("user_id, state, sha256, failing_since")', '.select("*")');
  assert(star !== store, "the planted star replaces a real select in the real store");
  assert(scanPhotoTableReads([{ path: STORE_PATH, text: star }]).some((f) => f.includes("selects *")), "a select star in the store is caught");
  const bytes = store.replace('.select("user_id, state, sha256, failing_since")', '.select("user_id, state, sha256, failing_since, bytes_b64")');
  assert(scanPhotoTableReads([{ path: STORE_PATH, text: bytes }]).some((f) => f.includes("listStoredPhotoStates")), "bytes selected by a reader that does not serve them are caught, naming it");
}

// --- who is not read yet (#3161) --------------------------------------------------
assert(tree.some((f) => f.path === RESOLVE_PATH), "the scan reads the resolver");
eq(scanNeverReadJudges(tree), [], "never-read is judged only inside the resolver");
{
  // The shape #3161 removed, put back into the real roster filter.
  const path = "src/lib/admin/roster-filter.ts";
  const real = readFileSync(join(ROOT, path), "utf8");
  const planted = real.replace("awaitingFirstRead(r.photo, r)", 'r.photo.kind === "never-read"');
  assert(planted !== real, "the planted count replaces the real one in the real roster filter");
  eq(scanNeverReadJudges([{ path, text: planted }]).length, 1, "a banner counting never-read itself is caught");
  const viaCase: SourceFile = { path: "src/lib/advisor-photos/copy.ts", text: 'switch (k) {\n  case "never-read":\n    return "x";\n}' };
  eq(scanNeverReadJudges([viaCase]), ["src/lib/advisor-photos/copy.ts:2 judges never-read itself; use awaitingFirstRead"], "a switch case is a judge too");
  const comment: SourceFile = { path: "src/app/x.ts", text: '// kind === "never-read" used to be counted here' };
  eq(scanNeverReadJudges([comment]), [], "a comment naming it is not a judge");
}

eq(scanRefreshCoverageDefinitions(tree), [], "the photo module defines who the refresh covers in one place");
{
  const path = "src/lib/advisor-photos/refresh.ts";
  const real = readFileSync(join(ROOT, path), "utf8");
  const planted = real.replace("users.filter(photoRefreshCovers)", "users.filter((u) => u.deactivated_at === null)");
  assert(planted !== real, "the planted filter replaces the real one in the real refresh");
  eq(scanRefreshCoverageDefinitions([{ path, text: planted }]).length, 1, "a second definition in the refresh is caught");
  const reversed: SourceFile = { path: "src/lib/advisor-photos/core.ts", text: "if (null !== u.deactivated_at) continue;" };
  eq(scanRefreshCoverageDefinitions([reversed]).length, 1, "written the other way round, too");
  const active: SourceFile = { path: "src/lib/advisor-photos/core.ts", text: "users.filter((u) => isActive(u))" };
  eq(scanRefreshCoverageDefinitions([active]).length, 1, "and borrowing the roster's isActive");
  const query: SourceFile = { path: "src/lib/advisor-photos/store.ts", text: '.is("users.deactivated_at", null)' };
  eq(scanRefreshCoverageDefinitions([query]), [], "a PostgREST filter is a query, not a predicate");
  const outside: SourceFile = { path: "src/lib/active-user.ts", text: "return user.deactivated_at == null;" };
  eq(scanRefreshCoverageDefinitions([outside]), [], "outside the photo module is a different question");
}

finish();

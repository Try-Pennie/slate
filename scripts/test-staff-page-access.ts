// Repo invariant (#3692, lesson L1026): every staff page checks access ITSELF.
//
// The two staff layouts (`src/app/admin/layout.tsx`, `src/app/me/layout.tsx`) make no
// access decision, deliberately, and say so: a signed out request renders the page
// with no chrome, and the PAGE redirects to /login. That is the arrangement Next's own
// guide asks for (`node_modules/next/dist/docs/01-app/02-guides/authentication.md`,
// "Layouts and auth checks"): a layout renders at the same time as its page, is not
// re-run on a client navigation, and does not control whether the page renders, so a
// check there protects nothing beneath it.
//
// What nothing enforced was the other half. Every page under `/admin` and `/me` does
// check today, by hand, and the middleware refreshes a session but never refuses a
// signed out request. Every page reads through the secret key client, which bypasses
// RLS. So the next page added without its two lines would serve its data to anybody
// with the URL, and every check in the repo would pass. This is the test that fails
// when one does not.
//
// Asserted, in the order that matters:
//   1. the scan FOUND the pages (a scan that enumerated nothing reports the same
//      empty result as a fully guarded tree, L98);
//   2. the real tree is clean;
//   3. positive controls: a fixture for each way a page can go wrong, and a REAL page
//      with its gate removed, which must be caught and blamed on that file.
//
// BOUNDARY, stated so this is not read as wider coverage than it has: it proves a
// SIGNED OUT request is refused before the page reads anything. Which ROLE a page
// admits is each page's own decision (an agent sees /me, a manager the OOO queue)
// and is not judged here. Server actions and API routes are separate surfaces with
// their own guards (`scripts/test-same-origin-coverage.ts`).
//
// Run: node --experimental-strip-types scripts/test-staff-page-access.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { STAFF_PAGE_ROOTS, scanStaffPageAccess, type PageSource } from "./lib/scan-staff-page-access.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");

function pagesUnder(dir: string): PageSource[] {
  const out: PageSource[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...pagesUnder(full));
    else if (name === "page.tsx" || name === "page.ts") {
      out.push({ path: relative(ROOT, full), text: readFileSync(full, "utf8") });
    }
  }
  return out;
}

const pages = STAFF_PAGE_ROOTS.flatMap((root) => pagesUnder(join(ROOT, root)));

// --- 1. the scan found the pages ------------------------------------------------

// 30 pages on 2026-10-23. A floor rather than an exact count, so adding a page is not
// a test edit; a floor far below it, so a broken walk cannot pass.
assert(pages.length >= 25, `found ${pages.length} staff pages, expected at least 25 (is the walk broken?)`);
assert(
  pages.some((p) => p.path === "src/app/admin/audit/page.tsx"),
  "the walk reaches a known console page",
);
assert(
  pages.some((p) => p.path === "src/app/me/time-off/page.tsx"),
  "the walk reaches a known /me page",
);

// --- 2. the real tree is clean --------------------------------------------------

const findings = scanStaffPageAccess(pages);
eq(
  findings.map((f) => `${f.path}: ${f.problem}`),
  [],
  "every staff page refuses a signed out request before it reads anything",
);

// --- 3. positive controls -------------------------------------------------------

const page = (body: string, head = ""): PageSource => ({
  path: "src/app/admin/fixture/page.tsx",
  text: `${head}\nexport default async function FixturePage({ params, searchParams }: Props) {\n${body}\n}\n`,
});
const verdict = (p: PageSource) => scanStaffPageAccess([p])[0]?.problem ?? null;

eq(
  verdict(page(`  const me = await currentUser();\n  if (!me) redirect("/login");\n  const rows = await load();\n  return <List rows={rows} />;`)),
  null,
  "currentUser then a redirect on null passes",
);
eq(
  verdict(page(`  const sp = await searchParams;\n  const me = await currentUser();\n  if (!me) redirect("/login");\n  return <List />;`)),
  null,
  "awaiting searchParams before the gate passes: it reads nothing",
);
eq(
  verdict(page(`  const { id } = await params;\n  const me = await currentUser();\n  if (!me) notFound();\n  return <Row id={id} />;`)),
  null,
  "awaiting params, then notFound on null, passes",
);
eq(verdict(page(`  const me = await requireAdmin();\n  return <List />;`)), null, "a require guard passes");
eq(verdict(page(`  redirect("/admin");`)), null, "a page that only redirects passes: it renders nothing");
eq(
  verdict(page(`  if (!devPreviewEnabled()) notFound();\n  throw new Error("probe");`)),
  null,
  "a page that only throws passes: it renders nothing",
);

assert(
  verdict(page(`  const rows = await load();\n  return <List rows={rows} />;`)) !== null,
  "a page with no access check is caught",
);
assert(
  verdict(page(`  const rows = await load();\n  const me = await currentUser();\n  if (!me) redirect("/login");\n  return <List rows={rows} />;`)) !== null,
  "a page that reads BEFORE its check is caught",
);
assert(
  verdict(page(`  const [me, rows] = await Promise.all([currentUser(), load()]);\n  if (!me) redirect("/login");\n  return <List rows={rows} />;`)) !== null,
  "a page reading in parallel with its check is caught",
);
assert(
  verdict(page(`  const me = await currentUser();\n  const rows = await load();\n  return <List me={me} rows={rows} />;`)) !== null,
  "a page that fetches the user but never refuses null is caught",
);
assert(
  verdict(page(`  return <List />;`)) !== null,
  "a page that renders with no check at all is caught",
);
assert(
  verdict({ path: "src/app/admin/fixture/page.tsx", text: `const Page = () => <List />;\nexport default Page;\n` }) !== null,
  "a page whose default export the scan cannot read is caught, never passed",
);

// A REAL page with its gate removed must be caught and blamed on that file.
const real = pages.find((p) => p.path === "src/app/admin/audit/page.tsx")!;
const gate = `if (!me) redirect("/login");`;
assert(real.text.includes(gate), "the overlay's real page still carries the line it removes");
const stripped = { ...real, text: real.text.replace(gate, "") };
const caught = scanStaffPageAccess([stripped]);
eq(caught.map((f) => f.path), [real.path], "the real audit page with its gate removed is caught, by name");

finish();

// Guard: the synthetic smoke-test agent + its buckets (#396) stay hidden from
// every internal surface and the public booking page. These are read-side
// visibility invariants on server-component pages (no established RSC+DB render
// harness here), so they're pinned by a source scan — the same posture as the
// copy/dash lint. The actual booking/availability BLOCKS are behaviour-tested
// in test-booking-orchestration.ts and api/availability/route.test.ts.
// Run: node --experimental-strip-types scripts/test-test-agent-hiding.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

// Internal UI: every page that lists agents must filter is_test out of its
// users query, so the test agent never shows in the roster, the bucket
// member/fallback pickers it feeds, the OOO roster/insights, or the manager
// picker.
for (const page of [
  "src/app/admin/page.tsx",
  "src/app/admin/ooo/page.tsx",
  "src/app/admin/agents/[id]/page.tsx",
]) {
  const src = read(page);
  assert(
    /\.eq\(\s*["']is_test["']\s*,\s*false\s*\)/.test(src),
    `${page} filters is_test agents out of its users query`,
  );
}

// Public /book page: a test bucket code must NOT render a Booker — it resolves
// is_test and short-circuits to an unavailable message.
const book = read("src/app/book/page.tsx");
assert(/is_test/.test(book), "book page resolves the bucket's is_test flag");
assert(
  /bucketRow\?\.is_test/.test(book),
  "book page short-circuits when the bucket is a test bucket",
);

finish();

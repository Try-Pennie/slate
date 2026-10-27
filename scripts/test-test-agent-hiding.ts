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

// Internal UI: every page that lists agents must keep the test agent out of its
// users query, so it never shows in the roster, the bucket member/fallback
// pickers it feeds, the OOO roster/insights, or the manager picker. Since #4201
// that is the shared real advisor rule, which keeps the placeholder out too;
// scripts/test-real-advisor-reads.ts holds every other list read to it.
for (const page of [
  "src/app/admin/page.tsx",
  "src/app/admin/ooo/page.tsx",
  "src/app/admin/agents/[id]/page.tsx",
]) {
  const src = read(page);
  assert(
    /realAdvisorsOnly\(\s*db\s*\.from\(\s*["']users["']\s*\)/.test(src),
    `${page} applies the shared real advisor rule to its users query`,
  );
}

// The two public landing pages (#2660): each resolves whether the bucket is a
// test bucket through the ONE shared helper and hands the answer to the Booker,
// so the test line is drawn on every screen it reaches. The old short circuit
// ("This booking link is not available") is gone with its branch: after the
// resolver learned the public test code no reachable code produces a hidden
// test bucket on these pages, and a hidden one is refused at the confirm.
for (const page of ["src/app/book/page.tsx", "src/app/booking/[id]/page.tsx"]) {
  const src = read(page);
  assert(
    /loadLandingBucketIsTest\(/.test(src),
    `${page} resolves the bucket's test flag through the shared landing helper`,
  );
  assert(/isTest=\{isTest\}/.test(src), `${page} hands the Booker the test flag`);
  // The MARKUP of the old refusal, not the phrase: a comment recording what was
  // deleted is not the branch coming back.
  assert(
    !/not available\.\s*<\/p>/.test(src),
    `${page} no longer short-circuits a test bucket to an unavailable message`,
  );
}

// Admin booking surfaces that READ bookings (#2660). A stranger's booking on the
// public test bucket is a real row, so the pages that aggregate bookings keep it
// out through the bucket join (bookings has no flag of its own), while the
// lookup and the detail page show it MARKED (pinned by their own vitest suites).
for (const page of ["src/app/admin/routing/page.tsx", "src/app/admin/ooo/page.tsx"]) {
  const src = read(page);
  assert(
    /buckets!inner\(is_test\b[^)]*\)/.test(src),
    `${page} joins the bucket on its bookings read`,
  );
  assert(
    /\.eq\(\s*["']buckets\.is_test["']\s*,\s*false\s*\)/.test(src),
    `${page} keeps test bookings out of its bookings read`,
  );
}

finish();

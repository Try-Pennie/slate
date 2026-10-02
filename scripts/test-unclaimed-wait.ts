// "Never signed in" on the whole roster (#1802), and the one wait helper the
// pending access panel phrases its wait through. The roster shows only Never or
// Yes since 2026-10-02 (Dan), so it phrases no wait at all.
//
// The pending access panel (#160) already asked "has this row ever been claimed
// by a Google sign in?" of privileged rows, keyed on `auth_user_id` being null,
// with a wait in days. #1802 asks the same question of everybody. Two surfaces
// answering one question with two copies of the arithmetic or the wording is the
// shape where they quietly stop agreeing (L370), so both go through
// `src/lib/admin/unclaimed.ts`, and this suite pins that the pending panel's
// figure IS that helper's figure rather than a lookalike.
//
// The avatar is deliberately not an input anywhere. Since #2600 photos come from
// the Workspace directory, so a face says nothing about whether somebody logged
// in, and a signed in person with no photo was always the heuristic's wrong case.
//
// Run: node --experimental-strip-types scripts/test-unclaimed-wait.ts
import { readFileSync } from "node:fs";
import {
  isNeverSignedIn,
  unclaimedDays,
  unclaimedWaitText,
} from "../src/lib/admin/unclaimed.ts";
import { pendingPrivilegedAccess } from "../src/lib/admin/pending-access.ts";
import type { User } from "../src/lib/db/types.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

// --- the predicate: the linked sign in, never the photo ---------------------
assert(isNeverSignedIn({ auth_user_id: null }), "no linked sign in is never signed in");
assert(!isNeverSignedIn({ auth_user_id: "auth-1" }), "a linked sign in has signed in");

// --- the wait figure --------------------------------------------------------
eq(unclaimedDays(ago(0), NOW), 0, "a row created today has waited 0 days");
eq(unclaimedDays(ago(1), NOW), 1, "a day");
eq(unclaimedDays(ago(12.9), NOW), 12, "whole days, rounded down");
eq(unclaimedDays(new Date(NOW + DAY).toISOString(), NOW), 0, "a created_at ahead of the clock never reads as a negative wait");
for (const bad of ["", "nonsense"]) {
  // An unreadable stamp understates rather than inventing an alarm, which is the
  // behaviour the pending panel shipped with and keeps.
  eq(unclaimedDays(bad, NOW), 0, `an unreadable created_at (${JSON.stringify(bad)}) is 0 days, never NaN`);
}

// --- the wording ------------------------------------------------------------
eq(unclaimedWaitText(0), "added today", "0 days");
eq(unclaimedWaitText(1), "waiting 1 day", "singular");
eq(unclaimedWaitText(12), "waiting 12 days", "plural");
eq(unclaimedWaitText(-3), "added today", "a negative figure is never printed");

// --- the pending panel uses the SAME figure ---------------------------------
function user(over: Partial<User> & { email: string }): User {
  return {
    id: over.email,
    org_id: "org",
    auth_user_id: null,
    name: null,
    role: "agent",
    google_sub: null,
    avatar_url: null,
    attributes: {},
    bookable: false,
    deactivated_at: null,
    last_synced_at: null,
    manager_id: null,
    ooo_calendar_id: null,
    theme_preference: "system",
    is_test: false,
    created_at: ago(2),
    ...over,
  } as User;
}
for (const days of [0, 1, 6, 7, 40]) {
  const u = user({ email: `m${days}@trypennie.com`, role: "manager", created_at: ago(days + 0.4) });
  const [row] = pendingPrivilegedAccess([u], NOW) ?? [];
  eq(row?.waitedDays, unclaimedDays(u.created_at, NOW), `the pending panel's wait is the shared helper's, at ${days} days`);
}
const unreadable = pendingPrivilegedAccess([user({ email: "x@trypennie.com", role: "admin", created_at: "nonsense" })], NOW) ?? [];
eq(unreadable[0]?.waitedDays, 0, "and it inherits the helper's unreadable stamp handling");

// --- one phrasing, in source ------------------------------------------------
// The phrase is built in exactly one module. A second copy of "waiting N days"
// anywhere a person reads it is the drift this suite exists to prevent, and the
// superseded name must be gone rather than left arguing for itself (L613).
const pendingSrc = readFileSync(new URL("../src/lib/admin/pending-access.ts", import.meta.url), "utf8");
assert(!/export function pendingWaitText/.test(pendingSrc), "pendingWaitText is deleted, not kept beside its replacement");
assert(!/86_400_000/.test(pendingSrc), "pending-access holds no day arithmetic of its own");
for (const file of ["../src/components/TeamAccessPanel.tsx", "../src/components/admin/RosterTable.tsx", "../src/lib/admin/roster-filter.ts"]) {
  const src = readFileSync(new URL(file, import.meta.url), "utf8");
  assert(!/`waiting \$\{/.test(src) && !/"waiting \d/.test(src), `${file} builds no wait wording of its own`);
}
const panel = readFileSync(new URL("../src/components/TeamAccessPanel.tsx", import.meta.url), "utf8");
assert(/unclaimedWaitText\(/.test(panel), "the pending access panel phrases its wait through unclaimedWaitText");
const rosterFilter = readFileSync(new URL("../src/lib/admin/roster-filter.ts", import.meta.url), "utf8");
// Dan, 2026-10-02: the roster says Never with no day count, so it phrases no
// wait at all; the pending access panel above is the one place a wait is shown.
assert(!/unclaimedWaitText\(/.test(rosterFilter) && !/unclaimedDays\(/.test(rosterFilter), "the roster shows no wait, only Never or Yes");
assert(!/avatar_url/.test(rosterFilter.split("export function rosterSigninText")[1]?.split("\nexport ")[0] ?? "avatar_url"), "the roster's sign in wording never reads the avatar");

finish();

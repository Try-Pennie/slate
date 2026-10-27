// Staff access by email (#160): the pure decision behind the super admin's
// "Team access" surface, plus the detection that makes a seeded row keyed to the
// wrong address VISIBLE instead of silent.
//
// Two halves, and each is blind where the other looks:
//
//   planStaffAccess        who may grant what, to whom, and every way it refuses.
//   pendingPrivilegedAccess  which granted accounts have never been claimed by a
//                            login, how long they have waited, and whether a
//                            similar address DID sign in (the typo signature).
//
// Run: node --experimental-strip-types scripts/test-staff-access.ts
import {
  GRANTABLE_STAFF_ROLES,
  normalizeStaffEmail,
  isGrantableStaffRole,
  staffEmailError,
  requiresAdminCount,
  planStaffAccess,
  staffAccessMessage,
  STAFF_ACCESS_OUTCOMES,
  type StaffAccessTarget,
} from "../src/lib/admin/staff-access.ts";
import {
  PENDING_STALE_DAYS,
  pendingPrivilegedAccess,
  emailLocalKey,
} from "../src/lib/admin/pending-access.ts";
import type { Role, User } from "../src/lib/db/types.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// ---------------------------------------------------------------------------
// Email handling
// ---------------------------------------------------------------------------

eq(
  normalizeStaffEmail("  Geoff.Smith@TryPennie.com "),
  "geoff.smith@trypennie.com",
  "normalizeStaffEmail trims and lowercases",
);

assert(staffEmailError("geoff@trypennie.com") === null, "a well formed address is accepted");
for (const bad of ["", "   ", "geoff", "geoff@", "@trypennie.com", "geoff@trypennie", "a b@c.com"]) {
  assert(
    staffEmailError(bad) !== null,
    `an unusable address is refused: ${JSON.stringify(bad)}`,
  );
}
// The refusal is a sentence somebody reads, not a code.
assert(
  (staffEmailError("geoff") ?? "").length > 10,
  "the email refusal explains itself rather than naming a code",
);

// ---------------------------------------------------------------------------
// Which roles this surface may grant
// ---------------------------------------------------------------------------

assert(
  isGrantableStaffRole("manager") &&
    isGrantableStaffRole("team_lead") &&
    isGrantableStaffRole("admin"),
  "manager, team lead and admin can be granted by email",
);
assert(
  !isGrantableStaffRole("agent"),
  "agent is not a grant: this surface exists for elevated access",
);
assert(
  !isGrantableStaffRole("super_admin"),
  "super admin is never minted from a typed address; it stays on the per user role editor",
);
eq(
  GRANTABLE_STAFF_ROLES.length,
  4,
  "the grantable set is the three elevated tiers below super admin, and the coordinator",
);
// #4205: scheduling coordinators are not debt team agents either, so nothing creates
// them; this is where a super admin grants one before their first sign in.
assert(isGrantableStaffRole("coordinator"), "a coordinator can be granted by email");

// ---------------------------------------------------------------------------
// requiresAdminCount: the count is read only where it decides something
// ---------------------------------------------------------------------------

assert(
  requiresAdminCount("admin", "manager") && requiresAdminCount("super_admin", "team_lead"),
  "a change that strips org power needs the admin count",
);
assert(
  !requiresAdminCount("manager", "admin") &&
    !requiresAdminCount("admin", "admin") &&
    !requiresAdminCount("agent", "manager"),
  "a change that keeps or adds org power does not need the count",
);

// ---------------------------------------------------------------------------
// planStaffAccess
// ---------------------------------------------------------------------------

const ORG = "org-1";
const SUPER = {
  actorRole: "super_admin" as Role,
  actorId: "me",
  actorOrgId: ORG,
  allowedDomain: "trypennie.com",
};

function target(over: Partial<StaffAccessTarget> = {}): StaffAccessTarget {
  return {
    id: "u2",
    org_id: ORG,
    role: "agent",
    deactivated_at: null,
    auth_user_id: null,
    bookable: false,
    ...over,
  };
}

// #4205: granting a coordinator. A new address is a grant; an unclaimed row moves; a
// row in the booking pool is refused by name, because a coordinator is never bookable
// (users_coordinator_never_bookable) and the write would fail as "could not be saved".
{
  const fresh = planStaffAccess({ ...SUPER, email: "coord@trypennie.com", requestedRole: "coordinator", existing: null, adminCount: null });
  assert(fresh.ok && fresh.outcome === "granted" && fresh.role === "coordinator", "a new address is granted the coordinator role");
  const unclaimed = planStaffAccess({ ...SUPER, email: "coord@trypennie.com", requestedRole: "coordinator", existing: target(), adminCount: null });
  assert(unclaimed.ok && unclaimed.outcome === "updated", "an unclaimed, unbookable row becomes a coordinator");
  const inPool = planStaffAccess({ ...SUPER, email: "coord@trypennie.com", requestedRole: "coordinator", existing: target({ bookable: true }), adminCount: null });
  assert(!inPool.ok && inPool.outcome === "in_pool", "a row in the booking pool is refused, by name");
  const inPoolManager = planStaffAccess({ ...SUPER, email: "coord@trypennie.com", requestedRole: "manager", existing: target({ bookable: true }), adminCount: null });
  assert(inPoolManager.ok, "and only a coordinator grant is refused for it: a bookable agent may still be made a manager");
  const claimed = planStaffAccess({ ...SUPER, email: "coord@trypennie.com", requestedRole: "coordinator", existing: target({ auth_user_id: "auth-9" }), adminCount: null });
  assert(!claimed.ok && claimed.outcome === "signed_in_demotion", "a signed in agent is changed on their own page, as any lowering is");
  const asAdmin = planStaffAccess({ ...SUPER, actorRole: "admin", email: "coord@trypennie.com", requestedRole: "coordinator", existing: null, adminCount: null });
  assert(!asAdmin.ok && asAdmin.outcome === "not_authorized", "only a super admin grants it here");
}

const created = planStaffAccess({
  ...SUPER,
  email: "  New.Person@trypennie.com ",
  requestedRole: "admin",
  existing: null,
  adminCount: null,
});
assert(created.ok && created.outcome === "granted", "a brand new address is a grant");
assert(
  created.ok && created.email === "new.person@trypennie.com",
  "the plan carries the NORMALIZED address, so the row is keyed the way login will match it",
);

// The one check that CAN be made on submit today. Slate's login is gated on the
// Workspace domain (#589), so an address outside it can never become a session:
// granting to one is a guaranteed silent failure, and the same predicate the auth
// callback uses says so immediately rather than days later.
const offDomain = planStaffAccess({
  ...SUPER,
  email: "geoff@gmail.com",
  requestedRole: "admin",
  existing: null,
  adminCount: null,
});
assert(
  !offDomain.ok && offDomain.outcome === "wrong_domain",
  "an address outside the Workspace domain is refused on submit, because it could never sign in",
);
assert(
  planStaffAccess({
    ...SUPER,
    allowedDomain: "",
    email: "geoff@gmail.com",
    requestedRole: "admin",
    existing: null,
    adminCount: null,
  }).ok,
  "with no domain configured every account can sign in, so nothing is refused on that ground",
);

// Only the top role reaches this surface, enforced here as well as at the route.
for (const role of ["agent", "manager", "team_lead", "admin"] as Role[]) {
  const p = planStaffAccess({
    actorRole: role,
    actorId: "me",
    actorOrgId: ORG,
    allowedDomain: "trypennie.com",
    email: "new@trypennie.com",
    requestedRole: "admin",
    existing: null,
    adminCount: null,
  });
  assert(
    !p.ok && p.outcome === "not_authorized",
    `${role} cannot grant staff access (the plan refuses independently of the route)`,
  );
}

assert(
  !planStaffAccess({ ...SUPER, email: "nope", requestedRole: "admin", existing: null, adminCount: null }).ok,
  "an unusable address never reaches a write",
);
assert(
  !planStaffAccess({
    ...SUPER,
    email: "new@trypennie.com",
    requestedRole: "agent",
    existing: null,
    adminCount: null,
  }).ok,
  "a role outside the grantable set is refused",
);

const otherOrg = planStaffAccess({
  ...SUPER,
  email: "someone@trypennie.com",
  requestedRole: "admin",
  existing: target({ org_id: "org-2" }),
  adminCount: null,
});
assert(
  !otherOrg.ok && otherOrg.outcome === "other_org",
  "an address already held by another org is refused by name, never silently reused",
);

const gone = planStaffAccess({
  ...SUPER,
  email: "someone@trypennie.com",
  requestedRole: "admin",
  existing: target({ deactivated_at: "2026-01-01T00:00:00Z" }),
  adminCount: null,
});
assert(
  !gone.ok && gone.outcome === "deactivated",
  "a deactivated account is refused rather than quietly promoted back into the org",
);

const same = planStaffAccess({
  ...SUPER,
  email: "someone@trypennie.com",
  requestedRole: "admin",
  existing: target({ role: "admin" }),
  adminCount: null,
});
assert(
  same.ok && same.outcome === "unchanged",
  "an account that already holds the role reports unchanged rather than a fresh grant",
);

const promoted = planStaffAccess({
  ...SUPER,
  email: "someone@trypennie.com",
  requestedRole: "admin",
  existing: target({ role: "manager" }),
  adminCount: null,
});
assert(
  promoted.ok && promoted.outcome === "updated" && promoted.from === "manager",
  "an existing account is updated in place, and the plan names what it moved from",
);

// The last admin case. This surface can lower an existing admin (someone types
// the address of a current admin and picks manager), so it carries the same
// invariant the role editor does.
const lastAdmin = planStaffAccess({
  ...SUPER,
  email: "someone@trypennie.com",
  requestedRole: "manager",
  existing: target({ role: "admin" }),
  adminCount: 1,
});
assert(
  !lastAdmin.ok && lastAdmin.outcome === "last_admin",
  "the final admin cannot be stripped of org power from here",
);

// #1165: a count that could not be READ is not a count. It must refuse, and it
// must refuse in its own words: scoring it as zero produced a confident "cannot
// remove the last admin" about a roster nothing had measured.
const unreadable = planStaffAccess({
  ...SUPER,
  email: "someone@trypennie.com",
  requestedRole: "manager",
  existing: target({ role: "admin" }),
  adminCount: null,
});
assert(
  !unreadable.ok && unreadable.outcome === "admin_count_unreadable",
  "an unreadable admin count refuses, and NOT as a last admin claim",
);
assert(
  !staffAccessMessage("admin_count_unreadable", "someone@trypennie.com").text.match(/last admin/i),
  "the unreadable count message never claims to know how many admins there are",
);
assert(
  staffAccessMessage("last_admin", "someone@trypennie.com").text !==
    staffAccessMessage("admin_count_unreadable", "someone@trypennie.com").text,
  "the two refusals read differently, because they are different facts",
);

// An unreadable count must not block a change that never depended on it.
const unrelated = planStaffAccess({
  ...SUPER,
  email: "someone@trypennie.com",
  requestedRole: "admin",
  existing: target({ role: "manager" }),
  adminCount: null,
});
assert(
  unrelated.ok,
  "a grant that adds org power is unaffected by whether the count could be read",
);

const selfDrop = planStaffAccess({
  ...SUPER,
  email: "me@trypennie.com",
  requestedRole: "manager",
  existing: target({ id: "me", role: "super_admin" }),
  adminCount: 9,
});
assert(
  !selfDrop.ok && selfDrop.outcome === "self_change",
  "you cannot strip your own org power from here and lock yourself out",
);

// ---------------------------------------------------------------------------
// Every outcome says something, and says it in Slate's voice
// ---------------------------------------------------------------------------

for (const outcome of STAFF_ACCESS_OUTCOMES) {
  const m = staffAccessMessage(outcome, "geoff@trypennie.com");
  assert(m.text.trim().length > 0, `outcome ${outcome} renders a message`);
  assert(
    !/undefined|NaN|\[object Object\]/.test(m.text),
    `outcome ${outcome} leaks no placeholder`,
  );
  assert(
    !/[\u2014\u2013]/.test(m.text),
    `outcome ${outcome} carries no dash punctuation`,
  );
  assert(
    ["success", "error", "info"].includes(m.tone),
    `outcome ${outcome} carries a tone the page can render`,
  );
}
assert(
  staffAccessMessage("granted", "geoff@trypennie.com").text.includes("geoff@trypennie.com"),
  "the success message names the address it wrote, so a typo is readable straight back",
);

// ---------------------------------------------------------------------------
// pendingPrivilegedAccess: the silent failure made visible
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 31, 12, 0, 0);

function user(over: Partial<User> & { email: string }): User {
  return {
    id: over.email,
    org_id: ORG,
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
    created_at: new Date(NOW - 2 * DAY).toISOString(),
    ...over,
  } as User;
}

const roster: User[] = [
  user({ email: "waiting-admin@trypennie.com", role: "admin", created_at: new Date(NOW - 10 * DAY).toISOString() }),
  user({ email: "waiting-manager@trypennie.com", role: "manager", created_at: new Date(NOW - 1 * DAY).toISOString() }),
  user({ email: "plain-agent@trypennie.com", role: "agent" }),
  user({ email: "signed-in-admin@trypennie.com", role: "admin", auth_user_id: "auth-1" }),
  user({ email: "left@trypennie.com", role: "admin", deactivated_at: new Date(NOW - DAY).toISOString() }),
  user({ email: "smoke@trypennie.com", role: "admin", is_test: true }),
  // #4201: the placeholder advisor never signs in, and is not a person to chase.
  user({ email: "marcia@trypennie.com", role: "manager", is_placeholder: true }),
];

const pending = pendingPrivilegedAccess(roster, NOW);
assert(pending !== null, "a readable roster produces a list");
const emails = (pending ?? []).map((p) => p.email);
eq(
  emails.join(","),
  "waiting-admin@trypennie.com,waiting-manager@trypennie.com",
  "only unclaimed, active, non test accounts ABOVE agent are waiting, longest wait first",
);
eq((pending ?? [])[0].waitedDays, 10, "the wait is measured in whole days from the row's creation");
assert((pending ?? [])[0].stale, `a ${PENDING_STALE_DAYS} day wait is called out as overdue`);
assert(!(pending ?? [])[1].stale, "a one day wait is not yet overdue");

// L10 / #1165: an unreadable roster is a different answer from an empty one, so
// it comes back as "could not tell", never as "nobody is waiting".
eq(
  pendingPrivilegedAccess(null, NOW),
  null,
  "an unreadable roster returns null, never an empty list that reads as all clear",
);
eq(
  (pendingPrivilegedAccess([], NOW) ?? []).length,
  0,
  "a readable roster with nobody waiting is an empty list, which is a real answer",
);

// The typo signature: the seeded address never signed in, and a nearly identical
// address DID. That pair is the whole failure mode in #160.
const typoRoster: User[] = [
  user({ email: "geof.smith@trypennie.com", role: "admin", created_at: new Date(NOW - 4 * DAY).toISOString() }),
  user({ email: "geoff.smith@trypennie.com", role: "agent", auth_user_id: "auth-9" }),
];
const typo = pendingPrivilegedAccess(typoRoster, NOW) ?? [];
eq(typo.length, 1, "the unclaimed privileged row is the one listed");
eq(
  typo[0].lookalike?.email,
  "geoff.smith@trypennie.com",
  "a signed in account with a near identical address is named as the likely real login",
);

// An unclaimed neighbour proves nothing: only an account that actually signed in
// can be the address the person really uses.
const bothUnclaimed = pendingPrivilegedAccess(
  [
    user({ email: "geof.smith@trypennie.com", role: "admin" }),
    user({ email: "geoff.smith@trypennie.com", role: "agent" }),
  ],
  NOW,
) ?? [];
eq(bothUnclaimed[0].lookalike, null, "a neighbour who has also never signed in is not evidence");

// And it must not cry wolf on two genuinely different people.
const distinct = pendingPrivilegedAccess(
  [
    user({ email: "rgarcia@trypennie.com", role: "admin" }),
    user({ email: "bnelms@trypennie.com", role: "agent", auth_user_id: "auth-3" }),
  ],
  NOW,
) ?? [];
eq(distinct[0].lookalike, null, "two unrelated addresses are not reported as a typo");

const shortNames = pendingPrivilegedAccess(
  [
    user({ email: "sam@trypennie.com", role: "admin" }),
    user({ email: "pam@trypennie.com", role: "agent", auth_user_id: "auth-4" }),
  ],
  NOW,
) ?? [];
eq(
  shortNames[0].lookalike,
  null,
  "short addresses one letter apart are two people, not a typo",
);

eq(emailLocalKey("Geoff.Smith+slate@TryPennie.com"), "geoffsmith", "the comparison key drops dots, tags and case");

// ---------------------------------------------------------------------------
// #1669: this panel adds access, it never lowers a signed in colleague's
// ---------------------------------------------------------------------------
//
// The lookalike remedy button posts the PENDING row's role, and nothing consulted
// the lookalike account's own current role. A seeded `geof.smith` at manager next
// to the real `geoff.smith` who has since been made admin rendered as "Give
// manager access to geoff.smith", and one click dropped Geoff from admin to
// manager as an ordinary `updated` success.
//
// The rule: a downward move on an account somebody has SIGNED IN to is not this
// surface's job. An unclaimed row is, which is the whole point of the panel, so
// the guard keys on `auth_user_id` rather than on the direction alone.

const claimedDemotion = planStaffAccess({
  ...SUPER,
  email: "geoff.smith@trypennie.com",
  requestedRole: "manager",
  existing: target({ role: "admin", auth_user_id: "auth-1" }),
  adminCount: 9,
});
assert(
  !claimedDemotion.ok && claimedDemotion.outcome === "signed_in_demotion",
  "lowering a signed in colleague is refused here, not recorded as an ordinary update",
);

// The healthy control in the same fixture, so the refusal cannot pass vacuously:
// the identical account moving UP is still an ordinary update.
const claimedPromotion = planStaffAccess({
  ...SUPER,
  email: "geoff.smith@trypennie.com",
  requestedRole: "admin",
  existing: target({ role: "manager", auth_user_id: "auth-1" }),
  adminCount: 9,
});
assert(
  claimedPromotion.ok && claimedPromotion.outcome === "updated",
  "the same signed in account moving UP is still an ordinary update",
);

// An UNCLAIMED row may still be lowered: redirecting or correcting a grant nobody
// has ever used is exactly what this panel exists for, and the last admin
// invariant still governs it.
const unclaimedDemotion = planStaffAccess({
  ...SUPER,
  email: "seeded@trypennie.com",
  requestedRole: "manager",
  existing: target({ role: "admin", auth_user_id: null }),
  adminCount: 9,
});
assert(
  unclaimedDemotion.ok && unclaimedDemotion.outcome === "updated",
  "a grant nobody has signed in to can still be corrected downward",
);

// Rank, not the admin threshold: a team lead dropping to manager takes real
// power away and never touches `requiresAdminCount`, so a guard written on the
// admin boundary alone would let the commonest demotion straight through.
const claimedSmallDrop = planStaffAccess({
  ...SUPER,
  email: "geoff.smith@trypennie.com",
  requestedRole: "manager",
  existing: target({ role: "team_lead", auth_user_id: "auth-1" }),
  adminCount: 9,
});
assert(
  !claimedSmallDrop.ok && claimedSmallDrop.outcome === "signed_in_demotion",
  "a drop that never reaches the admin boundary is still a demotion",
);

// Your OWN account keeps the sharper refusal: `self_change` says nothing in Slate
// could give it back, which is a different and more useful fact.
const selfClaimed = planStaffAccess({
  ...SUPER,
  email: "me@trypennie.com",
  requestedRole: "manager",
  existing: target({ id: "me", role: "admin", auth_user_id: "auth-me" }),
  adminCount: 9,
});
assert(
  !selfClaimed.ok && selfClaimed.outcome === "self_change",
  "your own demotion is still reported as self_change, which is the sharper fact",
);

// Three refusals can be true of one downward move at once, so the ORDER is pinned
// rather than left to whichever branch happens to come first.
const claimedLastAdmin = planStaffAccess({
  ...SUPER,
  email: "geoff.smith@trypennie.com",
  requestedRole: "manager",
  existing: target({ role: "admin", auth_user_id: "auth-1" }),
  adminCount: 1,
});
assert(
  !claimedLastAdmin.ok && claimedLastAdmin.outcome === "last_admin",
  "the org wide impossibility outranks the surface rule, so the reader is not sent to a second refusal",
);

const claimedUnreadableCount = planStaffAccess({
  ...SUPER,
  email: "geoff.smith@trypennie.com",
  requestedRole: "manager",
  existing: target({ role: "admin", auth_user_id: "auth-1" }),
  adminCount: null,
});
assert(
  !claimedUnreadableCount.ok && claimedUnreadableCount.outcome === "signed_in_demotion",
  "a measured surface refusal beats one that admits it could not read the count",
);

// The refusal has to be readable and has to say where the change really belongs,
// or it is a dead end on the exact surface somebody opened to fix access (L111).
const demotionText = staffAccessMessage(
  "signed_in_demotion",
  "geoff.smith@trypennie.com",
  "manager",
).text;
assert(
  demotionText.includes("geoff.smith@trypennie.com"),
  "the demotion refusal names the account it protected",
);
assert(
  demotionText !== staffAccessMessage("not_authorized", "geoff.smith@trypennie.com").text,
  "the demotion refusal is its own sentence, not a reused authorization one",
);

// A change to an EXISTING account must not read like a fresh grant. Before this
// the update message was "has been updated as manager", which does not read as a
// removal and does not read as a change to somebody who already had access.
const updatedText = staffAccessMessage("updated", "geoff.smith@trypennie.com", "admin").text;
const grantedText = staffAccessMessage("granted", "geoff.smith@trypennie.com", "admin").text;
assert(updatedText !== grantedText, "an update and a grant are different sentences");
assert(
  /already/i.test(updatedText),
  "the update message says the account already existed, so it cannot be read as a new grant",
);

// The panel can only tell the truth about its own button if the row carries the
// lookalike's CURRENT role. Without it the label is built from the pending row's
// role and claims to give access the person may already outrank.
const outranked = pendingPrivilegedAccess(
  [
    user({ email: "geof.smith@trypennie.com", role: "manager", created_at: new Date(NOW - 4 * DAY).toISOString() }),
    user({ email: "geoff.smith@trypennie.com", role: "admin", auth_user_id: "auth-9" }),
  ],
  NOW,
) ?? [];
eq(
  outranked[0].lookalike?.role,
  "admin",
  "the lookalike carries its own current role, so the button can never offer a demotion",
);


finish();

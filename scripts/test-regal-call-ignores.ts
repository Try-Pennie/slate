// The Regal call ignore list on /admin/alerts (#2090). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-regal-call-ignores.ts
//
// Pins who the picker offers (agents only, never a test user, never somebody
// already listed), that people are named rather than shown as addresses, and that
// the server re-checks every rule the picker applied, because a posted form is not
// bound by the options it was drawn with.
import {
  ignorePickerOptions,
  ignoreListRows,
  parseIgnoreAdd,
  IGNORE_REASON_MAX,
  type IgnoreRosterUser,
} from "@/lib/admin/regal-call-ignores";
import { assert, eq, finish } from "./lib/harness.ts";

function u(over: Partial<IgnoreRosterUser>): IgnoreRosterUser {
  return {
    id: "x",
    name: "X",
    email: "x@trypennie.com",
    role: "agent",
    is_test: false,
    is_placeholder: false,
    deactivated_at: null,
    ...over,
  };
}
const roster = [
  u({ id: "a", name: "Zed Agent", email: "zed@trypennie.com" }),
  u({ id: "b", name: "Amy Agent", email: "amy@trypennie.com" }),
  u({ id: "c", name: "Mo Manager", email: "mo@trypennie.com", role: "manager" }),
  u({ id: "d", name: "Tess Test", email: "tess@trypennie.com", is_test: true }),
  u({ id: "e", name: "Sam Same", email: "sam1@trypennie.com" }),
  u({ id: "f", name: "Sam Same", email: "sam2@trypennie.com" }),
  u({ id: "g", name: null, email: "nameless@trypennie.com" }),
  u({ id: "h", name: "Leah Left", email: "leah@trypennie.com", deactivated_at: "2026-09-01T00:00:00Z" }),
  u({ id: "i", name: "Ivy Ignored", email: "ivy@trypennie.com" }),
  u({ id: "p", name: "Marcia", email: "marcia@trypennie.com", is_placeholder: true }),
];

const options = ignorePickerOptions(roster, [{ user_id: "i" }]);
const labels = options.map((o) => o.label);
eq(
  [...labels].sort(),
  [
    "Amy Agent",
    "Leah Left, deactivated",
    "nameless@trypennie.com",
    "Sam Same (sam1@trypennie.com)",
    "Sam Same (sam2@trypennie.com)",
    "Zed Agent",
  ].sort(),
  "agents only, by name, addresses only where a name is missing or shared, deactivated said",
);
eq(labels, [...labels].sort((a, b) => a.localeCompare(b)), "the picker is in alphabetical order");
assert(!options.some((o) => o.value === "c"), "a manager is never offered: their calls are never reported anyway");
assert(!options.some((o) => o.value === "d"), "a test user is never offered");
assert(!options.some((o) => o.value === "i"), "somebody already listed is not offered twice");
// #4201: the placeholder advisor is exempt in the detector, so listing it suppresses nothing.
assert(!options.some((o) => o.value === "p"), "the placeholder advisor is never offered");

// At production scale, the picker still names everybody once.
const big: IgnoreRosterUser[] = Array.from({ length: 136 }, (_, k) =>
  u({ id: `u${k}`, name: `Agent ${String(k).padStart(3, "0")}`, email: `a${k}@trypennie.com` }),
);
eq(ignorePickerOptions(big, []).length, 136, "all 136 agents are offered at the real count");

const rows = ignoreListRows(
  [
    { user_id: "a", reason: "dialer only", added_by: "c", added_at: "2026-09-20T10:00:00Z" },
    { user_id: "b", reason: "outbound campaigns", added_by: null, added_at: "2026-09-21T10:00:00Z" },
    { user_id: "zz", reason: "gone", added_by: "c", added_at: "2026-09-21T10:00:00Z" },
  ],
  roster,
);
eq(rows.map((r) => r.person), ["Amy Agent", "Unknown user zz", "Zed Agent"], "listed people are named and sorted");
eq(rows.find((r) => r.userId === "a")?.addedBy, "Mo Manager", "who added them is named");
eq(rows.find((r) => r.userId === "b")?.addedBy, "someone no longer in Slate", "a lost adder says so rather than blank");

const agent = roster[0];
eq(parseIgnoreAdd({ userId: "a", reason: "  dialer only  " }, agent), { ok: true, row: { user_id: "a", reason: "dialer only" } }, "a valid add trims its reason");
for (const [raw, target, why] of [
  [{ userId: "", reason: "x" }, null, "no person"],
  [{ userId: "zz", reason: "x" }, null, "a person not in Slate"],
  [{ userId: "c", reason: "x" }, roster[2], "a manager"],
  [{ userId: "d", reason: "x" }, roster[3], "a test user"],
  [{ userId: "p", reason: "x" }, roster[9], "the placeholder advisor"],
  [{ userId: "a", reason: "   " }, agent, "a blank reason"],
  [{ userId: "a", reason: "y".repeat(IGNORE_REASON_MAX + 1) }, agent, "an overlong reason"],
] as const) {
  const r = parseIgnoreAdd(raw, target);
  assert(!r.ok && r.error.length > 0, `refused with a sentence: ${why}`);
}

finish();

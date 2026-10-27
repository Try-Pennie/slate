// The Coordinator booking page's list of coordinators (#4264, D10, D13): who is on it, in what
// order, and what the Last signed in column says. Pure rules, driven with plain rows.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-coordinator-list.ts
import { DateTime } from "luxon";
import { assert, eq, finish } from "./lib/harness.ts";
import { coordinatorRows, signedInWhen, type CoordinatorUser, type SignIn } from "../src/lib/admin/coordinators.ts";

const ZONE = "America/New_York";
// 15:00 Eastern on a Tuesday, so "today" has hours behind it and "yesterday" is a real day.
const now = DateTime.fromISO("2026-10-27T15:00:00", { zone: ZONE });
const NOW = now.toMillis();
const at = (d: DateTime) => ({ kind: "at", iso: d.toUTC().toISO()! }) as SignIn;

// --- what the column says --------------------------------------------------------------------------
{
  eq(signedInWhen(at(now.minus({ seconds: 20 })), NOW, ZONE), "just now", "under a minute is just now");
  eq(signedInWhen(at(now.minus({ minutes: 1 })), NOW, ZONE), "1 minute ago", "one minute, singular");
  eq(signedInWhen(at(now.minus({ minutes: 40 })), NOW, ZONE), "40 minutes ago", "minutes under the hour");
  eq(signedInWhen(at(now.minus({ hours: 1, minutes: 5 })), NOW, ZONE), "1 hour ago", "one hour, singular");
  eq(signedInWhen(at(now.minus({ hours: 2 })), NOW, ZONE), "2 hours ago", "the design's 2 hours ago");
  eq(signedInWhen(at(now.minus({ hours: 6 })), NOW, ZONE), "today", "earlier the same Eastern day is today");
  eq(signedInWhen(at(now.minus({ days: 1 })), NOW, ZONE), "yesterday", "the Eastern day before is yesterday");
  eq(signedInWhen(at(now.minus({ days: 4 })), NOW, ZONE), "4 days ago", "the design's 4 days ago");
  eq(signedInWhen(at(now.minus({ days: 38 })), NOW, ZONE), "38 days ago", "the design's 38 days ago");
  // Counted in Eastern calendar days, not 24 hour blocks: 23:30 two nights ago is two days back.
  const lateTwoNightsAgo = now.minus({ days: 2 }).set({ hour: 23, minute: 30 });
  eq(signedInWhen(at(lateTwoNightsAgo), NOW, ZONE), "2 days ago", "calendar days in the business zone");
  eq(signedInWhen({ kind: "never" }, NOW, ZONE), "Never signed in", "never signed in is said");
  eq(signedInWhen({ kind: "unreadable" }, NOW, ZONE), "Could not read", "an unreadable sign in is said, never guessed");
  // A stamp that does not parse is not a time, and must not render as one (L50).
  eq(signedInWhen({ kind: "at", iso: "not a time" }, NOW, ZONE), "Could not read", "an unparseable stamp is unreadable");
  // A clock a little ahead of ours is just now, not a negative age.
  eq(signedInWhen(at(now.plus({ minutes: 2 })), NOW, ZONE), "just now", "a stamp slightly in the future is just now");
}

// --- who is listed, and in what order -------------------------------------------------------------
{
  const users: CoordinatorUser[] = [
    { id: "t", name: "Tomas Rivera", email: "trivera@trypennie.com", auth_user_id: "a-t" },
    { id: "a", name: "Aisha Bello", email: "abello@trypennie.com", auth_user_id: "a-a" },
    // Granted on Team access and never signed in, so no name was ever recorded.
    { id: "n", name: null, email: "nobody.yet@trypennie.com", auth_user_id: null },
    { id: "g", name: "grace Okafor", email: "gokafor@trypennie.com", auth_user_id: "a-g" },
  ];
  const signIns = new Map<string, SignIn>([
    ["a-t", at(now.minus({ days: 38 }))],
    ["a-a", at(now.minus({ hours: 2 }))],
    ["a-g", { kind: "unreadable" }],
  ]);
  const rows = coordinatorRows(users, signIns, NOW, ZONE);
  const names = rows.map((r) => r.name);
  const byName = [...names].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  eq(names, byName, "the rows are in alphabetical order of the name shown, ignoring case");
  // Not the code point order, which would put the lower case "grace" after "Tomas".
  assert(names.indexOf("grace Okafor") < names.indexOf("Tomas Rivera"), "case does not decide the order");
  assert(names.includes("nobody.yet@trypennie.com"), "an address stands in for a missing name");
  eq(rows[0], { id: "a", name: "Aisha Bello", email: "abello@trypennie.com", lastSignedIn: "2 hours ago" }, "a row carries its email and sign in");
  eq(rows.find((r) => r.id === "n")?.lastSignedIn, "Never signed in", "a row with no sign in account never signed in");
  eq(rows.find((r) => r.id === "g")?.lastSignedIn, "Could not read", "an unreadable sign in reads as unreadable");
  // A sign in account the lookup has no answer for is unreadable, never "never signed in".
  const missing = coordinatorRows([{ id: "x", name: "X Y", email: "x@trypennie.com", auth_user_id: "a-x" }], new Map(), NOW, ZONE);
  eq(missing[0]?.lastSignedIn, "Could not read", "a sign in account with no answer is unreadable");
  eq(coordinatorRows([], new Map(), NOW, ZONE), [], "no coordinators is an empty list, for the page to say so");
  assert(rows.length === users.length, "every coordinator read is listed");
}

finish();

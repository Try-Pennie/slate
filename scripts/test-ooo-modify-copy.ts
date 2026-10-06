// #3365: what the manager and the agent are told when a time off request is changed.
//
// The words must match what the change DID to what an approval holds: a kept window
// is blocked while the manager decides, a released one is not, and a narrowing whose
// calendar could not be moved has not reopened anything. A sentence claiming the
// wrong one sends somebody to act on a state that does not exist (L11).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-ooo-modify-copy.ts
import {
  declinedReleasedLine,
  modifyAgentDm,
  modifyManagerHeading,
  modifyManagerNote,
  type ModifyOutcome,
} from "../src/lib/ooo/modify-copy.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const WHEN = "Wed, Oct 7 2026 from 11:30am to 11:59pm MT";
const APPROVED = "Wed, Oct 7 2026 all day MT";
const outcomes: { name: string; o: ModifyOutcome }[] = [
  { name: "edited", o: { kind: "edited" } },
  { name: "released", o: { kind: "released" } },
  { name: "kept shortened", o: { kind: "kept", shortened: true, stillEarlier: null } },
  { name: "kept same window", o: { kind: "kept", shortened: false, stillEarlier: null } },
  { name: "kept, calendar not moved", o: { kind: "kept", shortened: true, stillEarlier: "calendar" } },
  { name: "kept, block not narrowed", o: { kind: "kept", shortened: true, stillEarlier: "block" } },
];

// Headings: only a real shortening is called one, and only a held request needs re-approval.
eq(modifyManagerHeading({ kind: "edited" }), "Changed time off request", "a pending edit keeps the plain heading");
eq(modifyManagerHeading({ kind: "released" }), "Changed time off request (needs re-approval)", "a released change needs re-approval");
eq(modifyManagerHeading(outcomes[2]!.o), "Shortened time off request (needs re-approval)", "a narrowing is named as one");
eq(modifyManagerHeading(outcomes[3]!.o), "Changed time off request (needs re-approval)", "an unchanged window is not called shortened");

// Notes: what is blocked while the manager decides.
eq(modifyManagerNote({ kind: "edited" }, APPROVED), null, "a pending edit carries no note");
assert(/Nothing is blocked until you approve/.test(modifyManagerNote({ kind: "released" }, APPROVED)!), "released: nothing is blocked meanwhile");
const keptNote = modifyManagerNote(outcomes[2]!.o, APPROVED)!;
assert(keptNote.includes(APPROVED) && /stays blocked while you decide/.test(keptNote), "kept: names what was approved and that the new window stays blocked");
assert(/declining ends the time off/.test(keptNote), "kept: says what declining does");

// Agent DMs.
eq(modifyAgentDm({ kind: "edited" }, WHEN), null, "a pending edit sends the agent nothing (unchanged)");
const released = modifyAgentDm({ kind: "released" }, WHEN)!;
assert(/re-approval/.test(released) && /none of that time is blocked/.test(released), "released: says nothing is blocked until approval");
const kept = modifyAgentDm(outcomes[2]!.o, WHEN)!;
assert(/stays blocked meanwhile/.test(kept) && /hours you removed are open for bookings again/.test(kept), "kept: says what stays blocked and what reopened");
const same = modifyAgentDm(outcomes[3]!.o, WHEN)!;
assert(!/hours you removed/.test(same), "kept same window: claims no removed hours");
const stuck = modifyAgentDm(outcomes[4]!.o, WHEN)!;
assert(/could not be updated to match yet/.test(stuck), "calendar not moved: says so");
assert(!/open for bookings again/.test(stuck), "calendar not moved: never claims the removed hours reopened");
// The block could not be narrowed: the event moved, so the calendar is NOT the cause,
// and the removed hours are still held (L11: a distinct cause, a distinct sentence).
const blockStuck = modifyAgentDm(outcomes[5]!.o, WHEN)!;
assert(/earlier window is still blocked/.test(blockStuck), "block not narrowed: says the earlier window is still blocked");
assert(!/open for bookings again/.test(blockStuck), "block not narrowed: never claims the removed hours reopened");
assert(!/calendar could not be updated/.test(blockStuck), "block not narrowed: does not blame the calendar");
for (const i of [4, 5]) {
  const note = modifyManagerNote(outcomes[i]!.o, APPROVED)!;
  assert(note.includes(APPROVED) && /earlier window is still blocked/.test(note), `${outcomes[i]!.name}: the manager is told the earlier window is still held`);
  assert(!/new window stays blocked/.test(note), `${outcomes[i]!.name}: and never that only the new window is held`);
}
assert(
  modifyManagerNote(outcomes[4]!.o, APPROVED) !== modifyManagerNote(outcomes[5]!.o, APPROVED),
  "the two causes read differently to the manager",
);

assert(/no longer blocked/.test(declinedReleasedLine()), "a decline that released a held window says so");

// Copy rules: no dashes as punctuation, in anything these build. Built from escaped
// strings, so this file holds no literal dash for the style hook to catch.
const DASHES = new RegExp("[\\u2013\\u2014]|\\s\\u002d\\s");
for (const { name, o } of outcomes) {
  for (const text of [modifyManagerHeading(o), modifyManagerNote(o, "X") ?? "", modifyAgentDm(o, "X") ?? ""]) {
    assert(!DASHES.test(text), `${name}: no dashes (${text})`);
  }
}

finish();

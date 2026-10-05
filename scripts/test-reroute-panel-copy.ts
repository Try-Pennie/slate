// #3250: the reroute panel's words and the manager's bucket choice (phase 4 of #3244).
//
// Every sentence the panel shows comes from one builder (R8 to R15 on #3250), so the
// component holds no wording of its own, and an admin reads codes while a manager
// reads pool names (R7, R15). A manager picks a backend and a debt level instead of
// a code, and the booking keeps the rest of its code (R5, R6).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-reroute-panel-copy.ts
import {
  composeManagerCode,
  managerChoiceFromCode,
  bucketWords,
  proposalCopy,
  outcomeCopy,
  heldFor,
  tiersDownPhrase,
} from "../src/lib/booking/reroute-copy.ts";
import type { RerouteProposal } from "../src/lib/booking/reroute.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- R6: a manager's choice keeps the rest of the booking's code ---
eq(composeManagerCode("100", "5", "either"), "500", "100 to Ultra High, Either, is 500");
eq(composeManagerCode("100", "5", "achieve"), "530", "100 to Ultra High, Achieve, is 530");
eq(composeManagerCode("112", "3", "beyond"), "322", "the legal digit is kept (112 to High, Beyond, is 322)");
eq(composeManagerCode("132", "4", "either"), "412", "Either from a Beyond or Achieve code stores Both");
eq(composeManagerCode("102", "2", "either"), "202", "Either keeps None when the code had None");
eq(composeManagerCode(null, "2", "beyond"), "220", "with no readable current code the legal digit is No Legal Param");
eq(composeManagerCode("SMOKE", "2", "either"), "210", "a test code is no XBC, so nothing of it is kept");

eq(managerChoiceFromCode("332"), { debt: "3", backend: "achieve" }, "the controls start from the booking's own code");
eq(managerChoiceFromCode("512"), { debt: "5", backend: "either" }, "Both reads as Either");
eq(managerChoiceFromCode("100"), { debt: "1", backend: "either" }, "None reads as Either");
eq(managerChoiceFromCode("SMOKE"), { debt: "1", backend: "either" }, "an unreadable code starts at the lowest tier, Either");

// --- R7: codes for an admin, pool names for a manager ---
eq(bucketWords("512", true), "512", "an admin reads the code");
eq(bucketWords("512", false), "Ultra High", "a manager reads the pool");
eq(bucketWords("332", false), "High with Achieve", "including the backend");

// --- R8 to R11 ---
const bucket = (code: string) => ({ id: `b${code}`, code, name: `n${code}` });
const advisor = (name: string) => ({ userId: name, name, email: `${name}@x.com` });
const move = (code: string, rungs: number): RerouteProposal => ({
  kind: "move", holdId: "H", expiresAt: "x", secondsRemaining: 272,
  advisor: advisor("Morgan Reyes"), bucket: bucket(code), requested: bucket("512"), rungsDropped: rungs,
});

{
  const c = proposalCopy(move("512", 0), true);
  eq(c.heading, "In 512", "R8: found in the bucket asked for");
  eq(c.body, "Morgan Reyes is free.", "R8: who");
  eq(c.primary, "Move to Morgan Reyes", "R14: the move button names the advisor");
  eq(c.held, true, "R14: a move is held");
}
{
  const c = proposalCopy(move("412", 1), true);
  eq(c.heading, "One tier down, in 412", "R9: the drop leads");
  eq(c.body, "Morgan Reyes is free. Nobody in 512 is.", "R9: who, and who was not");
}
eq(proposalCopy(move("312", 2), true).heading, "Two tiers down, in 312", "R9: two tiers");
{
  const c = proposalCopy(move("412", 1), false);
  eq(c.heading, "One tier down, in Very High", "R15: a manager reads pools in the heading");
  eq(c.body, "Morgan Reyes is free. Nobody in Ultra High is.", "R15: and in the body");
}
{
  const p: RerouteProposal = { kind: "keep", lastResort: true, advisor: advisor("Taylor Brooks"), bucket: bucket("512"), requested: bucket("512"), rungsDropped: 0 };
  const c = proposalCopy(p, true);
  eq(c.heading, "Taylor Brooks stays", "R10: the current advisor stays");
  eq(c.body, "Nobody else in 512 or any tier below is free. The bucket changes to 512 and the advisor does not.", "R10: why, and what changes");
  eq(c.primary, "Change the bucket to 512", "R10: the button says what it does");
  eq(c.held, false, "R10: nothing is held for a keep");
}
{
  const p: RerouteProposal = { kind: "keep", lastResort: false, advisor: advisor("Taylor Brooks"), bucket: bucket("412"), requested: bucket("512"), rungsDropped: 1 };
  const c = proposalCopy(p, true);
  eq(c.heading, "One tier down, in 412", "a cascaded keep leads with the drop too");
  eq(c.body, "Taylor Brooks can keep this call. Nobody in 512 is free.", "and says the advisor keeps it");
  eq(c.primary, "Change the bucket to 412", "correcting to where they were kept");
}
{
  const p: RerouteProposal = { kind: "keep", lastResort: false, advisor: advisor("Taylor Brooks"), bucket: bucket("512"), requested: bucket("512"), rungsDropped: 0 };
  const c = proposalCopy(p, true);
  eq(c.heading, "In 512", "a keep in the bucket asked for");
  eq(c.body, "Taylor Brooks can keep this call.", "the advisor is eligible there");
}
{
  const c = proposalCopy({ kind: "none", requested: bucket("512") }, true);
  eq(c.heading, "Nobody is free", "R11: nobody");
  eq(c.body, "Nobody in 512 or any tier below is free at this time. Nothing has changed.", "R11: and nothing changed");
  eq(c.primary, null, "R11: no button");
  eq(c.note, false, "R11: no note");
}

// --- R12, R13 and what a confirm did ---
{
  const c = outcomeCopy({ kind: "expired" }, true, "Morgan Reyes");
  eq(c.heading, "The hold ran out", "R12");
  eq(c.body, "Morgan Reyes may have been booked since. Nothing has changed.", "R12: naming who was held");
}
{
  const c = outcomeCopy({ kind: "taken", previous: advisor("Morgan Reyes"), proposal: { ...move("412", 1), advisor: advisor("Casey Lin") } }, true, null);
  eq(c.heading, "One tier down, in 412", "R13: the new proposal's heading");
  eq(c.body, "Morgan Reyes was booked a moment ago, so Slate searched again. Casey Lin is free. Nobody in 512 is.", "R13: who was taken, then the new answer");
  eq(c.primary, "Move to Casey Lin", "R13: moving to the new advisor");
}
eq(outcomeCopy({ kind: "moved", advisor: advisor("Morgan Reyes"), bucket: bucket("412") }, true, null).body, "Moved to Morgan Reyes, in 412.", "a move says what it did");
eq(outcomeCopy({ kind: "kept", bucket: bucket("512") }, false, null).body, "The pool is now Ultra High.", "a keep says what it did, in pool words for a manager");
eq(outcomeCopy({ kind: "kept", bucket: bucket("512") }, true, null).body, "The bucket is now 512.", "and in code words for an admin");

// --- R14 ---
eq(heldFor(272), "Held for 4:32", "the countdown reads minutes and seconds");
eq(heldFor(5), "Held for 0:05", "padding the seconds");
eq(heldFor(-3), "Held for 0:00", "never negative");
eq(heldFor(Number.NaN), "Held for 0:00", "an unreadable count reads as none left, never NaN (L50)");
eq(tiersDownPhrase(3), "Three tiers down", "three tiers");
assert(!/[\u2014\u2013]/.test(JSON.stringify([proposalCopy(move("412", 1), true), outcomeCopy({ kind: "expired" }, true, "A")])), "no dashes in any sentence");

finish();

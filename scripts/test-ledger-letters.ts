// The ledger's five letters must stay distinct (#1817).
//
// `DebtTeamLedger` draws one letter per rung in a fixed position, and the letters
// are DERIVED from the tier names. Today that yields L, M, H, V, U, which happen
// to be unique, and nothing said they had to be.
//
// `DEBT_TIER` is not a display table. It is part of the XBC routing contract, the
// same three digit vocabulary Salesforce and the landing pages use, so its labels
// get adjusted for reasons that have nothing to do with this column. The moment
// two share a first letter the column draws two identical letters in fixed
// positions, which is unreadable as a position marker, and the column header
// legend renders "H High, H Heavy" with a straight face.
//
// Nothing would fail. Every test passes, the page renders, and it is found by
// somebody squinting at a column wondering why two rungs look the same. The
// derived-key version of L113: a lookup keyed by a vocabulary needs its
// completeness enforced rather than assumed, because the silent branch is
// indistinguishable from the correct one.
//
// Deriving the letters was the right call. This is what makes it safe rather than
// lucky, and the remedy it names is resolving the clash where the labels live
// rather than renaming a tier the routing contract depends on.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-ledger-letters.ts
import { assert, eq, finish } from "./lib/harness.ts";
import {
  DEBT_TEAM_RUNGS,
  LETTER_COLLISION_REMEDY,
  collidingRungLetters,
  debtTeamRungLetter,
  rungLetter,
} from "@/lib/admin/debt-team";
import { DEBT_TIER } from "@/lib/xbc";

// --- the real vocabulary --------------------------------------------------
{
  const clashes = collidingRungLetters(DEBT_TIER);
  if (clashes.length === 0) {
    assert(true, "the five shipped tier letters are all distinct");
  } else {
    for (const c of clashes) {
      assert(
        false,
        `rungs ${c.rungs.map((r) => r.rank).join(" and ")} both draw "${c.letter}" ` +
          `(${c.rungs.map((r) => r.label).join(", ")}). ${LETTER_COLLISION_REMEDY}`,
      );
    }
  }

  // The positive control the issue asks for: a guard that iterated an EMPTY rung
  // list would report success on a table it never read (L98). So the count of
  // rungs actually examined is asserted, and each one has to yield a letter.
  eq(DEBT_TEAM_RUNGS.length, 5, "five rungs were examined, not zero");
  const letters = DEBT_TEAM_RUNGS.map(debtTeamRungLetter);
  eq(letters.join(""), "LMHVU", "and they are the letters the column actually draws");
  for (const l of letters) assert(/^[A-Z]$/.test(l), `"${l}" is a single capital letter`);
  eq(new Set(letters).size, letters.length, "no two of them are the same");
}

// --- the guard, seen to fail ----------------------------------------------
//
// Two rungs both starting with U, which is the realistic case given Ultra High
// already exists.
{
  const collides = {
    "1": { key: "low", label: "Low" },
    "2": { key: "medium", label: "Medium" },
    "3": { key: "high", label: "High" },
    "4": { key: "very_high", label: "Urgent High" },
    "5": { key: "ultra_high", label: "Ultra High" },
  };
  const clashes = collidingRungLetters(collides);
  eq(clashes.length, 1, "one clash found");
  eq(clashes[0]!.letter, "U", "and it names the letter");
  eq(
    clashes[0]!.rungs.map((r) => r.rank).join(","),
    "4,5",
    "and BOTH rungs, so the reader is not left hunting for the other one",
  );
  eq(
    clashes[0]!.rungs.map((r) => r.label).join(", "),
    "Urgent High, Ultra High",
    "and both labels, so it reads as a naming question",
  );
  // A guard that only refuses is a dead end (L109), so the remedy travels with it.
  assert(LETTER_COLLISION_REMEDY.length > 40, "the remedy is a real instruction");
  assert(/letter/i.test(LETTER_COLLISION_REMEDY), "and it names the mechanism");
}

// --- three clashing at once, so the report is not shaped for exactly two ---
{
  const clashes = collidingRungLetters({
    "1": { key: "low", label: "High load" },
    "2": { key: "medium", label: "Heavy" },
    "3": { key: "high", label: "High" },
    "4": { key: "very_high", label: "Very High" },
    "5": { key: "ultra_high", label: "Ultra High" },
  });
  eq(clashes.length, 1, "one letter, three rungs");
  eq(clashes[0]!.rungs.length, 3, "all three are named");
}

// --- the remedy actually works --------------------------------------------
//
// An explicit letter beside the label resolves the clash where the vocabulary
// lives, rather than by renaming a tier the routing contract depends on. Driven
// here so the branch the message points at is not itself untested (L101).
{
  const fixed = {
    "1": { key: "low", label: "Low" },
    "2": { key: "medium", label: "Medium" },
    "3": { key: "high", label: "High" },
    "4": { key: "very_high", label: "Urgent High", letter: "R" },
    "5": { key: "ultra_high", label: "Ultra High" },
  };
  eq(collidingRungLetters(fixed).length, 0, "an explicit letter clears the clash");
  eq(rungLetter(fixed["4"]!), "R", "and it is the letter that gets drawn");
  eq(rungLetter(fixed["3"]!), "H", "while the others still come from the label");
  eq(rungLetter({ label: "Low", letter: "q" }), "Q", "an explicit letter is capitalised too");
}

finish();

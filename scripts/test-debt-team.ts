// Debt team as a RANK, not a comma list (#1796).
//
// Dan, 2026-09-03: "let's make these teams look nicer. definitely no
// underscores but I wanted if you can add some /impeccable delight".
//
// The column printed raw database keys ("ultra_high, very_high, high, medium"),
// which is a second spelling of a vocabulary `DEBT_TIER` already gives labels
// for, and it threw away the one thing the values mean: they are rungs 1 to 5,
// and an agent covers a band of them. Reading four words to learn "this agent
// takes the top four" is the defect.
//
// The part that must not silently drop data: `debt_team` is NOT guaranteed to
// hold only the five ladder keys (`ultra_high_beyond` is used in the staffing
// depth tests, and `credit` / `medical` in the roster filter ones). A five rung
// glyph keyed on the ladder finds no rung for those, and the tempting
// implementation drops them, which would under report an agent's coverage on the
// very screen that exists to show it (L113).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-debt-team.ts
import { assert, eq, finish } from "./lib/harness.ts";
import {
  DEBT_TEAM_RUNGS,
  debtTeamCoverage,
  debtTeamLabel,
  debtTeamRungLabel,
  debtTeamValueText,
} from "@/lib/admin/debt-team";
import { DEBT_TIER } from "@/lib/xbc";

// --- the ladder is the DEBT_TIER vocabulary, not a second copy of it -------
{
  eq(DEBT_TEAM_RUNGS.length, 5, "five rungs");
  eq(DEBT_TEAM_RUNGS.join(","), "1,2,3,4,5", "ascending, low to high");
  for (const rank of DEBT_TEAM_RUNGS) {
    eq(
      debtTeamRungLabel(rank),
      DEBT_TIER[String(rank)]!.label,
      `rung ${rank} takes its label from DEBT_TIER, so there is one spelling`,
    );
  }
  // The whole complaint, as an assertion: no underscore reaches a reader.
  for (const rank of DEBT_TEAM_RUNGS) {
    assert(!debtTeamRungLabel(rank).includes("_"), `rung ${rank} has no underscore`);
  }
}

// --- reading the stored value, in both shapes ------------------------------
{
  // `debt_team` is an array on most agents and a bare string on a few, and
  // treating it as one shape drops every agent with the other.
  eq(debtTeamCoverage(["low"]).ranks.join(","), "1", "a single element array");
  eq(debtTeamCoverage(["high", "medium", "low"]).ranks.join(","), "1,2,3", "sorted ascending");
  eq(debtTeamCoverage([]).ranks.length, 0, "nothing set");
  eq(debtTeamCoverage(["low", "low"]).ranks.join(","), "1", "a repeat is one rung");
  eq(debtTeamCoverage([" Low "]).ranks.join(","), "1", "trimmed and case insensitive");
  eq(
    debtTeamCoverage(["ultra_high", "very_high", "high", "medium"]).ranks.join(","),
    "2,3,4,5",
    "the top four, in rank order rather than stored order",
  );
}

// --- a value off the ladder is SHOWN, never dropped -----------------------
{
  const c = debtTeamCoverage(["low", "ultra_high_beyond"]);
  eq(c.ranks.join(","), "1", "the ladder value still lands on its rung");
  eq(c.offLadder.join(","), "ultra_high_beyond", "and the unknown one survives");
  // As STORED, so nobody hunts for a formatting bug that is really a data
  // question. Deliberately not prettified.
  eq(
    debtTeamCoverage(["Credit", "medical"]).offLadder.join(","),
    "Credit,medical",
    "shown exactly as stored, original casing included",
  );
  eq(debtTeamCoverage(["low", "credit", "credit"]).offLadder.length, 1, "deduped too");
  // The trap this exists for: a longer value that CONTAINS a ladder key must not
  // be read as that key.
  eq(debtTeamCoverage(["ultra_high_beyond"]).ranks.length, 0, "no partial match onto a rung");
}

// --- the words -------------------------------------------------------------
{
  const label = (teams: string[]) => debtTeamLabel(debtTeamCoverage(teams));
  eq(label([]), "No team set", "nothing set says so, rather than rendering blank");
  eq(label(["low"]), "Covers Low", "one tier");
  // #2143: every team is NAMED, contiguous or not. A range names two of the three
  // teams an agent covers and leaves the reader to work out the rest from a ladder
  // they have to already know the order of, which is the piece of domain knowledge
  // this field exists to save them looking up.
  eq(label(["low", "medium", "high"]), "Covers Low, Medium, High", "a contiguous band names every team in it");
  eq(
    label(["medium", "high", "very_high", "ultra_high"]),
    "Covers Medium, High, Very High, Ultra High",
    "the top four, named rather than banded",
  );
  eq(
    label(["low", "medium", "high", "very_high", "ultra_high"]),
    "Covers Low, Medium, High, Very High, Ultra High",
    "and all five, where a phrase for the whole ladder said nothing at all",
  );
  eq(label(["low", "high", "ultra_high"]), "Covers Low, High, Ultra High", "a gap reads as a list");
  eq(label(["ultra_high_beyond"]), "Covers ultra_high_beyond", "an off ladder value alone");
  eq(
    label(["low", "medium", "ultra_high_beyond"]),
    "Covers Low, Medium, plus ultra_high_beyond",
    "a band and an off ladder value together, neither hidden",
  );
  // No underscore anywhere a reader can see it, EXCEPT inside a value that is
  // stored that way, where showing it verbatim is the point.
  assert(!label(["ultra_high", "very_high"]).includes("_"), "ladder labels carry no key spelling");
}

// --- the invariant the column exists for ----------------------------------
{
  // Every stored value ends up either on a rung or in the off ladder list, and
  // never in both. A value falling through both is the silent drop (L113).
  const inputs = [
    ["low", "medium"],
    ["ultra_high_beyond", "credit"],
    ["high", "medical", "ultra_high"],
    [],
    ["", "  "],
  ];
  for (const teams of inputs) {
    const c = debtTeamCoverage(teams);
    const accounted = c.ranks.length + c.offLadder.length;
    const meaningful = new Set(
      teams.map((t) => t.trim().toLowerCase()).filter((t) => t !== ""),
    ).size;
    eq(accounted, meaningful, `every value in ${JSON.stringify(teams)} is accounted for`);
  }
  // Blank strings are not data and must not become an off ladder chip.
  eq(debtTeamCoverage(["", " "]).offLadder.length, 0, "a blank value is not a team");
}

// --- the same coverage, spelled out for a single record (#2120) ------------
//
// Dan, looking at the agent page: "make the debt teams full words here so it's
// clear". The ladder earns its place in a COLUMN, where five fixed positions
// align down 136 rows and that alignment is the whole argument for drawing it.
// A single record has no column to align to, so the letters buy nothing and cost
// a legend the reader has to find. The words come from the SAME coverage the
// ladder draws, so the two surfaces can never disagree about one agent (L41).
{
  const say = (teams: string[]) => debtTeamValueText(debtTeamCoverage(teams));

  eq(say(["low"]), "Low", "one rung is its label");
  eq(
    say(["medium", "high", "very_high", "ultra_high"]),
    "Medium, High, Very High, Ultra High",
    "a contiguous band names every team, so the reader never recites the ladder (#2143)",
  );
  eq(
    say(["low", "high"]),
    "Low, High",
    "a gap must read as a list: a range would claim the middle rung it does not cover",
  );
  eq(
    say(["low", "medium", "high", "very_high", "ultra_high"]),
    "Low, Medium, High, Very High, Ultra High",
    "and the whole ladder is named too, since a phrase for it named nothing",
  );

  // The off ladder rule the glyph already follows (L113): a stored value that is
  // not a rung is shown, or the panel that exists to say what an agent covers
  // under reports them.
  eq(say(["low", "credit"]), "Low, plus credit", "an off ladder value is named too");
  eq(
    say(["credit"]),
    "credit",
    "an off ladder value alone is still the answer, and keeps the case it was stored in",
  );

  // Absent is the caller's business, not a sentence pretending to be a value.
  // The panel prints the same "Not set" its sibling field uses, and a builder
  // that returned its own wording here would be a second vocabulary for one
  // state (L118).
  eq(say([]), null, "no coverage is null, so the caller names it in its own words");
  eq(say(["", "  "]), null, "a blank is not coverage either");

  // The ladder's accessible name is this value with a verb in front, and nothing
  // else. Asserted over every shape rather than on one, because the two surfaces
  // saying different things about one agent is the failure this shares a
  // derivation to prevent (L41).
  for (const teams of [
    ["low"],
    ["medium", "high"],
    ["low", "credit"],
    ["credit"],
    ["low", "medium", "high", "very_high", "ultra_high"],
    ["low", "high"],
  ]) {
    const c = debtTeamCoverage(teams);
    eq(
      debtTeamLabel(c),
      `Covers ${debtTeamValueText(c)}`,
      `the record and the roster say the same thing about ${JSON.stringify(teams)}`,
    );
  }
  eq(debtTeamLabel(debtTeamCoverage([])), "No team set", "and the empty case is still named");
}

finish();

// What the deactivate confirm asks, and which answer sweeps (#2124).
//
// Dan, 2026-09-09: "can we add a warning asking if they'd like to sweep? that way
// it's a deliberate choice." The reading is one line, and it is worth its own test
// because the ASYMMETRY is the whole safety argument and nothing else states it:
// only an explicit "move" sweeps, and every other input, including the ones nobody
// thought about, leaves the bookings alone.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-coverage-choice.ts
import { assert, eq, finish } from "./lib/harness.ts";
import {
  COVERAGE_CHOICE_FIELD,
  COVERAGE_CHOICE_LEAVE,
  COVERAGE_CHOICE_MOVE,
  readCoverageChoice,
} from "@/lib/offboarding/coverage-choice";

// The one answer that moves customers' appointments.
assert(readCoverageChoice(COVERAGE_CHOICE_MOVE), "the move choice sweeps");

// Everything else does not, and each of these is a real way the value can arrive
// wrong: the other button, an older form, a renamed field, a bot posting the form
// by hand, a browser that sent nothing. A default of sweeping would let any of
// them move a customer's appointment that nobody asked to move, with nothing on
// screen saying it happened (L72: the stored default must be the safe state, so
// forgetting produces it).
for (const [what, value] of [
  ["the leave choice", COVERAGE_CHOICE_LEAVE],
  ["no field at all", null],
  ["an empty value", ""],
  ["a near miss", "moved"],
  ["a case variant, since the value is compared exactly", "MOVE"],
  ["padding, which no button of ours produces", " move "],
  ["a truthy looking string", "true"],
  ["a truthy looking flag", "1"],
  ["yes", "yes"],
] as const) {
  assert(!readCoverageChoice(value), `${what} does not sweep`);
}

// The field and the values are the strings the buttons actually write. Asserted
// as literals ON PURPOSE: this is a wire contract between a client component and a
// server action, and deriving the expectation from the constant would only prove
// the constant equals itself (L70). If one of these ever has to change, both ends
// change together and this line is what says so.
eq(COVERAGE_CHOICE_FIELD, "coverage", "the field name the buttons post");
eq(COVERAGE_CHOICE_MOVE, "move", "the value that sweeps");
eq(COVERAGE_CHOICE_LEAVE, "leave", "the value that does not");
assert(
  COVERAGE_CHOICE_MOVE !== COVERAGE_CHOICE_LEAVE,
  "and the two answers are distinguishable, or the choice is decoration",
);

finish();

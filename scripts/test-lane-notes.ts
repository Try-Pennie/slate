// Every watched lane says what it is, and quotes the bound it is judged by (#1872).
//
// The Health page rendered nine internal identifiers (`sync`, `selfheal`,
// `hydrate-calendars`) and an age beside each. The age alone says nothing about
// whether it is good: 14 minutes is healthy for `hydrate-calendars` on a 45
// minute bound and stale for `sync` on a 10 minute one, and the page drew both
// exactly the same way.
//
// The descriptions live beside the bounds rather than next to the page, so a
// second set of words cannot drift from the numbers they describe, and tsc
// requires one per lane because both maps are keyed on the same tuple. What tsc
// cannot check is that the sentence quotes the REAL bound, which is the half that
// would silently go wrong the next time a bound is tuned.
// Run: node --experimental-strip-types scripts/test-lane-notes.ts
import {
  LANE_NAMES,
  LANE_NOTES,
  LANE_STALE_BOUNDS_MS,
  cronLanesNote,
  laneNote,
} from "../src/lib/monitor/health.ts";
import { assert, finish } from "./lib/harness.ts";

assert(LANE_NAMES.length === 13, `thirteen watched lanes, the booking pace readings (#4102) the newest (saw ${LANE_NAMES.length})`);

for (const lane of LANE_NAMES) {
  const note = laneNote(lane);
  const minutes = Math.round(LANE_STALE_BOUNDS_MS[lane] / 60_000);

  // Compared case insensitively, because `laneNote` capitalises the first letter
  // of each half on the way out: it is a sentence start there and could be mid
  // sentence in another reader.
  assert(
    note.toLowerCase().includes(LANE_NOTES[lane].does.toLowerCase()),
    `${lane} says what it does`,
  );
  assert(
    note.includes(`late after ${minutes} minutes`),
    `${lane} quotes the bound it is actually judged by (${minutes} minutes)`,
  );
  assert(
    /Every (minute|\d+ minutes)/i.test(note),
    `${lane} says how often it should run, or an age cannot be read`,
  );
  // A description that repeats the identifier explains nothing, which is the
  // shape a placeholder takes when somebody fills the map in a hurry.
  assert(
    !LANE_NOTES[lane].does.includes(lane),
    `${lane}'s description is words rather than the identifier again`,
  );
  assert(
    // Escapes, not literals: the pre push style gate cannot tell a line banning
    // the character from a line using it, and it is right not to try.
    !/[\u2014\u2013]/.test(note) && !/undefined|NaN/.test(note),
    `${lane}'s note is clean copy`,
  );
}

// The pair that made the missing bound concrete, asserted as a pair: these two
// are the same age in the wild and mean opposite things.
assert(
  laneNote("sync").includes("late after 10 minutes") &&
    laneNote("hydrate-calendars").includes("late after 45 minutes"),
  "two lanes at the same age are told apart by their own bounds",
);

// The jobs this page does NOT watch. "All N lanes ran on time" is true and leaves a
// reader no way to know the cron system is bigger than this page.
const covers = cronLanesNote();
assert(covers.includes("13 lanes"), "the count is derived, so it cannot claim twelve of thirteen");
for (const said of [/roster sync/i, /time off/i, /Snowflake/i]) {
  assert(said.test(covers), `names what is NOT covered here: ${said}`);
}
assert(
  /raises its own alert/i.test(covers),
  "and says where those are watched instead, so the absence is not read as a gap",
);

finish();

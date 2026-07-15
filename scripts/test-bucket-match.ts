import { bucketsMatchingAgent, type BucketForMatch } from "../src/lib/availability/bucket-match.ts";
import { assert, finish } from "./lib/harness.ts";

const AGENT = "agent-1";
const attrs = { debt_team: "A", legal_eligible: "Y" };

const buckets: BucketForMatch[] = [
  { code: "manual", criteria: {}, manualMemberIds: ["agent-1"], fallbackUserId: null },        // manual member, no criteria
  { code: "crit", criteria: { debt_team: "A" }, manualMemberIds: [], fallbackUserId: null },    // criteria matches
  { code: "fallback", criteria: { debt_team: "Z" }, manualMemberIds: [], fallbackUserId: "agent-1" }, // fallback
  { code: "nomatch", criteria: { debt_team: "Z" }, manualMemberIds: ["someone-else"], fallbackUserId: "x" }, // none
  { code: "empty", criteria: {}, manualMemberIds: [], fallbackUserId: null },                   // empty criteria, not manual/fallback
];

const got = bucketsMatchingAgent(AGENT, attrs, buckets).sort();
assert(JSON.stringify(got) === JSON.stringify(["crit", "fallback", "manual"]),
  `matches manual + criteria + fallback only, got ${JSON.stringify(got)}`);

// Manual membership wins even when criteria would exclude.
assert(bucketsMatchingAgent(AGENT, {}, [buckets[0]]).length === 1, "manual member with no attributes still matches");
// Empty criteria never matches by criteria alone.
assert(bucketsMatchingAgent(AGENT, attrs, [buckets[4]]).length === 0, "empty-criteria bucket excludes a non-member");
// A different agent doesn't inherit agent-1's matches.
assert(bucketsMatchingAgent("agent-2", attrs, buckets).sort().join(",") === "crit",
  "agent-2 matches only by criteria, not agent-1's manual/fallback");

finish();

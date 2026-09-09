// Backend service as its LABEL, not the stored key (#2120).
//
// The agent page printed `backend_service` exactly as stored, so the panel that
// says what an agent can be routed for read "achieve". That is the machine
// spelling of a vocabulary `BACKEND` has paired with a label all along, and the
// buckets those keys belong to are already named with the labels, so one
// vocabulary had two spellings in one codebase and this panel picked the
// unreadable one. Same defect the debt teams had, in miniature.
//
// The rule that matters is the one the ladder already learned (L113): a stored
// value that is NOT in the vocabulary must be shown AS STORED rather than
// dropped or prettified, so the reader can see it is a data question and not a
// formatting one. `backend_service` is written by the hourly Salesforce sync and
// nothing constrains it to the two keys.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-backend-service-label.ts
import { assert, eq, finish } from "./lib/harness.ts";
import { backendServiceLabel, backendServiceOf } from "@/lib/admin/agent-display";
import { BACKEND } from "@/lib/xbc";

// --- the labels come from the ONE vocabulary, not a second copy ------------

// Derived from BACKEND rather than written out here, so a renamed label cannot
// leave this test agreeing with a table nobody reads (L41).
for (const spec of Object.values(BACKEND)) {
  if (spec.key === null) continue;
  eq(
    backendServiceLabel(spec.key),
    spec.label,
    `labels the stored key ${spec.key} from BACKEND`,
  );
}

// The two that actually reach the column, spelled out so a BACKEND table that
// lost both keys cannot make the loop above vacuous (L98).
eq(backendServiceLabel("achieve"), "Achieve", "achieve reads as Achieve");
eq(backendServiceLabel("beyond"), "Beyond", "beyond reads as Beyond");
assert(
  Object.values(BACKEND).filter((b) => b.key !== null).length === 2,
  "BACKEND still carries exactly the two stored keys the loop above ran on",
);

// Salesforce sends whatever it sends. Case and padding are how the same value
// arrives spelled differently, and matching on the trimmed lowercase form is
// what the ladder does with debt_team.
eq(backendServiceLabel("  Achieve "), "Achieve", "trims and lowercases before matching");

// --- a value outside the vocabulary is shown, not swallowed ----------------

eq(
  backendServiceLabel("wildcat"),
  "wildcat",
  "an unknown value is shown AS STORED, so it reads as a data question",
);
eq(
  backendServiceLabel("  Wildcat  "),
  "Wildcat",
  "an unknown value keeps its own spelling, only the padding goes",
);

// --- absent is absent, and is NOT an unknown value -------------------------

for (const [what, value] of [
  ["undefined", undefined],
  ["null", null],
  ["an empty string", ""],
  ["only spaces", "   "],
] as const) {
  eq(backendServiceLabel(value), null, `${what} is no backend at all, not a chip saying so`);
}

// --- reading the attribute, whichever shape it is stored in ----------------
//
// `debt_team` is an array on most agents and a bare string on a few, and
// `backend_service` is written by the same sync, so this reads both rather than
// dropping every agent with the shape that was not expected.

eq(backendServiceOf({ attributes: { backend_service: "achieve" } }), "Achieve", "a bare string");
eq(
  backendServiceOf({ attributes: { backend_service: ["beyond"] } }),
  "Beyond",
  "a single element array",
);
eq(backendServiceOf({ attributes: {} }), null, "no attribute at all");
eq(backendServiceOf({ attributes: null }), null, "no attributes at all");
eq(backendServiceOf({}), null, "not even an attributes key");
eq(backendServiceOf({ attributes: { backend_service: [] } }), null, "an empty array");

// An agent carrying two backends is a real possibility the store allows, and
// showing only the first would UNDER REPORT them on the panel that exists to say
// what they cover, which is the mistake the ladder's off-ladder chips exist to
// avoid (L113).
eq(
  backendServiceOf({ attributes: { backend_service: ["achieve", "beyond"] } }),
  "Achieve, Beyond",
  "every stored backend, labelled, rather than only the first",
);

finish();

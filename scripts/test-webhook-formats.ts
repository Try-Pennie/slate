// A webhook format is wired on every axis, or it does not build (#1952).
//
// Adding a format was three code edits and a migration, with nothing checking
// any of them against each other:
//
//   the UNION            src/lib/db/types.ts
//   the BUILDER          src/lib/webhooks/wire.ts, an `if` on one value with the
//                        other as the fall through, so an unhandled format sent
//                        GENERIC payloads and nothing reported it
//   the DROPDOWN         an options array written by hand beside the union, so a
//                        format could exist and never be offerable
//   the CHECK CONSTRAINT on webhook_endpoints.format, which no TypeScript can see
//
// The first three are `Record<WebhookFormat, ...>` now, so `tsc` names an
// omission. This guard covers what the compiler cannot: that the database
// accepts exactly the formats the code knows, that the dropdown is derived
// rather than repeated, and that no builder answers for a format it was not
// written for.
//
// Run: node --experimental-strip-types scripts/test-webhook-formats.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";
import {
  WEBHOOK_FORMATS,
  WEBHOOK_FORMAT_OPTIONS,
  WEBHOOK_FORMAT_NOTE,
} from "@/lib/webhooks/formats";

const known = Object.keys(WEBHOOK_FORMATS).sort();
assert(known.length >= 2, `the formats were found to judge (saw ${known.join(", ")})`);

// --- the database accepts exactly these ---------------------------------------
//
// A format the column refuses cannot be saved, and one the column allows but the
// code has no builder for now throws rather than sending the wrong shape. Either
// way the two lists have to be the same list.
const ddl = readFileSync(join("supabase", "migrations", "0001_init.sql"), "utf8");
const check = ddl.match(/format\s+text not null default '\w+'\s+check \(format in \(([^)]*)\)\)/);
assert(check != null, "the format check constraint was found in the migration");
const allowed = (check?.[1] ?? "")
  .split(",")
  .map((v) => v.trim().replace(/^'|'$/g, ""))
  .filter(Boolean)
  .sort();
assert(allowed.length >= 2, `the constraint parser read the allowed values (saw ${allowed.join(", ")})`);
assert(
  JSON.stringify(allowed) === JSON.stringify(known),
  `the column accepts exactly the formats the code knows:\n    database: ${allowed.join(", ")}\n    code:     ${known.join(", ")}`,
);

// --- every format has a builder, and none falls through ----------------------
/**
 * Source with the prose blanked. A comment DESCRIBING the shape that was removed
 * reads identically to the shape itself, so scanning raw source failed this file
 * on its own explanation of the fix (the mirror of L103, where a comment about a
 * thing SATISFIES a check for it).
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => (/^\s*\/\//.test(line) ? "" : line))
    .join("\n");
}

const wire = code(readFileSync(join("src", "lib", "webhooks", "wire.ts"), "utf8"));
assert(
  /FORMAT_BUILDERS: Record<WebhookFormat,/.test(wire),
  "the builders are keyed on the union, so tsc names a format with no builder",
);
// The shape that shipped the silent fall through: a comparison against ONE
// format deciding the whole request.
assert(
  !/if \(endpoint\.format === /.test(wire),
  "no builder is chosen by comparing against a single format, which leaves the rest on a default branch",
);
const missingBuilder = known.filter((f) => !new RegExp(`\\b${f}:`).test(wire));
assert(
  missingBuilder.length === 0,
  `every format is named in the builder map: ${missingBuilder.join(", ")}`,
);
// An unknown format must be REFUSED. Reaching a builder that does not exist
// would throw a TypeError naming nothing a reader could act on.
assert(
  /unknown format/.test(wire),
  "an unrecognised format is refused by name rather than guessed at",
);

// --- the dropdown is derived, and says what each format is -------------------
const page = code(readFileSync(join("src", "app", "admin", "webhooks", "page.tsx"), "utf8"));
assert(
  /options=\{WEBHOOK_FORMAT_OPTIONS\}/.test(page),
  "the Format control's options come from the shared record, not a list beside it",
);
assert(
  !/value: "regal"/.test(page) && !/value: "generic"/.test(page),
  "the page names no format literally, so it cannot go stale against the union",
);
assert(
  JSON.stringify(WEBHOOK_FORMAT_OPTIONS.map((o) => o.value).sort()) === JSON.stringify(known),
  "the options offer every format and nothing else",
);

// Each explanation has to say what the format DOES on the wire. `Generic
// (signed)` was the whole complaint: it named a mechanism nobody could act on.
const thin = Object.entries(WEBHOOK_FORMATS)
  .filter(([, f]) => f.what.trim().length < 60)
  .map(([k]) => k);
assert(thin.length === 0, `each format explains itself: ${thin.join(", ")}`);

// The signing format has to name what the signature covers, since that is the
// reason a subscriber can reject a replayed delivery.
assert(
  /timestamp/i.test(WEBHOOK_FORMATS.generic.what) && /replay/i.test(WEBHOOK_FORMATS.generic.what),
  "the signed format says the signature covers the timestamp, so a replay can be rejected",
);
// The page renders them, rather than leaving them in a module nothing reads.
assert(
  /WEBHOOK_FORMATS\[o\.value\]\.what/.test(page),
  "the page renders each format's explanation beside the control",
);
assert(
  /\{WEBHOOK_FORMAT_NOTE\}/.test(page) && /code change/.test(WEBHOOK_FORMAT_NOTE),
  "the page says the list is closed and that adding one is a code change",
);

// --- the key's state is a marker, not two sentences --------------------------
//
// A saved key and a missing one used to be the same empty input with a grey hint
// under each, so the page looked identical in the state where every delivery is
// failing.
assert(
  /variant="status-error">No key saved/.test(page),
  "a missing Regal key is drawn as the failure it is",
);
assert(
  /variant="status-ok">Key saved/.test(page),
  "a saved key is visible as a state without reading the hint",
);
// The error may only be shown for the format that NEEDS a key. A generic
// endpoint authenticates with the HMAC secret, so a red marker on one would
// accuse a healthy endpoint over a field it does not use (L144: a monitor that
// judges by a different predicate than the action fires exactly when the action
// correctly declined).
assert(
  /webhook\.format !== "regal"/.test(page),
  "the key's state is judged on the saved format, so a generic endpoint is not accused",
);
assert(
  /webhook == null \? null/.test(page),
  "an endpoint that does not exist yet is not reported as one with a missing key",
);

// The key's state is stated ONCE. Before the marker there was a muted "no API
// key set" clause in a summary line above the form, which is the same fact in
// the same grey the healthy case used, and leaving it in place beside the marker
// would have been two captions of one fact.
assert(
  !/no API key set/.test(page) && !/API key stored/.test(page),
  "the key's state is the marker alone, not also a muted clause elsewhere",
);

// #600's rule, still held: the stored key never reaches the page, in any form.
assert(
  !/auth_header\}/.test(page.replace(/webhook\?\.auth_header \?/g, "")),
  "the stored key is never rendered, masked or otherwise",
);

finish();

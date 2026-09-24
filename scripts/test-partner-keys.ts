// The partner join keys have ONE spelling, and one reader (#2659).
//
// A landing page passes `submissionId` and `regalProfileId` on the booking URL,
// `/book` keeps every query param in `prefill`, and from there the two ride into
// the booking row, every webhook and the warehouse. Four readers then look them
// up by name: the Regal event, the API views, the Booker's confirm response and
// the reschedule response. Four hand written lookups of one URL key drift, and
// they drift silently: `submission_id`, `submissionID`, a value never trimmed,
// an empty string sent where the tagging spec says leave the key out. So the
// spelling lives in `PARTNER_KEYS` and the read in `partnerKeysFrom`, and this
// file is the other half of that consolidation (L613): it fails on the next hand
// spelled copy anywhere in the shipped tree.
//
// The literal spelling is pinned HERE, deliberately, and nowhere else in the
// tests: every other suite builds its prefill from the constant, so a renamed
// constant would keep them all green while trypennie's URL stopped matching
// (L70). This is the one place the expected value comes from outside the code.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-partner-keys.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { PARTNER_KEYS, partnerKeysFrom } from "../src/lib/booking/partner-keys.ts";
import {
  handSpelledPartnerKeys,
  isScannedPartnerKeyFile,
  PARTNER_KEYS_MODULE,
} from "./lib/scan-partner-keys.ts";

// --- the spelling trypennie puts on the URL ---------------------------------
eq(PARTNER_KEYS.submissionId, "submissionId", "the submission id key is spelled as trypennie's SlateCalendar passes it");
eq(PARTNER_KEYS.regalProfileId, "regalProfileId", "the Regal profile id key is spelled to match");

// --- the one reader ----------------------------------------------------------
eq(
  partnerKeysFrom({ [PARTNER_KEYS.submissionId]: "a0G5x00000AbCdEQAU", [PARTNER_KEYS.regalProfileId]: "rp_01HZY3" }),
  { submissionId: "a0G5x00000AbCdEQAU", regalProfileId: "rp_01HZY3" },
  "both present: both read back",
);
eq(
  partnerKeysFrom({ utm_source: "google" }),
  { submissionId: null, regalProfileId: null },
  "neither present: null, not undefined, so a view can always carry the field",
);
eq(
  partnerKeysFrom({ [PARTNER_KEYS.submissionId]: "", [PARTNER_KEYS.regalProfileId]: "   " }),
  { submissionId: null, regalProfileId: null },
  "empty and blank read as absent: the spec says leave the key out, never send an empty string",
);
eq(
  partnerKeysFrom({ [PARTNER_KEYS.submissionId]: "  a0G5x00000AbCdEQAU\n" }),
  { submissionId: "a0G5x00000AbCdEQAU", regalProfileId: null },
  "a padded value is trimmed, and the other key stays null",
);
eq(
  partnerKeysFrom({ [PARTNER_KEYS.submissionId]: 42, [PARTNER_KEYS.regalProfileId]: { id: "x" } }),
  { submissionId: null, regalProfileId: null },
  "a stored bag holding something other than a string reads as absent rather than stringifying it",
);
eq(partnerKeysFrom(null), { submissionId: null, regalProfileId: null }, "a null bag reads as absent");
eq(partnerKeysFrom(undefined), { submissionId: null, regalProfileId: null }, "a missing bag reads as absent");
eq(
  partnerKeysFrom({ SubmissionId: "a0G5x00000AbCdEQAU", regalprofileid: "rp_01HZY3" }),
  { submissionId: null, regalProfileId: null },
  "the lookup is case exact: a differently cased key is not this key",
);

// --- the grep guard: no second spelling in the shipped tree -----------------
//
// Positive controls first. A scanner that answered "nothing found" to
// everything would make the sweep below pass while measuring nothing (L1).
const caught = (source: string) => handSpelledPartnerKeys(source).map((f) => f.line);
eq(caught('const id = prefill["submissionId"];'), [1], "a bracket read off the bag by a quoted key is caught");
eq(caught("const id = prefill.submissionId;"), [1], "a dot read off the bag is caught");
eq(caught("const id = b.prefill.regalProfileId ?? null;"), [1], "a dot read through a booking's prefill is caught");
eq(caught('const id = first(sp, "submissionId");'), [1], "a quoted key handed to a query helper is caught");
eq(caught("const id = sp['regalProfileId'];"), [1], "a single quoted key is caught");
eq(caught("const id = sp[`submissionId`];"), [1], "a template quoted key is caught");
eq(caught('const a = 1;\nconst b = x["regalProfileId"];\n'), [2], "the finding names the line it is on");
eq(caught('x["submissionId"]; y["regalProfileId"];'), [1], "one line with two spellings is one finding");

// Negative controls: what the guard must NOT flag, or it fails on the code that
// does it right and gets deleted (L36).
eq(caught("const k = PARTNER_KEYS.submissionId;"), [], "reading the constant is the sanctioned spelling");
eq(caught("const p = partnerKeysFrom(b.prefill); if (p.submissionId) send(p.submissionId);"), [], "a typed read off the reader's result is tsc's to check, not a bag lookup");
eq(caught("interface View { submissionId: string | null; regalProfileId: string | null }"), [], "a typed field name is not a bag lookup");
eq(caught("// the submissionId trypennie passes\nconst x = 1;"), [], "a line comment about the key is not a spelling of it (L103)");
eq(caught('/* prefill["submissionId"] used to be read here */\nconst x = 1;'), [], "a block comment is stripped before matching");
eq(caught('const u = "https://x.test/?a=1"; // prefill.submissionId'), [], "a comment after a URL string is still a comment");
eq(caught('const sub = prefill["submissionIdentifier"];'), [], "a longer key that starts the same is a different key");

// The scanned set: every shipped source file. Tests spell the key on purpose,
// and the module that owns it spells it once.
assert(isScannedPartnerKeyFile("src/lib/webhooks/regal.ts"), "shipped lib code is scanned");
assert(isScannedPartnerKeyFile("src/app/book/page.tsx"), "a page is scanned");
assert(isScannedPartnerKeyFile("public/widget.js"), "the embed script is scanned");
assert(isScannedPartnerKeyFile("worker/index.ts"), "the Worker entry is scanned");
assert(isScannedPartnerKeyFile("scripts/lib/booking-fakes.ts"), "shared test support is scanned, since a fake spelling the key by hand teaches the next writer");
assert(!isScannedPartnerKeyFile("src/lib/webhooks/regal.test.ts"), "a vitest file may spell the key");
assert(!isScannedPartnerKeyFile("src/app/book/page.test.tsx"), "a tsx vitest file may spell the key");
assert(!isScannedPartnerKeyFile("scripts/test-partner-keys.ts"), "a node suite may spell the key");
assert(!isScannedPartnerKeyFile(PARTNER_KEYS_MODULE), "the owning module is the one sanctioned spelling");
assert(!isScannedPartnerKeyFile("docs/booking-api.md"), "documentation names the key for its readers and is out of scope");

// --- the sweep over the real tree --------------------------------------------
const ROOTS = ["src", "public", "worker", "scripts"];
function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
}
const files: string[] = [];
for (const root of ROOTS) walk(root, files);
const scanned = files.filter(isScannedPartnerKeyFile);
assert(scanned.length > 100, `the sweep read a real tree (${scanned.length} files)`);
assert(scanned.includes("src/lib/webhooks/regal.ts"), "the sweep reached the Regal formatter");
assert(scanned.includes("src/lib/booking/orchestration.ts"), "the sweep reached the API views");

const findings: string[] = [];
for (const file of scanned) {
  for (const f of handSpelledPartnerKeys(readFileSync(file, "utf8"))) {
    findings.push(`${file}:${f.line}: ${f.text.trim()}`);
  }
}
for (const f of findings) console.error("   hand spelled partner key:", f);
assert(
  findings.length === 0,
  `no shipped file spells a partner key by hand; read it through partnerKeysFrom (${findings.length} found)`,
);

finish();

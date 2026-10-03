// #3106: the lead landing pages read stored contact details for the Salesforce id in their
// link, and a lead id is not a secret, so those reads go through `landingLookupId`, the
// per address throttle. The gate itself is pinned in landing-identity-gate.test.ts; this
// pins the WIRING (L3): every page that asks about a landing identity asks with the id the
// gate handed back, never with the raw id from the link.
//
// Enumerated from the source tree rather than listed, so a third landing page that calls
// either reader is covered by construction (L96).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-landing-identity-throttle.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { textHasOptOut } from "./lib/opt-out.ts";

const ROOT = join(import.meta.dirname, "..");
const READERS = ["landingAttendee", "existingCallForLanding"];

/** The violations in one file's source: a reader called with anything but the gated id. */
export function ungatedLandingReads(src: string): string[] {
  // A page whose identity did not come from the link (the rebook page reads it off a row
  // found by an unguessable manage token) says so, with a reason that begins with a word.
  if (textHasOptOut(src, "landing-identity-ok:")) return [];
  const out: string[] = [];
  for (const reader of READERS) {
    const re = new RegExp(`\\b${reader}\\(\\s*\\{\\s*salesforceId:\\s*([A-Za-z_$][\\w$]*)`, "g");
    for (const m of src.matchAll(re)) {
      if (m[1] !== "lookupId") out.push(`${reader} is asked about ${m[1]}`);
    }
  }
  if (out.length === 0 && READERS.some((r) => src.includes(`${r}(`))) {
    if (!/\blookupId\s*=\s*await\s+landingLookupId\(/.test(src)) {
      out.push("reads a landing identity without deriving lookupId from landingLookupId");
    }
  }
  return out;
}

function pages(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) found.push(...pages(p));
    else if (/\.(tsx?|jsx?)$/.test(name) && !/\.test\./.test(name)) found.push(p);
  }
  return found;
}

const callers = pages(join(ROOT, "src", "app")).filter((p) => {
  const src = readFileSync(p, "utf8");
  return READERS.some((r) => src.includes(`${r}(`));
});
assert(callers.length >= 2, `found the landing pages that read an identity (${callers.length})`);
for (const p of callers) {
  const bad = ungatedLandingReads(readFileSync(p, "utf8"));
  eq(bad.join("; "), "", `${relative(ROOT, p)} reads a landing identity only through the throttle`);
}

// Positive controls: the raw id is caught, and so is a lookupId that came from anywhere else.
{
  const raw = ungatedLandingReads(
    "const lookupId = await landingLookupId(id, h);\nawait existingCallForLanding({ salesforceId: id }, w);",
  );
  assert(raw.length === 1, "a reader handed the raw id is caught");
  const forged = ungatedLandingReads("const lookupId = id;\nawait landingAttendee({ salesforceId: lookupId }, l, w);");
  assert(forged.length === 1, "a lookupId that did not come from the gate is caught");
  const fine = ungatedLandingReads(
    "const lookupId = await landingLookupId(id, h);\nawait landingAttendee({ salesforceId: lookupId }, l, w);",
  );
  eq(fine.length, 0, "the gated shape passes");
  eq(
    ungatedLandingReads("// landing-identity-ok:\nawait landingAttendee({ salesforceId: id }, l, w);").length,
    1,
    "an escape hatch with no reason does not exempt the file",
  );
}

finish();

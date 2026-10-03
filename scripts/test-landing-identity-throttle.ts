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
import { hasOptOutAtOffset } from "./lib/opt-out.ts";
import { blankComments } from "./lib/strip-comments.ts";

const ROOT = join(import.meta.dirname, "..");
const READERS = ["landingAttendee", "existingCallForLanding"];

/**
 * The violations in one file's source, judged per CALL SITE (L135): each reader call must
 * be asked with `lookupId` derived from `landingLookupId` EARLIER in the file, or carry a
 * reasoned `// landing-identity-ok:` on or directly above its own line. The hatch is for a
 * page whose identity did not come from the link (the rebook page reads it off a row found
 * by an unguessable manage token), and it covers only the call beneath it.
 */
export function ungatedLandingReads(src: string): string[] {
  const code = blankComments(src);
  const out: string[] = [];
  const derived = /\blookupId\s*=\s*await\s+landingLookupId\(/.exec(code);
  for (const reader of READERS) {
    const call = new RegExp(`\\b${reader}\\(`, "g");
    for (const m of code.matchAll(call)) {
      const at = m.index ?? 0;
      if (hasOptOutAtOffset(src, at, "landing-identity-ok:")) continue;
      const arg = /^\(\s*\{\s*salesforceId(?:\s*:\s*([A-Za-z_$][\w$]*))?/.exec(code.slice(at + reader.length));
      const asked = arg ? (arg[1] ?? "salesforceId") : "an identity this scan cannot read";
      const line = code.slice(0, at).split("\n").length;
      if (asked !== "lookupId") out.push(`line ${line}: ${reader} is asked about ${asked}`);
      else if (!derived || derived.index > at) {
        out.push(`line ${line}: ${reader} reads before lookupId is derived from landingLookupId`);
      }
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
  // Per call site (L135): a reasoned hatch covers only the call directly beneath it.
  eq(
    ungatedLandingReads(
      "// landing-identity-ok: read off a row an unguessable token names\n" +
        "await existingCallForLanding({ salesforceId }, w);\n" +
        "const x = 1;\n" +
        "await landingAttendee({ salesforceId: rawId }, l, w);",
    ).length,
    1,
    "a hatch above one call does not exempt a second call further down the file",
  );
  eq(
    ungatedLandingReads(
      "await landingAttendee({ salesforceId: lookupId }, l, w);\n" +
        "const lookupId = await landingLookupId(id, h);",
    ).length,
    1,
    "a lookupId derived only AFTER the call does not gate it",
  );
  eq(
    ungatedLandingReads("await existingCallForLanding({ salesforceId }, w);").length,
    1,
    "the shorthand `{ salesforceId }` is a raw id too",
  );
  eq(
    ungatedLandingReads('const u = "https://x"; await landingAttendee({ salesforceId: rawId }, l, w);').length,
    1,
    "a URL literal does not hide the call after it",
  );
}

finish();

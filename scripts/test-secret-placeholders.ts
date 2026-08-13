/**
 * The files gitleaks is told to ignore hold no real key material (#1042).
 *
 * `.gitleaks.toml` exempts four files by PATH, because each legitimately contains
 * something shaped like a PEM private key: the Snowflake JWT and config tests
 * exercise the PEM parsing, and `.env.example` documents the variable's format.
 * The default rule matches on the PEM "BEGIN PRIVATE KEY" header line, so it
 * cannot tell those apart from the real thing.
 *
 * A path exemption is how an allowlist rots. Once a file is exempt, a real key
 * pasted into it is invisible to the scanner, and the exemption reads to the next
 * person as evidence somebody checked. So the scanner is told to look away and
 * THIS is told to look: every PEM body in an exempted file must be short filler.
 *
 * The measure is length, not a list of known placeholders. An unencrypted PKCS#8
 * RSA key is over 1,600 base64 characters and even a P-256 EC key is over 100, so
 * a body under 40 characters cannot be a usable key whatever it spells. That
 * holds without needing to predict what the next test author types.
 *
 * Run: node --experimental-strip-types scripts/test-secret-placeholders.ts
 */
import { readFileSync } from "node:fs";
import { assert, eq, finish } from "./lib/harness.ts";

/** Kept in step with the `paths` list in .gitleaks.toml by the assertion below,
 *  so exempting a fifth file without checking it fails the build (L41). */
const EXEMPT = [
  ".env.example",
  "scripts/test-snowflake-jwt-cache.ts",
  "src/lib/snowflake/config.test.ts",
  "src/lib/snowflake/client.test.ts",
];

/**
 * The longest a PEM body may be here.
 *
 * Comfortably below any real key (a P-256 EC private key is ~120 base64
 * characters, PKCS#8 RSA is well over 1,600) and comfortably above the filler
 * these files use ("AAAA", "abc", "MII...", an interpolated variable).
 */
const MAX_BODY = 40;

const PEM = /-----BEGIN[ A-Z0-9]*PRIVATE KEY-----([\s\S]*?)-----END[ A-Z0-9]*PRIVATE KEY-----/g;

// The exemption list here and the one gitleaks reads must agree, or this checks a
// file the scanner is still watching while a file it ignores goes unchecked. Read
// from the config rather than trusted to match by hand.
{
  const toml = readFileSync(".gitleaks.toml", "utf8");
  // Scoped to the PEM allowlist block by its description, NOT to every anchored
  // pattern in the file. The build-output block next to it is an exclusion for
  // speed rather than a security exemption, and folding the two together would
  // have this guard silently accept a new path exemption as long as it was added
  // to the other list.
  const block = toml.split("[[allowlists]]").find((b) => b.includes("PEM placeholders"));
  assert(block !== undefined, "the PEM allowlist block is still in .gitleaks.toml");
  const declared = [...(block ?? "").matchAll(/'''\^(.+?)\$'''/g)].map((m) =>
    m[1].replace(/\\\./g, "."),
  );
  eq(
    declared.sort(),
    [...EXEMPT].sort(),
    "the files this guard checks are exactly the files .gitleaks.toml exempts, so neither " +
      "list can grow without the other",
  );
}

let bodiesChecked = 0;
const offenders: string[] = [];

for (const file of EXEMPT) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(PEM)) {
    bodiesChecked++;
    // Whitespace and escaped newlines are formatting, not key material, so they
    // do not count towards the length: a real key wrapped at 64 columns must not
    // squeeze under the limit on the strength of its line breaks.
    const body = m[1].replace(/\\n/g, "").replace(/\s+/g, "");
    if (body.length > MAX_BODY) {
      offenders.push(`${file}: PEM body of ${body.length} characters`);
    }
  }
}

// Finding nothing is not a pass (L98). If the pattern stops matching, or a file is
// renamed, every assertion below clears over nothing at all and the exemption is
// left completely unchecked, which is worse than having no guard because the
// config points at this file as its justification.
assert(
  bodiesChecked > 0,
  `found PEM blocks to check in the exempted files (${bodiesChecked})`,
);

eq(
  offenders,
  [],
  `every PEM body in a gitleaks-exempted file is under ${MAX_BODY} characters, so it cannot ` +
    `be a usable key`,
);

// --- positive control ---------------------------------------------------------
//
// Without this the check passes just as happily with a broken pattern or an
// inverted comparison, which is indistinguishable from a clean repo (L1).
{
  // A realistically sized body, wrapped at 64 columns like a real key, so the
  // whitespace stripping is exercised too rather than assumed.
  //
  // The PEM markers are ASSEMBLED rather than written out, and that is not
  // fussiness: a literal header in this file makes gitleaks flag this very file,
  // and the only ways out of that are exempting the guard that checks the
  // exemptions, or weakening the rule. Building the string keeps the control
  // honest and leaves nothing for the scanner to catch (the same trick the repo
  // uses for the forbidden dash characters).
  const BEGIN = `-----BEGIN PRIVATE${" KEY-----"}`;
  const END = `-----END PRIVATE${" KEY-----"}`;
  const line = "M".repeat(64);
  const fake = `${BEGIN}\n${line}\n${line}\n${END}`;
  const found = [...fake.matchAll(PEM)].map((m) =>
    m[1].replace(/\\n/g, "").replace(/\s+/g, ""),
  );
  eq(found.length, 1, "the scanner still recognises a PEM block");
  assert(
    (found[0]?.length ?? 0) > MAX_BODY,
    "a real sized key IS caught, including one wrapped across lines",
  );
  // And the inverse, so the length test cannot be satisfied by flagging everything.
  const placeholder = [...`${BEGIN}\\nabc\\n${END}`.matchAll(PEM)].map((m) =>
    m[1].replace(/\\n/g, "").replace(/\s+/g, ""),
  );
  assert((placeholder[0]?.length ?? 99) <= MAX_BODY, "a filler placeholder is NOT caught");
}

finish();

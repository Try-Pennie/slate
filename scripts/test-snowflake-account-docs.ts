// #1200: the account identifier the runbooks tell an operator to set must be the
// one production actually runs on.
//
// Snowflake accepts two different identifiers for the same account: the
// `orgname-accountname` form and the older `locator.region` form. Slate runs on
// `vrkfjso-rwc54963` (orgname-accountname), but THREE places gave the other form
// as the worked example: DEPLOY.md's 2c bullet, the comment sitting directly
// above the correct value in wrangler.jsonc, and docs/snowflake-setup.md, whose
// step 4 query returned three separate columns while step 5 attributed the value
// to a fourth source (`SYSTEM$ALLOWLIST()`).
//
// Nothing was broken in production, which is exactly why it survived: the live
// value is right and only the instructions for reproducing it were wrong. It
// would have cost its hour during a rebuild-from-scratch deploy, with an account
// that cannot authenticate and a JWT that looks perfectly well-formed.
//
// The claim is DERIVED from wrangler.jsonc (L41), so changing the deployed
// account forces the docs to follow rather than leaving them pinned to a stale
// literal.
// Run: node --experimental-strip-types scripts/test-snowflake-account-docs.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const root = join(import.meta.dirname, "..");

/** The deployed value: the source of truth every doc has to agree with. */
function deployedAccount(): string | null {
  const jsonc = readFileSync(join(root, "wrangler.jsonc"), "utf8");
  return /"SNOWFLAKE_ACCOUNT"\s*:\s*"([^"]*)"/.exec(jsonc)?.[1] ?? null;
}

const account = deployedAccount();
assert(
  account !== null && account.length > 0,
  "read SNOWFLAKE_ACCOUNT out of wrangler.jsonc (the deployed value)",
);
if (!account) finish();

// Every doc that tells an operator what to set must show the real value.
const DOCS = ["DEPLOY.md", "docs/snowflake-setup.md"];
for (const rel of DOCS) {
  const doc = readFileSync(join(root, rel), "utf8");
  assert(
    doc.includes(account),
    `${rel} gives the deployed SNOWFLAKE_ACCOUNT (${account}) as its worked example`,
  );
}

// The retired example must not reappear as the thing to SET. It may still be
// named while explaining why it is wrong, which is how the docs currently read,
// so a mention is judged against the PARAGRAPH around it rather than its own
// line: prose wraps wherever the line length lands, so a per-line check would
// fail on a warning that happens to break across two lines while a genuinely
// unwarned mention on one long line would pass. Without this distinction the
// guard would also forbid the docs from explaining the trap at all.
const RETIRED = "ab12345.us-east-1";
const WARNS = /\bnot\b|instead|used to|retired|older|different identifier|cannot/i;

for (const rel of [...DOCS, "wrangler.jsonc"]) {
  const doc = readFileSync(join(root, rel), "utf8");
  for (const para of doc.split(/\n\s*\n/)) {
    if (!para.includes(RETIRED)) continue;
    assert(
      WARNS.test(para),
      `${rel} mentions the retired ${RETIRED} form only to warn against it, never as the ` +
        `value to set: ${para.trim().replace(/\s+/g, " ").slice(0, 120)}`,
    );
  }
}

// Step 4's query has to BUILD the identifier, not leave the operator to assemble
// one from parts. The original returned organization, account and region as
// three separate columns, which is what let step 5 describe a different value
// without the mismatch being visible.
const setup = readFileSync(join(root, "docs", "snowflake-setup.md"), "utf8");
const accountQuery = setup
  .split("\n")
  .find((l) => /CURRENT_ORGANIZATION_NAME\s*\(/i.test(l));
assert(accountQuery !== undefined, "docs/snowflake-setup.md step 4 still has an account query");
assert(
  /\|\|/.test(accountQuery ?? "") && /CURRENT_ACCOUNT_NAME/i.test(accountQuery ?? ""),
  "step 4's query concatenates organization and account into the single value the Worker " +
    `needs, rather than returning parts to assemble by hand: ${(accountQuery ?? "").trim()}`,
);
assert(
  !/CURRENT_REGION/i.test(accountQuery ?? ""),
  "step 4's query does not return CURRENT_REGION, which belongs to the retired locator form " +
    "and reads as a component of the value when it is not one",
);

// Positive controls: each check must be able to fail.
assert(
  !WARNS.test("Set SNOWFLAKE_ACCOUNT to the account prefix, e.g. ab12345.us-east-1"),
  "positive control: a paragraph presenting the retired form as the value, with no warning, is caught",
);
assert(
  WARNS.test("The locator form ab12345.us-east-1 is a\ndifferent identifier and is not what we use."),
  "positive control: a warning that wraps across two lines still counts, so prose reflow does not fail the build",
);
assert(
  /"SNOWFLAKE_ACCOUNT"\s*:\s*"([^"]*)"/.exec('"SNOWFLAKE_ACCOUNT": "changed-value"')?.[1] ===
    "changed-value",
  "positive control: the wrangler.jsonc parse follows a changed account rather than a fixed literal",
);
assert(
  !/\|\|/.test("SELECT CURRENT_ORGANIZATION_NAME(), CURRENT_ACCOUNT_NAME(), CURRENT_REGION();"),
  "positive control: the original three-column step 4 query would fail the concatenation check",
);

finish();

// #3543 / #3544: Marcia's lead token, checked against the ONE committed fixture set.
//
//   - the committed `machine-token-fixtures.json` is exactly what the cases build, so
//     the contract Marcia's signer is held to cannot drift from what Slate checks (L26);
//   - Slate's verifier answers every case's `expect`, the MCP Worker's secretless
//     parser every case's `shapeExpect`, and the two agree wherever the signature is
//     not the question (one rule set, L19);
//   - a correctly signed token WITHOUT the test claim is refused by name (L688);
//   - a foreign key and an unsigned token are refused (#3544);
//   - no configured key refuses everything, and the public fixture key is never a key.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-machine-token.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildFixtureFile, FIXTURE_CLAIMS, FIXTURE_VERIFY_AT_MS, type FixtureFile } from "./lib/machine-token-fixture-cases.ts";
import {
  FIXTURE_TOKEN_KEY,
  signMachineToken,
  usableTokenKeys,
  verifyMachineToken,
} from "../src/lib/mcp-booking/machine-token.ts";
import { MACHINE_TOKEN_CLAIMS, MACHINE_TOKEN_OPTIONAL_CLAIMS, parseMachineTokenShape } from "../src/lib/mcp-booking/token-shape.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const committed = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/lib/mcp-booking/machine-token-fixtures.json", import.meta.url)), "utf8"),
) as FixtureFile;

// --- the committed file is the cases --------------------------------------------
{
  const built = await buildFixtureFile();
  eq(JSON.stringify(committed), JSON.stringify(built), "the committed fixtures are exactly what the cases build (run pnpm build:machine-token-fixtures)");
  assert(committed.cases.length >= 15 + MACHINE_TOKEN_CLAIMS.length, `every case is there (${committed.cases.length})`);
}

// --- the secret scanner's exemption is exactly this file, and this is its check ----
// gitleaks reads every token in the fixture file as a leaked JWT, so .gitleaks.toml
// exempts it by path (Dan, 2026-10-17). A path exemption hides a real token pasted
// in later, so the scanner is told to look away from ONE file and this suite is what
// looks: the assertion above holds the file to exactly what the cases build from the
// public fixture key. The block must name that file and nothing else, or a second
// exemption could ride on this one's check.
{
  const toml = readFileSync(fileURLToPath(new URL("../.gitleaks.toml", import.meta.url)), "utf8");
  // By its description line: the comment introducing a block sits in the chunk BEFORE
  // the `[[allowlists]]` that opens it, so matching on free text finds the wrong one.
  const block = toml.split("[[allowlists]]").find((b) => b.includes('description = "Marcia token fixtures'));
  assert(block !== undefined, "the Marcia token fixture exemption is in .gitleaks.toml");
  const paths = [...(block ?? "").matchAll(/'''\^(.+?)\$'''/g)].map((m) => m[1].replace(/\\\./g, "."));
  eq(paths, ["src/lib/mcp-booking/machine-token-fixtures.json"], "it exempts exactly the generated fixture file");
  assert(FIXTURE_TOKEN_KEY.includes("PUBLIC-never-a-real-key"), "and the key those tokens are signed with says it is public");
}

// --- every case, both readers -----------------------------------------------------
for (const c of committed.cases) {
  const v = await verifyMachineToken(c.token, [committed.key], committed.verifyAtMs);
  const got = v.ok ? "ok" : v.refusal.code;
  eq(got, c.expect, `verifier: ${c.name}`);
  if (!v.ok && c.claim) eq("claim" in v.refusal ? v.refusal.claim : null, c.claim, `verifier names the claim: ${c.name}`);
  const s = parseMachineTokenShape(c.token, committed.verifyAtMs);
  eq(s.ok ? "ok" : s.refusal.code, c.shapeExpect, `shape parser: ${c.name}`);
  // The two readers can only differ on the signature, which the parser cannot see.
  if (c.expect !== "token_signature_invalid") eq(c.shapeExpect, c.expect, `parser and verifier agree: ${c.name}`);
}

// --- the good token carries the claims, typed ---------------------------------------
{
  const good = committed.cases.find((c) => c.name === "good");
  const v = await verifyMachineToken(good?.token, [committed.key], FIXTURE_VERIFY_AT_MS);
  assert(v.ok && v.claims.salesforce_id === FIXTURE_CLAIMS.salesforce_id && v.claims.test === false, "the good token verifies to its claims, test false");
  const flagged = committed.cases.find((c) => c.name === "good, test flagged");
  const f = await verifyMachineToken(flagged?.token, [committed.key], FIXTURE_VERIFY_AT_MS);
  assert(f.ok && f.claims.test === true, "the test flag comes through as the boolean true");
}

// --- the plan's named test: correctly signed, no test claim -------------------------
{
  const { test: _t, ...noTest } = FIXTURE_CLAIMS;
  const token = await signMachineToken(noTest, FIXTURE_TOKEN_KEY);
  const v = await verifyMachineToken(token, [FIXTURE_TOKEN_KEY], FIXTURE_VERIFY_AT_MS);
  eq(v.ok ? null : v.refusal, { code: "token_claim_missing", claim: "test" }, "a correctly signed token without the test claim is refused, naming the claim");
}

// --- which claims are required (Dan, 2026-10-20) --------------------------------------
{
  // Regal may not hold the lead's name, email, phone or zone, so those four are
  // optional; the lead id, the bucket and the protocol claims are not.
  eq(
    MACHINE_TOKEN_CLAIMS.filter((c) => !(MACHINE_TOKEN_OPTIONAL_CLAIMS as readonly string[]).includes(c)),
    ["iss", "aud", "iat", "exp", "nonce", "salesforce_id", "bucket_code", "test"],
    "exactly these claims are required",
  );
  eq([...MACHINE_TOKEN_OPTIONAL_CLAIMS].sort(), ["email", "name", "phone", "time_zone"], "and exactly these four may be absent");

  // Absent, null and empty all reach the operations as ABSENT, never as "", so no
  // reader books an empty string as an address or judges times in a zone named "".
  const { name: _n, email: _e, phone: _p, time_zone: _z, ...bare } = FIXTURE_CLAIMS;
  const signedBare = await verifyMachineToken(await signMachineToken(bare, FIXTURE_TOKEN_KEY), [FIXTURE_TOKEN_KEY], FIXTURE_VERIFY_AT_MS);
  assert(signedBare.ok, "a token carrying none of the four verifies");
  const signedEmpty = await verifyMachineToken(
    await signMachineToken({ ...FIXTURE_CLAIMS, name: "", email: "", phone: null, time_zone: "" }, FIXTURE_TOKEN_KEY),
    [FIXTURE_TOKEN_KEY],
    FIXTURE_VERIFY_AT_MS,
  );
  assert(signedEmpty.ok, "a token carrying the four empty or null verifies");
  for (const v of [signedBare, signedEmpty]) {
    if (!v.ok) continue;
    eq(
      MACHINE_TOKEN_OPTIONAL_CLAIMS.map((c) => (c in v.claims ? c : null)).filter(Boolean),
      [],
      "an absent or empty optional claim is not in the verified claims at all",
    );
    eq(v.claims.salesforce_id, FIXTURE_CLAIMS.salesforce_id, "and the required ones come through untouched");
  }
  // The required ones stay required even beside the relaxed four.
  const { bucket_code: _b, ...noBucket } = bare;
  const nb = await verifyMachineToken(await signMachineToken(noBucket, FIXTURE_TOKEN_KEY), [FIXTURE_TOKEN_KEY], FIXTURE_VERIFY_AT_MS);
  eq(nb.ok ? null : nb.refusal, { code: "token_claim_missing", claim: "bucket_code" }, "a token without a bucket is still refused by name");
  const { test: _t2, ...bareNoTest } = bare;
  const nt = parseMachineTokenShape(await signMachineToken(bareNoTest, FIXTURE_TOKEN_KEY), FIXTURE_VERIFY_AT_MS);
  eq(nt.ok ? null : nt.refusal, { code: "token_claim_missing", claim: "test" }, "and so is one without the test flag, by the shape parser the MCP Worker runs too");
}

// --- rotation: either slot verifies, a foreign key does not -------------------------
{
  // Long enough to be accepted as a key, and spelled so no scanner reads them as one:
  // "key-" followed by hex is a Mailgun key to semgrep's secret rules.
  const a = "rotation-slot-a-fixture-only-aaaaaaaaaaaaaaaaaaaa";
  const b = "rotation-slot-b-fixture-only-bbbbbbbbbbbbbbbbbbbb";
  const signedB = await signMachineToken({ ...FIXTURE_CLAIMS }, b);
  assert((await verifyMachineToken(signedB, [a, b], FIXTURE_VERIFY_AT_MS)).ok, "a token signed with slot B verifies while slot A is also set");
  const v = await verifyMachineToken(signedB, [a], FIXTURE_VERIFY_AT_MS);
  eq(v.ok ? "ok" : v.refusal.code, "token_signature_invalid", "once slot B is emptied, a token signed with it is refused");
  const none = await verifyMachineToken(signedB, [], FIXTURE_VERIFY_AT_MS);
  eq(none.ok ? "ok" : none.refusal.code, "token_keys_unconfigured", "no key configured refuses every token, never accepts it");
}

// --- the key loader -----------------------------------------------------------------
{
  const real = "a-real-looking-key-abcdefghijklmnopqrstuvwxyz012";
  eq(usableTokenKeys([real, ""]).keys, [real], "a blank slot is not a key");
  eq(usableTokenKeys(["short-key", undefined]).keys, [], "a key under 32 characters is not a key");
  const fixture = usableTokenKeys([FIXTURE_TOKEN_KEY, real]);
  eq(fixture.keys, [real], "the public fixture key is never a key in a deployment");
  eq(fixture.fixtureKeyConfigured, true, "and its presence is reported, so somebody is told it was pasted in");
}

finish();

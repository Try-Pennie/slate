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
import { MACHINE_TOKEN_CLAIMS, parseMachineTokenShape } from "../src/lib/mcp-booking/token-shape.ts";
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

// --- rotation: either slot verifies, a foreign key does not -------------------------
{
  const a = "slot-a-key-0000000000000000000000000000000000";
  const b = "slot-b-key-1111111111111111111111111111111111";
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

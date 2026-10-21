// #3543: the cases `src/lib/mcp-booking/machine-token-fixtures.json` is built from.
//
// The JSON is the contract (L26): Slate's verifier, the MCP Worker's secretless
// shape parser and Marcia's signer are each held to it. This module is the one place
// the cases are written, and `scripts/build-machine-token-fixtures.ts` writes the
// file from it; `scripts/test-machine-token.ts` rebuilds it in memory and fails when
// the committed file differs, so the file cannot drift from the cases.
//
// Every value is invented. The lead is nobody, the key is public on purpose and the
// verifier refuses it in any real deployment (`usableTokenKeys`).
import { FIXTURE_TOKEN_KEY, signMachineToken } from "../../src/lib/mcp-booking/machine-token.ts";
import {
  bytesToBase64Url,
  MACHINE_TOKEN_CLAIMS,
  MACHINE_TOKEN_OPTIONAL_CLAIMS,
  type MachineTokenClaim,
  type MachineTokenCode,
} from "../../src/lib/mcp-booking/token-shape.ts";

/** The instant every case is judged at, inside the good token's life. */
export const FIXTURE_IAT = 1_790_000_000;
export const FIXTURE_VERIFY_AT_MS = (FIXTURE_IAT + 60) * 1000;

export const FIXTURE_CLAIMS = {
  iss: "marcia",
  aud: "slate-booking",
  iat: FIXTURE_IAT,
  exp: FIXTURE_IAT + 600,
  nonce: "fixture-attempt-0000000001",
  salesforce_id: "00Q000000000000AAA",
  bucket_code: "411",
  name: "Fixture Lead",
  email: "fixture.lead@example.com",
  phone: "+15555550100",
  time_zone: "America/Chicago",
  test: false,
} as const;

export interface FixtureCase {
  name: string;
  token: string;
  /** "ok", or the refusal code both the verifier and (unless noted) the parser give. */
  expect: "ok" | MachineTokenCode;
  claim?: MachineTokenClaim;
  /** The secretless parser cannot see a signature, so for these it answers "ok". */
  shapeExpect: "ok" | MachineTokenCode;
}

export interface FixtureFile {
  note: string;
  key: string;
  verifyAtMs: number;
  claims: typeof FIXTURE_CLAIMS;
  cases: FixtureCase[];
}

const b64json = (o: unknown): string => bytesToBase64Url(new TextEncoder().encode(JSON.stringify(o)));

const without =(claim: MachineTokenClaim): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...FIXTURE_CLAIMS };
  delete out[claim];
  return out;
};

export async function buildFixtureFile(): Promise<FixtureFile> {
  const sign = (payload: Record<string, unknown>, key = FIXTURE_TOKEN_KEY, header?: Record<string, unknown>) =>
    signMachineToken(payload, key, header);
  const good = await sign({ ...FIXTURE_CLAIMS });
  const [h, p] = good.split(".");
  const cases: FixtureCase[] = [
    { name: "good", token: good, expect: "ok", shapeExpect: "ok" },
    { name: "good, test flagged", token: await sign({ ...FIXTURE_CLAIMS, test: true }), expect: "ok", shapeExpect: "ok" },
    { name: "expired", token: await sign({ ...FIXTURE_CLAIMS, iat: FIXTURE_IAT - 900, exp: FIXTURE_IAT }), expect: "token_expired", shapeExpect: "token_expired" },
    { name: "issued in the future", token: await sign({ ...FIXTURE_CLAIMS, iat: FIXTURE_IAT + 600, exp: FIXTURE_IAT + 900 }), expect: "token_not_yet_valid", shapeExpect: "token_not_yet_valid" },
    { name: "lives longer than 15 minutes", token: await sign({ ...FIXTURE_CLAIMS, exp: FIXTURE_IAT + 901 }), expect: "token_life_too_long", shapeExpect: "token_life_too_long" },
    { name: "signed with a foreign key", token: await sign({ ...FIXTURE_CLAIMS }, "a-foreign-key-that-is-not-slates-at-all-000000"), expect: "token_signature_invalid", shapeExpect: "ok" },
    // The bucket moved after signing, keeping the old signature: the forgery a
    // leaked token invites, and the one only the key can catch.
    { name: "payload edited after signing", token: `${h}.${b64json({ ...FIXTURE_CLAIMS, bucket_code: "999" })}.${good.split(".")[2]}`, expect: "token_signature_invalid", shapeExpect: "ok" },
    { name: "test as the string true", token: await sign({ ...FIXTURE_CLAIMS, test: "true" }), expect: "token_claim_invalid", claim: "test", shapeExpect: "token_claim_invalid" },
    { name: "a Contact id, not a Lead id", token: await sign({ ...FIXTURE_CLAIMS, salesforce_id: "003000000000000AAA" }), expect: "token_claim_invalid", claim: "salesforce_id", shapeExpect: "token_claim_invalid" },
    { name: "an unknown time zone", token: await sign({ ...FIXTURE_CLAIMS, time_zone: "Mars/Olympus" }), expect: "token_claim_invalid", claim: "time_zone", shapeExpect: "token_claim_invalid" },
    { name: "signed for another audience", token: await sign({ ...FIXTURE_CLAIMS, aud: "bidspoke" }), expect: "token_claim_invalid", claim: "aud", shapeExpect: "token_claim_invalid" },
    { name: "alg none", token: `${(await sign({ ...FIXTURE_CLAIMS }, FIXTURE_TOKEN_KEY, { alg: "none" })).split(".").slice(0, 2).join(".")}.AA`, expect: "token_unsupported_alg", shapeExpect: "token_unsupported_alg" },
    { name: "two segments", token: `${h}.${p}`, expect: "token_malformed", shapeExpect: "token_malformed" },
    { name: "not base64url", token: `${h}.${p}.not*base64`, expect: "token_malformed", shapeExpect: "token_malformed" },
    { name: "empty", token: "", expect: "token_malformed", shapeExpect: "token_malformed" },
  ];
  const optional: ReadonlySet<MachineTokenClaim> = new Set(MACHINE_TOKEN_OPTIONAL_CLAIMS);
  for (const claim of MACHINE_TOKEN_CLAIMS) {
    if (optional.has(claim)) {
      // Regal, which feeds Marcia, may not hold the lead's contact details or zone
      // (Dan, 2026-10-20), so a token without one, or with it empty, still verifies.
      cases.push({ name: `missing ${claim}`, token: await sign(without(claim)), expect: "ok", shapeExpect: "ok" });
      cases.push({ name: `empty ${claim}`, token: await sign({ ...FIXTURE_CLAIMS, [claim]: "" }), expect: "ok", shapeExpect: "ok" });
    } else {
      cases.push({ name: `missing ${claim}`, token: await sign(without(claim)), expect: "token_claim_missing", claim, shapeExpect: "token_claim_missing" });
    }
  }
  // Present and not empty, an optional claim is held to the rule it always had: a
  // signer sending a broken value is told which one, never quietly booked without
  // it. The unknown time zone case above is the fourth.
  const malformed: [MachineTokenClaim, unknown, string][] = [
    ["name", "   ", "a name of only spaces"],
    ["email", "not an email address", "an email with no @"],
    ["phone", 15555550100, "a phone sent as a number"],
  ];
  for (const [claim, value, what] of malformed) {
    cases.push({ name: what, token: await sign({ ...FIXTURE_CLAIMS, [claim]: value }), expect: "token_claim_invalid", claim, shapeExpect: "token_claim_invalid" });
  }
  return {
    note:
      "Generated by scripts/build-machine-token-fixtures.ts from scripts/lib/machine-token-fixture-cases.ts; do not edit. " +
      "The contract for Marcia's lead token (Try-Pennie/slate#3543): a signer is correct when it signs `claims` with `key` " +
      "into exactly the `good` token, and the verifier answers `expect` for every case at `verifyAtMs`. The key is public " +
      "and Slate refuses it in any real deployment.",
    key: FIXTURE_TOKEN_KEY,
    verifyAtMs: FIXTURE_VERIFY_AT_MS,
    claims: FIXTURE_CLAIMS,
    cases,
  };
}

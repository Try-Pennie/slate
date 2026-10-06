// The public test bucket's pass and origin gate (#2666).
//
// Every way the gate can refuse is PRODUCED here, not merely named (L151), and
// each is checked in both directions: the good pass is accepted in the same
// fixture that refuses the bad one, so a verifier hard wired to "no" fails too
// (L1, L159).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-embed-test-pass.ts
import { readFileSync } from "node:fs";
import {
  PASS_REFUSALS,
  TEST_ORIGIN_REFUSALS,
  TEST_PASS_TTL_MS,
  judgeTestOrigin,
  mintTestPass,
  testOriginRefusalSentence,
  testPassForBucket,
  testPassRefusal,
  verifyTestPass,
} from "../src/lib/embed/test-pass.ts";
import {
  TEST_PASS_HEADER,
  TEST_PASS_REFUSAL_CODES,
  testPassHeaders,
  testPassRefusalSentence,
} from "../src/lib/embed/test-pass-header.ts";
import {
  DEMO_BUCKET_CODE,
  HIDDEN_TEST_BUCKET_CODES,
  PUBLIC_TEST_BUCKET_CODES,
} from "../src/lib/embed/public-test-bucket.ts";
import { TEST_ACCESS_COPY } from "../src/lib/booking/booker-copy.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const CODE = PUBLIC_TEST_BUCKET_CODES[0];
const SECRET = "a".repeat(64);
const NOW = Date.UTC(2026, 8, 25, 15, 0, 0);

// --- mint and verify ---------------------------------------------------------------
{
  const pass = mintTestPass({ code: CODE, secret: SECRET, nowMs: NOW });
  eq(pass.expiresAtMs, NOW + TEST_PASS_TTL_MS, "a pass expires one TTL after it was made");
  assert(!pass.value.includes(SECRET), "the pass never carries the secret");
  eq(verifyTestPass({ pass: pass.value, code: CODE, secret: SECRET, nowMs: NOW }), { ok: true }, "a fresh pass for the public code verifies");
  eq(
    verifyTestPass({ pass: pass.value, code: CODE, secret: SECRET, nowMs: NOW + TEST_PASS_TTL_MS - 1 }),
    { ok: true },
    "a pass verifies up to the last millisecond of its life",
  );

  const refusal = (p: string | null, over: Partial<{ code: string; secret: string; nowMs: number }> = {}) => {
    const r = verifyTestPass({ pass: p, code: CODE, secret: SECRET, nowMs: NOW, ...over });
    return r.ok ? "ok" : r.reason;
  };
  eq(refusal(pass.value, { nowMs: NOW + TEST_PASS_TTL_MS }), "expired", "a pass at its expiry is refused as EXPIRED");
  eq(refusal(pass.value, { nowMs: NOW + 3 * TEST_PASS_TTL_MS }), "expired", "a long dead pass is refused as expired");
  eq(refusal(pass.value, { code: HIDDEN_TEST_BUCKET_CODES[0] }), "wrong-code", "a pass for the public code presented with the canary's code is refused");
  eq(refusal(pass.value, { code: "100" }), "wrong-code", "a pass for the public code can never authorise a real bucket");
  eq(refusal(pass.value, { secret: "b".repeat(64) }), "forged", "a pass signed with a different secret is refused");
  eq(refusal(pass.value, { secret: "" }), "secret-unset", "with no secret nothing verifies, the good pass included");
  eq(refusal(null), "missing", "no pass is refused as missing");
  eq(refusal(""), "missing", "an empty header is refused as missing");
  eq(refusal("not-a-pass"), "malformed", "a value with no pass shape is refused as malformed");

  // Tampering: move the expiry out by an hour and keep the signature.
  const [c, exp, sig] = pass.value.split(".");
  eq(refusal(`${c}.${Number(exp) + 3_600_000}.${sig}`, { nowMs: NOW + TEST_PASS_TTL_MS + 1 }), "forged", "an extended expiry with the old signature is refused as forged, never as fresh");
  eq(refusal(`${HIDDEN_TEST_BUCKET_CODES[0]}.${exp}.${sig}`, { code: HIDDEN_TEST_BUCKET_CODES[0] }), "forged", "a pass relabelled for the canary's code is refused");
  eq(refusal(`${c}.${exp}.${sig.slice(0, -2)}`), "forged", "a truncated signature is refused");
  eq(refusal(`${c}.${exp}.${sig}x`), "malformed", "a signature that is not hex is refused");

  // Two passes minted at different moments differ, so one cannot stand for another.
  const later = mintTestPass({ code: CODE, secret: SECRET, nowMs: NOW + 1000 });
  assert(later.value !== pass.value, "passes minted at different moments differ");

  // Every declared refusal was produced above.
  const produced = new Set(["expired", "wrong-code", "forged", "secret-unset", "missing", "malformed"]);
  for (const r of PASS_REFUSALS) assert(produced.has(r), `the refusal ${r} is produced by a case above`);
}

// --- the route's answer to each refusal ------------------------------------------------
{
  const expired = testPassRefusal("expired");
  eq(expired.status, 403, "an expired pass is refused with 403");
  eq(expired.body, { error: TEST_ACCESS_COPY.passExpired, code: TEST_PASS_REFUSAL_CODES.expired }, "an expired pass carries its own code and sentence");
  eq(testPassRefusal("secret-unset").body.code, TEST_PASS_REFUSAL_CODES.off, "a missing secret carries its own code");
  eq(testPassRefusal("secret-unset").body.error, TEST_ACCESS_COPY.passOff, "a missing secret carries its own sentence");
  for (const r of ["missing", "malformed", "forged", "wrong-code"] as const) {
    eq(testPassRefusal(r).body, { error: TEST_ACCESS_COPY.passRefused, code: TEST_PASS_REFUSAL_CODES.refused }, `${r} is one refusal to the tester`);
  }
  const sentences = new Set(Object.values(TEST_PASS_REFUSAL_CODES).map((code) => {
    const reason = PASS_REFUSALS.find((r) => testPassRefusal(r).body.code === code);
    return reason ? testPassRefusal(reason).body.error : "";
  }));
  eq(sentences.size, 3, "the three codes carry three different sentences");
}

// --- the client half: sending and reading ------------------------------------------------
{
  eq(testPassHeaders("p1"), { [TEST_PASS_HEADER]: "p1" }, "a pass is sent under the one header name");
  eq(testPassHeaders(null), undefined, "no pass sends no header at all");
  eq(testPassHeaders(""), undefined, "an empty pass sends no header");
  eq(testPassRefusalSentence(testPassRefusal("expired").body), TEST_ACCESS_COPY.passExpired, "the client reads the expired sentence back");
  eq(testPassRefusalSentence({ error: "Unknown bucket" }), null, "an ordinary failure is not read as a pass refusal");
  eq(testPassRefusalSentence({ error: "x", code: "UNKNOWN_BUCKET" }), null, "another coded refusal is not a pass refusal");
  eq(testPassRefusalSentence(null), null, "no body is not a pass refusal");
}

// --- the origin gate -------------------------------------------------------------------
{
  const APPROVED = ["https://dev.example.com", "https://example.com"];
  const judge = (referer: string | null, over: Partial<{ approvedOrigins: string[]; secret: string; code: string }> = {}) =>
    judgeTestOrigin({ code: CODE, referer, approvedOrigins: APPROVED, secret: SECRET, ...over });

  eq(judge("https://dev.example.com/"), { allow: true, origin: "https://dev.example.com" }, "an approved origin is allowed");
  eq(judge("https://example.com/landing/offers?x=1"), { allow: true, origin: "https://example.com" }, "a full URL on an approved origin is judged by its origin");
  eq(judge(null), { allow: false, reason: "no-referer", origin: null }, "no referer is refused");
  eq(judge(""), { allow: false, reason: "no-referer", origin: null }, "an empty referer is refused as no referer");
  eq(judge("not a url"), { allow: false, reason: "no-referer", origin: null }, "an unreadable referer is refused as no referer");
  eq(judge("https://evil.example.net/"), { allow: false, reason: "unlisted-origin", origin: "https://evil.example.net" }, "an unlisted origin is refused and named");
  eq(judge("http://example.com/"), { allow: false, reason: "unlisted-origin", origin: "http://example.com" }, "the scheme is part of the match");
  eq(judge("https://example.com:8443/"), { allow: false, reason: "unlisted-origin", origin: "https://example.com:8443" }, "the port is part of the match");
  eq(judge("https://sub.example.com/"), { allow: false, reason: "unlisted-origin", origin: "https://sub.example.com" }, "a subdomain is not its parent");
  eq(judge("https://example.com.evil.net/"), { allow: false, reason: "unlisted-origin", origin: "https://example.com.evil.net" }, "a suffix trick is not a match");
  eq(judge("https://example.com/", { approvedOrigins: [] }), { allow: false, reason: "list-empty", origin: "https://example.com" }, "an empty list turns the path off");
  eq(judge("https://example.com/", { secret: "" }), { allow: false, reason: "secret-unset", origin: "https://example.com" }, "no secret turns the path off, even for an approved origin");

  // #3424: the demo bucket opens from Slate's own /demo page and from no host page,
  // however approved. Judged first, so the sentence is about the link rather than
  // the website, and in the same fixture where the partner code IS allowed (L159).
  eq(
    judge("https://example.com/", { code: DEMO_BUCKET_CODE }),
    { allow: false, reason: "demo-page-only", origin: "https://example.com" },
    "the demo bucket is refused even from an approved website",
  );
  eq(
    judge(null, { code: DEMO_BUCKET_CODE, secret: "" }).allow === false &&
      (judge(null, { code: DEMO_BUCKET_CODE, secret: "" }) as { reason: string }).reason,
    "demo-page-only",
    "and refused for that reason before any configuration question",
  );

  const produced = new Set(["no-referer", "unlisted-origin", "list-empty", "secret-unset", "demo-page-only"]);
  for (const r of TEST_ORIGIN_REFUSALS) assert(produced.has(r), `the origin refusal ${r} is produced by a case above`);

  const sentences = TEST_ORIGIN_REFUSALS.map((r) => testOriginRefusalSentence(r, "https://x.example"));
  eq(new Set(sentences).size, TEST_ORIGIN_REFUSALS.length, "every origin refusal has its own sentence");
  assert(testOriginRefusalSentence("unlisted-origin", "https://x.example").includes("https://x.example"), "the unlisted sentence names the website");
}

// --- the pass for pages whose viewer is already authorised --------------------------------
{
  const p = testPassForBucket({ code: CODE, secret: SECRET, nowMs: NOW });
  assert(p !== null && verifyTestPass({ pass: p, code: CODE, secret: SECRET, nowMs: NOW }).ok, "the manage and admin pages get a good pass for the public bucket");
  eq(testPassForBucket({ code: "100", secret: SECRET, nowMs: NOW }), null, "a real bucket is handed no pass, and needs none");
  eq(testPassForBucket({ code: HIDDEN_TEST_BUCKET_CODES[0], secret: SECRET, nowMs: NOW }), null, "a hidden bucket is handed no pass");
  eq(testPassForBucket({ code: CODE, secret: "", nowMs: NOW }), null, "no secret, no pass");
}

// --- the committed origin list --------------------------------------------------------------
// The list is a committed var, so its shape is checkable here: every entry must be
// exactly the origin a browser sends (no path, no trailing slash, lower case), or
// exact equality silently never matches it. And no developer machine: approving
// localhost approves every laptop that runs the app.
{
  const jsonc = readFileSync("wrangler.jsonc", "utf8");
  const top = jsonc.split(/"env"\s*:/)[0];
  const m = /"EMBED_TEST_ORIGINS"\s*:\s*"([^"]*)"/.exec(top);
  assert(m !== null, "the production vars carry EMBED_TEST_ORIGINS");
  const entries = (m?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  assert(entries.length > 0, "the committed origin list is not empty");
  for (const e of entries) {
    let origin = "";
    try {
      origin = new URL(e).origin;
    } catch {
      origin = "";
    }
    eq(origin, e, `the approved entry ${e} is exactly an origin`);
    assert(e.startsWith("https://"), `the approved entry ${e} is https`);
    assert(!/localhost|127\.0\.0\.1|\[::1\]/.test(e), `the approved entry ${e} is not a developer machine`);
  }
  // Positive control on the scan: a local origin in a fixture is caught.
  assert(/localhost/.test("http://localhost:3000"), "the developer machine pattern matches a local origin");
}

finish();

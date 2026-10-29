import { fieldsSignature, fieldsSignatureMatches } from "../signed-fields.ts";
import { TEST_ACCESS_COPY } from "../booking/booker-copy.ts";
import { isPublicTestBucket, opensFromHostPage } from "./public-test-bucket.ts";
import { TEST_PASS_REFUSAL_CODES, type TestPassRefusalCode } from "./test-pass-header.ts";

/**
 * Who may reach the public test bucket (#2666).
 *
 * #2660 opened the public test bucket to any host page. This narrows it to the
 * websites Pennie approves, in two steps:
 *
 *  1. `/book` reads the Referer of the iframe's own document request (trypennie
 *     sends `strict-origin-when-cross-origin`, so it carries the host ORIGIN) and
 *     compares its origin against `EMBED_TEST_ORIGINS` with exact equality.
 *  2. An approved page is handed a short lived PASS, an HMAC over the public code
 *     and an expiry, which the Booker sends on every read and on the confirm. Each
 *     of those routes verifies it before serving the test bucket.
 *
 * **The Referer check is a convenience gate, not authentication.** A caller that is
 * not a browser can send any Referer it likes, and a host page can suppress it with
 * a referrer policy. What it does is keep the test path off every website nobody
 * approved, which is where a stray or copied test link would otherwise land. The
 * pass exists so the three JSON routes inherit that decision rather than each
 * re-deciding it from a header they cannot see.
 *
 * Pure: the secret, the list and the clock are all passed in, so every refusal is
 * driven by `scripts/test-embed-test-pass.ts` without an environment.
 */

/** How long a pass is good for. Long enough to pick a time and fill the form in a
 *  modal left open for a while; short enough that a copied pass stops working the
 *  same afternoon. A pass that runs out mid booking has its own sentence. */
export const TEST_PASS_TTL_MS = 30 * 60 * 1000;

/** Domain separation, so this HMAC can never be mistaken for another one made
 *  with the same secret. The version lets the format change without a pass of
 *  the old shape verifying under the new rules. */
const CONTEXT = "slate-test-pass.v1";

/** Every way a presented pass is refused. */
export const PASS_REFUSALS = [
  "secret-unset",
  "missing",
  "malformed",
  "forged",
  "wrong-code",
  "expired",
] as const;
export type PassRefusal = (typeof PASS_REFUSALS)[number];

function signature(secret: string, code: string, expiresAtMs: number): string {
  return fieldsSignature(secret, CONTEXT, [code, String(expiresAtMs)]);
}

/** Make a pass for `code`. The caller decides whether the code deserves one. */
export function mintTestPass(input: {
  code: string;
  secret: string;
  nowMs: number;
}): { value: string; expiresAtMs: number } {
  const expiresAtMs = input.nowMs + TEST_PASS_TTL_MS;
  return {
    value: `${input.code}.${expiresAtMs}.${signature(input.secret, input.code, expiresAtMs)}`,
    expiresAtMs,
  };
}

/**
 * Check a presented pass against the code being asked for.
 *
 * The signature is judged BEFORE the code and the expiry, so an altered pass is
 * always "forged" and never reads as an honest one that merely expired, and the
 * code is checked against the REQUEST rather than trusted from the pass: a good
 * pass for the public bucket presented with any other code is refused.
 */
export function verifyTestPass(input: {
  pass: string | null;
  code: string;
  secret: string;
  nowMs: number;
}): { ok: true } | { ok: false; reason: PassRefusal } {
  if (!input.secret) return { ok: false, reason: "secret-unset" };
  if (!input.pass) return { ok: false, reason: "missing" };
  const parts = input.pass.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [passCode, expRaw, sig] = parts;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(passCode) || !/^\d{1,16}$/.test(expRaw) || !/^[0-9a-f]+$/.test(sig)) {
    return { ok: false, reason: "malformed" };
  }
  const expiresAtMs = Number(expRaw);
  if (!fieldsSignatureMatches(input.secret, CONTEXT, [passCode, String(expiresAtMs)], sig)) {
    return { ok: false, reason: "forged" };
  }
  if (passCode !== input.code) return { ok: false, reason: "wrong-code" };
  if (input.nowMs >= expiresAtMs) return { ok: false, reason: "expired" };
  return { ok: true };
}

/** The route's answer to a refused pass: a 403 carrying one of three codes and the
 *  tester's sentence for it. */
export function testPassRefusal(reason: PassRefusal): {
  status: 403;
  body: { error: string; code: TestPassRefusalCode };
} {
  if (reason === "expired") {
    return { status: 403, body: { error: TEST_ACCESS_COPY.passExpired, code: TEST_PASS_REFUSAL_CODES.expired } };
  }
  if (reason === "secret-unset") {
    return { status: 403, body: { error: TEST_ACCESS_COPY.passOff, code: TEST_PASS_REFUSAL_CODES.off } };
  }
  return { status: 403, body: { error: TEST_ACCESS_COPY.passRefused, code: TEST_PASS_REFUSAL_CODES.refused } };
}

/**
 * A pass for a page whose viewer is ALREADY authorised by something else: the
 * manage page (its token) and the admin booking panel (a staff session). A test
 * booking's bucket is the public test bucket, so their reschedule panels read its
 * times and need the pass the Booker has. Null for every other bucket, which needs
 * none, and null with no secret, where the read is refused as switched off.
 */
export function testPassForBucket(input: { code: string; secret: string; nowMs: number }): string | null {
  if (!isPublicTestBucket(input.code) || !input.secret) return null;
  return mintTestPass(input).value;
}

// --- the page's origin gate ----------------------------------------------------------

/** Every way `/book` refuses to open the public test bucket. */
export const TEST_ORIGIN_REFUSALS = [
  "demo-page-only",
  "secret-unset",
  "list-empty",
  "no-referer",
  "unlisted-origin",
] as const;
export type TestOriginRefusal = (typeof TEST_ORIGIN_REFUSALS)[number];

/**
 * Judge the page's Referer against the approved origins. The configuration is
 * judged first, because with no secret or no list nothing could be allowed and the
 * tester needs to hear that it is ours to fix, not theirs.
 *
 * An unreadable Referer counts as none: either way we cannot tell which website
 * framed the page, and the sentence says exactly that.
 *
 * The demo bucket (#3424) is refused before all of that: it is opened by Slate's
 * own `/demo` page and by no host page however approved, so what the reader needs
 * to hear is about the link, not the website.
 */
export function judgeTestOrigin(input: {
  /** The public test bucket the page is opening. */
  code: string;
  referer: string | null;
  approvedOrigins: readonly string[];
  secret: string;
}):
  | { allow: true; origin: string }
  | { allow: false; reason: TestOriginRefusal; origin: string | null } {
  let origin: string | null = null;
  if (input.referer) {
    try {
      const o = new URL(input.referer).origin;
      origin = o && o !== "null" ? o : null;
    } catch {
      origin = null;
    }
  }
  if (!opensFromHostPage(input.code)) return { allow: false, reason: "demo-page-only", origin };
  if (!input.secret) return { allow: false, reason: "secret-unset", origin };
  if (input.approvedOrigins.length === 0) return { allow: false, reason: "list-empty", origin };
  if (origin === null) return { allow: false, reason: "no-referer", origin };
  if (!input.approvedOrigins.includes(origin)) return { allow: false, reason: "unlisted-origin", origin };
  return { allow: true, origin };
}

/** The page's sentence for each refusal. */
export function testOriginRefusalSentence(reason: TestOriginRefusal, origin: string | null): string {
  switch (reason) {
    case "demo-page-only":
      return TEST_ACCESS_COPY.demoPageOnly;
    case "secret-unset":
      return TEST_ACCESS_COPY.secretUnset;
    case "list-empty":
      return TEST_ACCESS_COPY.listEmpty;
    case "no-referer":
      return TEST_ACCESS_COPY.noReferer;
    case "unlisted-origin":
      return TEST_ACCESS_COPY.unlistedOrigin(origin ?? "this website");
  }
}

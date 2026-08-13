// Reusing the Snowflake key-pair JWT across statements (#1141).
//
// Every statement used to import the RSA private key and sign a fresh token: four
// asymmetric operations to produce something valid for an hour. A reconciliation
// issues seven statements, each retention lane one, and the #1102 verification read
// plus its repair MERGE more, all inside cron invocations that share one CPU budget.
//
// The saving is the easy part. A JWT cache fails in ways a per-call signature
// cannot, so what this suite is really for is the four ways it could be wrong: a
// rotated key still being served the old token, a token reused past the point
// Snowflake will accept it, one signing error poisoning every later call, and a
// token Snowflake rejects being resent for the whole reuse window.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-snowflake-jwt-cache.ts
import {
  JWT_LIFETIME_MS,
  JWT_REUSE_MS,
  createJwtCache,
  type JwtIdentity,
} from "../src/lib/snowflake/jwt-cache.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const IDENTITY: JwtIdentity = {
  account: "ab12345.us-east-1",
  user: "SLATE_SERVICE",
  privateKeyPem: "-----BEGIN PRIVATE KEY-----AAAA-----END PRIVATE KEY-----",
};

/** A signer that records what it was asked to sign and returns a numbered token. */
function fakeSigner() {
  const seen: JwtIdentity[] = [];
  return {
    seen,
    sign: async (identity: JwtIdentity) => {
      seen.push(identity);
      return `token-${seen.length}`;
    },
  };
}

/** A clock the test moves by hand, so nothing here waits on real time. */
function clock(startMs = 1_000_000) {
  let atMs = startMs;
  return { nowMs: () => atMs, advance: (ms: number) => void (atMs += ms) };
}

// --- the point: many statements, one signature ---------------------------
{
  const signer = fakeSigner();
  const time = clock();
  const cache = createJwtCache({ sign: signer.sign, nowMs: time.nowMs });

  // Seven statements, the shape one reconciliation actually issues.
  const tokens: string[] = [];
  for (let i = 0; i < 7; i++) {
    time.advance(250);
    tokens.push(await cache.get(IDENTITY));
  }
  eq(cache.signCount(), 1, "#1141: seven statements cost ONE signature");
  eq(
    new Set(tokens).size,
    1,
    "and every statement carries the same token, so the saving is real rather than a counter",
  );
}

// --- reused inside the window, re-signed after it -----------------------
{
  const signer = fakeSigner();
  const time = clock();
  const cache = createJwtCache({ sign: signer.sign, nowMs: time.nowMs });

  eq(await cache.get(IDENTITY), "token-1", "the first call signs");
  time.advance(JWT_REUSE_MS - 1);
  eq(await cache.get(IDENTITY), "token-1", "one millisecond inside the window still reuses");
  time.advance(2);
  eq(await cache.get(IDENTITY), "token-2", "past the window it signs again");
  eq(cache.signCount(), 2, "exactly twice");
}

// --- the reuse window is SAFELY inside validity -------------------------
// The margin is the whole reason this is safe. Clock skew between us and Snowflake
// is the one thing that can make a token we believe is fresh be rejected, and a
// reuse window equal to the lifetime would guarantee that at the boundary.
{
  assert(JWT_REUSE_MS < JWT_LIFETIME_MS, "a token is reused for less than it is valid");
  assert(
    JWT_LIFETIME_MS - JWT_REUSE_MS >= 15 * 60 * 1000,
    `the margin is ${(JWT_LIFETIME_MS - JWT_REUSE_MS) / 60000} minutes, enough to absorb clock skew`,
  );
}

// --- A ROTATED KEY IS NOT SERVED THE OLD TOKEN --------------------------
// The failure that matters most, and the one a cache keyed on the account alone
// would produce: signing with a key Snowflake no longer knows, for thirty minutes,
// while every statement fails on auth for a reason nothing points at.
{
  const signer = fakeSigner();
  const time = clock();
  const cache = createJwtCache({ sign: signer.sign, nowMs: time.nowMs });

  eq(await cache.get(IDENTITY), "token-1", "signs for the original key");
  const rotated = { ...IDENTITY, privateKeyPem: "-----BEGIN PRIVATE KEY-----BBBB-----END PRIVATE KEY-----" };
  eq(await cache.get(rotated), "token-2", "a rotated key of the same size signs again immediately");
  eq(signer.seen[1]?.privateKeyPem, rotated.privateKeyPem, "and signs with the NEW key");

  const otherUser = { ...IDENTITY, user: "OTHER_SERVICE" };
  eq(await cache.get(otherUser), "token-3", "a different user signs again");
  const otherAccount = { ...IDENTITY, account: "zz99999.eu-west-1" };
  eq(await cache.get(otherAccount), "token-4", "a different account signs again");
  eq(cache.signCount(), 4, "so nothing about the identity is ignored");
}

// --- invalidate forces a re-sign ---------------------------------------
// Without this, a token Snowflake rejects would be resent for the whole reuse
// window: the cache would turn a one-off auth blip into thirty minutes of outage.
{
  const signer = fakeSigner();
  const time = clock();
  const cache = createJwtCache({ sign: signer.sign, nowMs: time.nowMs });

  eq(await cache.get(IDENTITY), "token-1", "signs");
  eq(await cache.get(IDENTITY), "token-1", "reuses");
  cache.invalidate();
  eq(await cache.get(IDENTITY), "token-2", "after an invalidate the next call signs a fresh token");
}

// --- concurrent callers share one signature ----------------------------
// The lanes await their statements in sequence today, but a Promise.all anywhere
// would otherwise sign once per statement and the counter would still look fine.
{
  const signer = fakeSigner();
  const cache = createJwtCache({ sign: signer.sign, nowMs: clock().nowMs });
  const all = await Promise.all([
    cache.get(IDENTITY),
    cache.get(IDENTITY),
    cache.get(IDENTITY),
    cache.get(IDENTITY),
  ]);
  eq(cache.signCount(), 1, "four concurrent callers cost one signature");
  eq(new Set(all).size, 1, "and all receive the same token");
}

// --- A FAILED SIGNATURE IS NOT CACHED ----------------------------------
// The poisoning case. Caching the rejected promise would make every later caller
// await the same failure, turning one transient signing error into an export lane
// that is broken until the isolate is replaced.
{
  let attempts = 0;
  const cache = createJwtCache({
    nowMs: clock().nowMs,
    sign: async () => {
      attempts++;
      if (attempts === 1) throw new Error("key import failed");
      return "token-after-recovery";
    },
  });

  let threw = false;
  try {
    await cache.get(IDENTITY);
  } catch {
    threw = true;
  }
  assert(threw, "a signing failure reaches the caller rather than being swallowed");
  eq(
    await cache.get(IDENTITY),
    "token-after-recovery",
    "and the NEXT call signs again rather than awaiting the same rejection",
  );
  eq(attempts, 2, "so exactly one retry happened, driven by the caller");
}

// --- a failure while several callers are waiting -----------------------
// All of them see the error (none silently receives undefined), and the cache is
// clean afterwards.
{
  let attempts = 0;
  const cache = createJwtCache({
    nowMs: clock().nowMs,
    sign: async () => {
      attempts++;
      if (attempts === 1) throw new Error("transient");
      return "recovered";
    },
  });
  const results = await Promise.allSettled([cache.get(IDENTITY), cache.get(IDENTITY)]);
  eq(
    results.filter((r) => r.status === "rejected").length,
    2,
    "both concurrent callers see the failure",
  );
  eq(await cache.get(IDENTITY), "recovered", "and the cache is usable again straight after");
}

finish();

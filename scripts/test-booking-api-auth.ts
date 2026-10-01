// Auth for the direct booking API (#355, milestone #2). Pure/IO-free so it runs
// under `node --experimental-strip-types` with no Next/Supabase/Google in scope.
//
// #2645: one key per CALLER. Regal, trypennie and the smoke canary each hold their
// own secret (with its own two slot rotation). The original shared pair is gone
// (#2865): Regal got a fresh key and trypennie's value moved into its own rotation
// slot, so every key now names exactly one caller. Every authenticated call reports WHICH caller and slot it matched (labels, never the
// secret), which is what lets the rate ceiling and the logs name a caller.
// Run: node --experimental-strip-types scripts/test-booking-api-auth.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  BOOKING_API_CALLERS,
  CANARY_CALLERS,
  CANCEL_ONLY_CALLERS,
  FULL_API_CALLERS,
  bookingApiKeyEnvName,
  parseApiKeys,
  authenticateBearer,
  mayBookTestBuckets,
} from "../src/lib/booking/api-auth.ts";
import { HIDDEN_TEST_BUCKET_CODES, PUBLIC_TEST_BUCKET_CODES } from "../src/lib/embed/public-test-bucket.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const none = { primary: "", secondary: "" };

// --- the caller vocabulary ------------------------------------------------------
{
  eq(
    [...BOOKING_API_CALLERS].sort().join(","),
    "canary,marcia,regal,trypennie",
    "the four callers the booking API knows, and no shared caller (#2865, #2940)",
  );
  // #2940: Marcia (the Pipedream SMS workflow) holds a key that opens the cancel and
  // nothing else. Every other caller keeps the whole API.
  eq([...CANCEL_ONLY_CALLERS].sort().join(","), "marcia", "Marcia is the only cancel only caller");
  eq([...FULL_API_CALLERS].sort().join(","), "canary,regal,trypennie", "every other caller keeps the whole API");
  // CANARY_CALLERS gates the smoke endpoints, which can stamp the canary's own
  // heartbeat: a partner key there could keep a dead canary looking alive.
  eq([...CANARY_CALLERS].sort().join(","), "canary", "only the canary may call the smoke endpoints");
}

// --- env names are derived from the caller, one rule for all of them -------------
{
  // #2865: the bare pair is nobody's any more, so no caller may resolve to it. A
  // Worker still holding BOOKING_API_KEY after the retirement is then read by nothing.
  for (const caller of BOOKING_API_CALLERS) {
    for (const slot of ["primary", "secondary"] as const) {
      const name = bookingApiKeyEnvName(caller, slot);
      assert(name !== "BOOKING_API_KEY" && name !== "BOOKING_API_KEY_2", `${caller} ${slot} is not the retired shared name (${name})`);
    }
  }
  eq(bookingApiKeyEnvName("regal", "primary"), "BOOKING_API_KEY_REGAL", "a named caller's primary");
  eq(bookingApiKeyEnvName("trypennie", "secondary"), "BOOKING_API_KEY_TRYPENNIE_2", "a named caller's rotation slot");
  eq(bookingApiKeyEnvName("marcia", "primary"), "BOOKING_API_KEY_MARCIA", "Marcia's primary (#2940)");
  eq(bookingApiKeyEnvName("marcia", "secondary"), "BOOKING_API_KEY_MARCIA_2", "Marcia's rotation slot (#2940)");
}

// --- #2940: an unset Marcia key fails closed for Marcia ONLY -----------------------
{
  // The day this deploys, nobody has set BOOKING_API_KEY_MARCIA. Every other caller
  // must go on authenticating exactly as before, and nothing may answer for Marcia.
  const withoutMarcia = parseApiKeys([
    { caller: "regal", primary: "regal-secret", secondary: "" },
    { caller: "trypennie", primary: "trypennie-secret", secondary: "" },
    { caller: "canary", primary: "canary-secret", secondary: "" },
    { caller: "marcia", ...none },
  ]);
  for (const [caller, secret] of [["regal", "regal-secret"], ["trypennie", "trypennie-secret"], ["canary", "canary-secret"]] as const) {
    const r = authenticateBearer(`Bearer ${secret}`, withoutMarcia);
    assert(r.ok === true && r.caller === caller, `${caller} still authenticates with Marcia's key unset`);
  }
  const orphan = authenticateBearer("Bearer marcia-secret", withoutMarcia);
  assert(orphan.ok === false && orphan.status === 401, "a Marcia key the Worker does not hold is refused (401)");
  // Marcia alone and unset: the surface is OFF (503), never open.
  const res = authenticateBearer("Bearer anything", parseApiKeys([{ caller: "marcia", ...none }]));
  assert(res.ok === false && res.status === 503, "Marcia alone and unset -> 503, fails closed");

  // Set, it names Marcia, in either slot.
  const withMarcia = parseApiKeys([
    { caller: "regal", primary: "regal-secret", secondary: "" },
    { caller: "marcia", primary: "marcia-secret", secondary: "marcia-next" },
  ]);
  const m = authenticateBearer("Bearer marcia-secret", withMarcia);
  assert(m.ok === true && m.caller === "marcia" && m.keyId === "marcia:primary", "Marcia's key names Marcia");
  const m2 = authenticateBearer("Bearer marcia-next", withMarcia);
  assert(m2.ok === true && m2.caller === "marcia" && m2.keyId === "marcia:secondary", "and its rotation slot too");

  // A key set built for the FULL API (every route but the cancel) does not hold
  // Marcia's key at all, so her key is refused there even when it is configured.
  const fullOnly = parseApiKeys(
    FULL_API_CALLERS.map((caller) => ({ caller, primary: `${caller}-secret`, secondary: "" })),
  );
  const refused = authenticateBearer("Bearer marcia-secret", fullOnly);
  assert(refused.ok === false && refused.status === 401, "Marcia's key is refused by a full API key set");
  const regal = authenticateBearer("Bearer regal-secret", fullOnly);
  assert(regal.ok === true && regal.caller === "regal", "and Regal's is accepted by it (positive control)");
}

// --- parseApiKeys: build the labelled key set from each caller's two slots -------
{
  const keys = parseApiKeys([
    { caller: "canary", primary: "canary-secret", secondary: "" },
    { caller: "regal", primary: "regal-old", secondary: "regal-new" },
    { caller: "trypennie", ...none },
  ]);
  eq(
    keys.map((k) => k.id).join(","),
    "regal:primary,regal:secondary,canary:primary",
    "configured slots only, in the order the callers are declared",
  );
  const regal = keys.find((k) => k.id === "regal:secondary");
  assert(regal?.caller === "regal" && regal.slot === "secondary" && regal.secret === "regal-new", "a key carries its caller and slot");

  eq(parseApiKeys([{ caller: "canary", primary: "  ", secondary: "" }]).length, 0, "whitespace-only secret is not a key");
  eq(parseApiKeys([]).length, 0, "no callers -> no keys");
}

// --- authenticateBearer: unconfigured endpoint fails CLOSED with 503 ---------------
{
  const res = authenticateBearer("Bearer anything", []);
  assert(res.ok === false && res.status === 503, "no keys configured -> 503 (not 401)");
}

const keys = parseApiKeys([
  { caller: "regal", primary: "regal-secret", secondary: "" },
  { caller: "trypennie", primary: "trypennie-secret", secondary: "trypennie-next" },
  { caller: "canary", ...none },
]);

// --- each caller's key authenticates AS that caller ---------------------------------
{
  const r = authenticateBearer("Bearer regal-secret", keys);
  assert(r.ok === true && r.caller === "regal" && r.keyId === "regal:primary", "Regal's key names Regal");

  const t = authenticateBearer("Bearer trypennie-next", keys);
  assert(t.ok === true && t.caller === "trypennie" && t.keyId === "trypennie:secondary", "a rotation slot names its caller");

  // #2865: trypennie kept the value it already held, now in its rotation slot, so a
  // value the shared caller used to answer for authenticates as trypennie.
  const moved = parseApiKeys([{ caller: "trypennie", primary: "trypennie-own", secondary: "old-shared-value" }]);
  const m = authenticateBearer("Bearer old-shared-value", moved);
  assert(m.ok === true && m.caller === "trypennie" && m.keyId === "trypennie:secondary", "the old shared value, held in trypennie's slot, names trypennie");
}

// --- bad / missing / malformed credentials -> 401 ------------------------------------
{
  const wrong = authenticateBearer("Bearer wrong-secret", keys);
  assert(wrong.ok === false && wrong.status === 401 && wrong.tokenPresent === true, "wrong secret -> 401, token present");

  const missing = authenticateBearer(null, keys);
  assert(missing.ok === false && missing.status === 401 && missing.tokenPresent === false, "missing header -> 401, no token");
  assert(authenticateBearer("regal-secret", keys).ok === false, "missing 'Bearer ' scheme -> not ok");
  assert(authenticateBearer("Bearer ", keys).ok === false, "empty bearer token -> not ok");
  assert(authenticateBearer("Basic regal-secret", keys).ok === false, "wrong auth scheme -> not ok");
  // An unset slot is skipped, so an empty token can never match it.
  assert(authenticateBearer("Bearer ", parseApiKeys([{ caller: "regal", primary: "x", secondary: "" }])).ok === false, "empty token never matches an unset slot");
}

// --- #2822: the canary's own key, through the same constant time verifier ------------
//
// The canary holds its own key. It must authenticate AS the canary even with another
// caller configured beside it, a
// wrong token must still be refused, and a canary key the Worker does not hold must
// be refused rather than falling back to any other caller.
{
  const withCanary = parseApiKeys([
    { caller: "regal", primary: "regal-secret", secondary: "" },
    { caller: "canary", primary: "canary-secret", secondary: "canary-next" },
  ]);
  const c = authenticateBearer("Bearer canary-secret", withCanary);
  assert(c.ok === true && c.caller === "canary" && c.keyId === "canary:primary", "the canary's key names the canary, not another caller");
  const c2 = authenticateBearer("Bearer canary-next", withCanary);
  assert(c2.ok === true && c2.caller === "canary" && c2.keyId === "canary:secondary", "and its rotation slot too");
  const wrongCanary = authenticateBearer("Bearer canary-secretX", withCanary);
  assert(wrongCanary.ok === false && wrongCanary.status === 401 && wrongCanary.tokenPresent === true, "a near miss of the canary key is a 401 with a token present");

  // The Worker without BOOKING_API_KEY_CANARY set: the canary's value is nobody's key.
  const workerWithoutCanary = parseApiKeys([
    { caller: "regal", primary: "regal-secret", secondary: "" },
    { caller: "canary", primary: "", secondary: "" },
  ]);
  const orphan = authenticateBearer("Bearer canary-secret", workerWithoutCanary);
  assert(orphan.ok === false && orphan.status === 401, "a canary key the Worker does not hold is refused (401), which fails the canary loudly");
  // Only the canary configured: the endpoint is ON for the canary alone.
  const canaryOnly = parseApiKeys([{ caller: "canary", primary: "canary-secret", secondary: "" }, { caller: "regal", primary: "", secondary: "" }]);
  assert(authenticateBearer("Bearer regal-secret", canaryOnly).ok === false, "an unset caller's value is refused");
  const ok = authenticateBearer("Bearer canary-secret", canaryOnly);
  assert(ok.ok === true && ok.caller === "canary", "and the canary still authenticates");
}

// --- the env reads are literal, one per caller and slot (#2645) ----------------------
//
// The deploy runbook guard (scripts/test-deploy-env-coverage.ts) only sees an env
// var read by a LITERAL name, in both directions, so a name built at runtime would
// leave every new secret undocumented and every documented one "read by nothing".
// So each derived name must appear as a literal read in env.ts.
{
  const envTs = readFileSync("src/lib/env.ts", "utf8");
  for (const caller of BOOKING_API_CALLERS) {
    for (const slot of ["primary", "secondary"] as const) {
      const name = bookingApiKeyEnvName(caller, slot);
      assert(envTs.includes(`process.env.${name} `), `src/lib/env.ts reads ${name} by its literal name`);
    }
  }
}

// --- and ONLY env.ts reads them, so the key set is built in one place (L613) ----------
//
// Positive control first: the scan must find the reads that DO exist, or a scan
// reading nothing would pass the check below on an empty set (L98).
{
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p)) {
        if (/process\.env\.BOOKING_API_KEY/.test(readFileSync(p, "utf8"))) hits.push(p);
      }
    }
  };
  walk("src");
  assert(hits.includes(join("src", "lib", "env.ts")), "the scan finds env.ts's own reads (positive control)");
  eq(hits.filter((p) => p !== join("src", "lib", "env.ts")).join(", "), "", "no other src file reads a booking API key from the environment");
  // #2865: and env.ts no longer reads the retired shared pair at all.
  const envSrc = readFileSync(join("src", "lib", "env.ts"), "utf8");
  eq(/process\.env\.BOOKING_API_KEY(_2)?\b(?!_)/.test(envSrc), false, "env.ts reads neither BOOKING_API_KEY nor BOOKING_API_KEY_2");
}

// --- who may book a test bucket through the key-authed API (#2669) ---------------
// Since #2645 each partner holds its own key, and a partner could book the canary's
// hidden buckets while it could not READ them. The canary callers may use every test
// bucket; anyone may use the PUBLIC one (#2660), which a partner is meant to use.
{
  const hidden = HIDDEN_TEST_BUCKET_CODES[0];
  const publicCode = PUBLIC_TEST_BUCKET_CODES[0];
  for (const caller of BOOKING_API_CALLERS) {
    const canary = CANARY_CALLERS.includes(caller);
    eq(mayBookTestBuckets(caller, hidden), canary, `${caller} ${canary ? "may" : "may NOT"} book the hidden ${hidden}`);
    eq(mayBookTestBuckets(caller, publicCode), true, `${caller} may book the public ${publicCode}`);
  }
  // The positive half is what makes the negative half mean something (L1): a helper
  // hard wired to false would pass every "may NOT" above.
  assert(mayBookTestBuckets("canary", "SMOKE2"), "the canary may book its second hidden bucket");
  eq(mayBookTestBuckets("trypennie", "SMOKE2"), false, "a partner may not book the second hidden bucket");
  // The public code authorises itself and nothing else, exactly and case sensitively.
  eq(mayBookTestBuckets("regal", publicCode.toLowerCase()), false, "a lower case spelling of the public code is not the public code");
  eq(mayBookTestBuckets("regal", "411"), false, "a real code never carries the test opt in for a partner");
}

finish();

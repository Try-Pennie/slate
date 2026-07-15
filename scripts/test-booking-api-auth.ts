// Auth for the direct booking API (#355, milestone #2). Pure/IO-free so it runs
// under `node --experimental-strip-types` with no Next/Supabase/Google in scope.
// Two valid keys (primary + secondary) so the key can be rotated with zero
// downtime, and every authenticated call reports WHICH key it matched (a label,
// never the secret) for caller attribution.
// Run: node --experimental-strip-types scripts/test-booking-api-auth.ts
import { parseApiKeys, authenticateBearer } from "../src/lib/booking/api-auth.ts";
import { assert, finish } from "./lib/harness.ts";

// --- parseApiKeys: build the labeled key set from the two env slots ---
{
  const both = parseApiKeys("primary-secret", "secondary-secret");
  assert(both.length === 2, "two configured secrets -> two keys");
  assert(both[0].id === "primary" && both[0].secret === "primary-secret", "first key labeled 'primary'");
  assert(both[1].id === "secondary" && both[1].secret === "secondary-secret", "second key labeled 'secondary'");

  const onlyPrimary = parseApiKeys("primary-secret", "");
  assert(onlyPrimary.length === 1 && onlyPrimary[0].id === "primary", "empty secondary is skipped");

  const onlySecondary = parseApiKeys("", "secondary-secret");
  assert(
    onlySecondary.length === 1 && onlySecondary[0].id === "secondary",
    "a lone secondary still works (mid-rotation, primary already retired)",
  );

  assert(parseApiKeys("", "").length === 0, "no secrets -> no keys");
  assert(parseApiKeys("  ", "").length === 0, "whitespace-only secret is not a key");
}

// --- authenticateBearer: unconfigured endpoint fails CLOSED with 503 ---
{
  const res = authenticateBearer("Bearer anything", []);
  assert(res.ok === false && res.status === 503, "no keys configured -> 503 (not 401)");
}

const keys = parseApiKeys("primary-secret", "secondary-secret");

// --- either valid key authenticates, and reports which one ---
{
  const p = authenticateBearer("Bearer primary-secret", keys);
  assert(p.ok === true && p.keyId === "primary", "valid primary key -> ok, keyId 'primary'");

  const s = authenticateBearer("Bearer secondary-secret", keys);
  assert(s.ok === true && s.keyId === "secondary", "valid secondary key -> ok, keyId 'secondary'");
}

// --- bad / missing / malformed credentials -> 401 ---
{
  assert(authenticateBearer("Bearer wrong-secret", keys).ok === false, "wrong secret -> not ok");
  const wrong = authenticateBearer("Bearer wrong-secret", keys);
  assert(wrong.ok === false && wrong.status === 401, "wrong secret -> 401");

  assert(authenticateBearer(null, keys).ok === false, "missing Authorization header -> not ok");
  assert(authenticateBearer("primary-secret", keys).ok === false, "missing 'Bearer ' scheme -> not ok");
  assert(authenticateBearer("Bearer ", keys).ok === false, "empty bearer token -> not ok");
  assert(authenticateBearer("Basic primary-secret", keys).ok === false, "wrong auth scheme -> not ok");
}

// --- a configured-but-empty secret must never be a usable credential ---
{
  const onlyPrimary = parseApiKeys("primary-secret", "");
  assert(
    authenticateBearer("Bearer ", onlyPrimary).ok === false,
    "empty token never matches even when a real key is configured",
  );
}

finish();

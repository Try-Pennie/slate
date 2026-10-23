// #3526: Slate refuses a session whose auth user holds no Google identity (or two),
// on the sign in callback and on every request. The browser checks sign in with a
// magic link, because a local run cannot reach Google, so their auth users would
// hold only an email identity and every signed in spec would land on the sign in
// page. The local stack therefore gives each auth user one Google identity before
// the callback runs (`e2e/google-identity.ts`), written straight into the local
// database, never through a bypass in the app.
//
// Driven here without a stack, through a fake query function: what is written, that
// it is idempotent across repeated sign ins of one person, and that a write which
// did not leave exactly one Google identity with the expected id fails the sign in
// rather than letting a spec go on to a confusing refusal.
//
// Run: node --experimental-strip-types scripts/test-e2e-google-identity.ts
import { assert, eq, finish } from "./lib/harness.ts";
import { attachGoogleIdentity, e2eGoogleSub, GOOGLE_IDENTITY_INSERT } from "../e2e/google-identity.ts";

// --- the account id is stable per person, whatever the case of the address ---------
{
  eq(e2eGoogleSub("Ada.Admin@slate-e2e.test"), e2eGoogleSub("ada.admin@slate-e2e.test"), "one id per address");
  assert(
    e2eGoogleSub("ada.admin@slate-e2e.test") !== e2eGoogleSub("avery.agent@slate-e2e.test"),
    "two people get two ids",
  );
}

// --- the write is a Google identity, keyed so a second sign in adds nothing --------
{
  assert(/insert\s+into\s+auth\.identities/i.test(GOOGLE_IDENTITY_INSERT), "it writes auth.identities");
  assert(/'google'/.test(GOOGLE_IDENTITY_INSERT), "the identity's provider is google");
  assert(/'sub'\s*,\s*\$1/.test(GOOGLE_IDENTITY_INSERT), "identity_data carries the sub the app reads");
  assert(/on\s+conflict\s*\(\s*provider_id\s*,\s*provider\s*\)\s+do\s+nothing/i.test(GOOGLE_IDENTITY_INSERT), "idempotent");
}

type Call = { sql: string; params: unknown[] };
function fakeQuery(googleSubsAfter: string[]) {
  const calls: Call[] = [];
  const query = async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    if (/select/i.test(sql) && !/insert/i.test(sql)) return { rows: googleSubsAfter.map((sub) => ({ sub })) };
    return { rows: [] };
  };
  return { calls, query };
}

// --- a sign in that leaves exactly the expected identity goes ahead ----------------
await (async () => {
  const email = "ada.admin@slate-e2e.test";
  const f = fakeQuery([e2eGoogleSub(email)]);
  await attachGoogleIdentity(f.query, email);
  eq(f.calls.length, 2, "one insert, then one read back");
  eq(f.calls[0]!.params, [e2eGoogleSub(email), email], "the insert names the id and the address");
})();

// --- anything else fails the sign in, loudly --------------------------------------
await (async () => {
  const email = "ada.admin@slate-e2e.test";
  for (const [label, after] of [
    ["no identity was written (no auth user yet)", []],
    ["a second Google identity is on the auth user", [e2eGoogleSub(email), "other"]],
    ["the identity carries another id", ["other"]],
  ] as const) {
    let threw = false;
    try {
      await attachGoogleIdentity(fakeQuery([...after]).query, email);
    } catch {
      threw = true;
    }
    assert(threw, `refuses when ${label}`);
  }
})();

finish();

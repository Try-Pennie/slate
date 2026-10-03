// #3091: the monitor lane pages for as long as an outbound webhook credential is
// still read from the database column rather than a Worker secret, and clears once
// both are in the Worker. Both directions are asserted (L1), and an unreadable
// endpoint read neither pages nor clears (L11).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-webhook-credential-source.ts
import { assert, eq, finish } from "./lib/harness.ts";
import {
  credentialSourceVerdict,
  formatCredentialsInDatabaseAlert,
  formatCredentialsInDatabaseRecovery,
  runWebhookCredentialSourceCheck,
  WEBHOOK_CREDENTIALS_KEY,
  type StoredCredentialPresence,
} from "@/lib/monitor/webhook-credential-source";

// Both columns hold a value, as the live Regal row does: it carries an old minted
// signing secret it never sends.
const regal = { format: "regal" as const, hasDbKey: true, hasDbSigning: true };
const generic = { format: "generic" as const, hasDbKey: true, hasDbSigning: true };
const stored = regal;
const noWorker = { regalKeySet: false, signingSecretSet: false };
const allWorker = { regalKeySet: true, signingSecretSet: true };

// Judged on what each endpoint's FORMAT sends, never on what its columns hold.
eq(credentialSourceVerdict([regal], noWorker).onDatabase, ["key"], "a Regal row on the column reports its key only");
eq(
  credentialSourceVerdict([regal], { regalKeySet: true, signingSecretSet: false }).onDatabase,
  [],
  "a Regal row clears once the key is in the Worker, whatever signing secret its column still holds",
);
eq(credentialSourceVerdict([generic], noWorker).onDatabase, ["signing"], "a generic row reports its signing secret only");
eq(
  credentialSourceVerdict([generic], { regalKeySet: false, signingSecretSet: true }).onDatabase,
  [],
  "a generic row clears once the signing secret is in the Worker, whatever key its column holds",
);
eq(
  credentialSourceVerdict([regal, generic], noWorker).onDatabase,
  ["key", "signing"],
  "one row of each format on the column reports both",
);
eq(credentialSourceVerdict([regal, generic], allWorker).onDatabase, [], "both in the Worker reports nothing");
eq(
  credentialSourceVerdict([{ format: "regal", hasDbKey: false, hasDbSigning: false }], noWorker).onDatabase,
  [],
  "a nulled column with no Worker secret is missing, not on the database (the wire refuses that)",
);
eq(credentialSourceVerdict(null, noWorker).measured, false, "an unreadable read is unmeasured");

// Copy: names each secret to put, never a value, one line, no raw shapes.
{
  const both = formatCredentialsInDatabaseAlert(credentialSourceVerdict([regal, generic], noWorker));
  assert(both.includes("REGAL_WEBHOOK_KEY") && both.includes("WEBHOOK_SIGNING_SECRET"), "the page names both secrets to put");
  assert(!both.includes("\n"), "the page is one line");
  const one = formatCredentialsInDatabaseAlert(
    credentialSourceVerdict([regal, generic], { regalKeySet: true, signingSecretSet: false }),
  );
  assert(one.includes("WEBHOOK_SIGNING_SECRET") && !one.includes("REGAL_WEBHOOK_KEY"), "one credential names only its own secret");
  assert(/the Worker secret WEBHOOK_SIGNING_SECRET is not set/.test(one), "the singular reads as singular");
  eq(formatCredentialsInDatabaseAlert(credentialSourceVerdict([stored], allWorker)), "", "nothing to say when moved");
}

async function run(
  endpoints: () => Promise<StoredCredentialPresence[] | null>,
  worker: { regalKeySet: boolean; signingSecretSet: boolean },
) {
  const notified: [string, string][] = [];
  const resolved: [string, string][] = [];
  const verdict = await runWebhookCredentialSourceCheck({
    loadEndpoints: endpoints,
    worker,
    notify: async (key, _ms, text) => {
      notified.push([key, text]);
    },
    resolve: async (key, text) => {
      resolved.push([key, text]);
    },
    cooldownMs: 1,
  });
  return { verdict, notified, resolved };
}

{
  const r = await run(async () => [stored], noWorker);
  eq(r.notified.length, 1, "on the column: pages once");
  eq(r.notified[0]?.[0], WEBHOOK_CREDENTIALS_KEY, "on the column: on its own key");
  eq(r.resolved.length, 0, "on the column: clears nothing");
}
{
  const r = await run(async () => [stored], allWorker);
  eq(r.notified.length, 0, "moved: does not page");
  eq(r.resolved.length, 1, "moved: clears");
  eq(r.resolved[0]?.[1], formatCredentialsInDatabaseRecovery(), "moved: with the recovery copy");
}
{
  const r = await run(async () => null, noWorker);
  eq(r.notified.length + r.resolved.length, 0, "unreadable: neither pages nor clears");
}
{
  const r = await run(async () => {
    throw new Error("boom");
  }, allWorker);
  eq(r.notified.length + r.resolved.length, 0, "a throwing read neither pages nor clears");
  eq(r.verdict.measured, false, "a throwing read is unmeasured");
}

finish();

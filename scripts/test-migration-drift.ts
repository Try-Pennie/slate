// The prod migration-version lag check (#516): the deployed build knows the
// highest migration it ships; the live DB knows the highest it has applied. A
// code-ahead-of-schema gap is the #276/#516 incident (0037, 0055) and must page.
//
// The read failing is NOT "no drift": an unreadable version is exactly the
// false-confidence trap this repo keeps falling into, so it must alert too.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-migration-drift.ts
import {
  classifyMigrationDrift,
  formatMigrationDriftAlert,
  runMigrationDriftCheck,
  MIGRATION_VERSION_LAG_KEY,
} from "../src/lib/monitor/migration-drift.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else {
    console.log("ok:", msg);
  }
}

// --- classify ---------------------------------------------------------------
assert(classifyMigrationDrift("0070", "0070") === "in-sync", "same version -> in-sync");
assert(
  classifyMigrationDrift("0071", "0070") === "db-behind",
  "code ships 0071, DB applied 0070 -> db-behind (the paging case)",
);
assert(
  classifyMigrationDrift("0070", "0071") === "db-ahead",
  "DB applied 0071, code ships 0070 -> db-ahead (normal apply-then-deploy window)",
);
assert(
  classifyMigrationDrift("0070", null) === "unverified",
  "null applied version (read failed / RPC missing) -> unverified, NEVER in-sync",
);
assert(
  classifyMigrationDrift("0070", "") === "unverified",
  "empty applied version -> unverified",
);
assert(
  classifyMigrationDrift("0070", "not-a-version") === "unverified",
  "unparseable applied version -> unverified",
);
// Zero padding must not be compared as text: "0100" > "0099" numerically, and a
// lexical compare happens to agree here, but "100" vs "0099" would not.
assert(
  classifyMigrationDrift("0100", "0099") === "db-behind",
  "0100 vs 0099 compares numerically -> db-behind",
);

// --- format -----------------------------------------------------------------
const behind = formatMigrationDriftAlert("db-behind", "0071", "0070");
assert(behind.includes("0071") && behind.includes("0070"), "db-behind alert names both versions");
assert(
  /db push|apply/i.test(behind),
  "db-behind alert says what to do (apply the pending migration)",
);
assert(!/[—–]/.test(behind), "db-behind alert has no em/en dash (copy lint)");

const unverified = formatMigrationDriftAlert("unverified", "0071", null);
assert(
  /could not|unable|cannot/i.test(unverified),
  "unverified alert says the version could not be read, not that things are fine",
);
assert(!/[—–]/.test(unverified), "unverified alert has no em/en dash (copy lint)");

// --- runner (hand-written fakes, no module mocking) --------------------------
interface Sent {
  key: string;
  cooldownMs: number;
  text: string;
}

function harness(opts: {
  applied?: string | null;
  readThrows?: boolean;
  notifyThrows?: boolean;
  shipped?: string;
}) {
  const sent: Sent[] = [];
  const run = () =>
    runMigrationDriftCheck({
      shippedVersion: opts.shipped ?? "0071",
      readAppliedVersion: async () => {
        if (opts.readThrows) throw new Error("rpc applied_migration_version does not exist");
        return opts.applied ?? null;
      },
      notify: async (key, cooldownMs, text) => {
        sent.push({ key, cooldownMs, text });
        if (opts.notifyThrows) throw new Error("slack 500");
      },
      cooldownMs: 60 * 60_000,
    });
  return { run, sent };
}

{
  const { run, sent } = harness({ applied: "0071" });
  const status = await run();
  assert(status === "in-sync" && sent.length === 0, "in-sync run alerts nothing");
}

{
  const { run, sent } = harness({ applied: "0072" });
  const status = await run();
  assert(
    status === "db-ahead" && sent.length === 0,
    "db-ahead (migration applied before the deploy lands) is quiet, not an alert",
  );
}

{
  const { run, sent } = harness({ applied: "0070" });
  const status = await run();
  assert(status === "db-behind", "db-behind run reports db-behind");
  assert(sent.length === 1, "db-behind run sends exactly one alert");
  assert(sent[0].key === MIGRATION_VERSION_LAG_KEY, "alert uses the throttled lag key");
  assert(sent[0].cooldownMs === 60 * 60_000, "alert passes the caller's cooldown through");
  assert(sent[0].text.includes("0070"), "alert names the applied version");
}

// Failure path: the read itself blowing up (the RPC missing because ITS OWN
// migration was never applied) must alert, not pass silently.
{
  const { run, sent } = harness({ readThrows: true });
  const status = await run();
  assert(status === "unverified", "a throwing version read -> unverified");
  assert(sent.length === 1, "a throwing version read still alerts (fail loud, never silent)");
  assert(sent[0].key === MIGRATION_VERSION_LAG_KEY, "unverified alert uses the same throttled key");
}

// Failure path: Slack being down must not take the monitor tick down with it.
{
  const { run, sent } = harness({ applied: "0070", notifyThrows: true });
  const status = await run();
  assert(
    status === "db-behind" && sent.length === 1,
    "a throwing notify is swallowed: the check still returns its status",
  );
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

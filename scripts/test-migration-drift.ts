// The prod migration-version lag check (#516). The deployed build knows the
// highest migration it ships; the shipped set is contiguous 0001..N (guaranteed
// by scripts/test-migrations.ts), so the build side only needs that max. The live
// DB reports the FULL set of migrations it has applied, and the check pages when
// any migration in 0001..N is missing from it (#814). A code-ahead-of-schema gap
// is the #214/#276/#516 incident and must page, INCLUDING a hole in the middle
// (0032 recorded as missing while later migrations applied) that a max-only
// compare read as "in-sync".
//
// The read failing is NOT "no drift": an unreadable set is exactly the
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

// A complete applied set 0001..N as the RPC would return it (sorted text list).
function fullSet(n: number): string[] {
  return Array.from({ length: n }, (_, i) => String(i + 1).padStart(4, "0"));
}

// --- classify ---------------------------------------------------------------
assert(
  classifyMigrationDrift("0071", fullSet(71)) === "in-sync",
  "full set 0001..0071 with shipped 0071 -> in-sync",
);
assert(
  classifyMigrationDrift("0071", fullSet(70)) === "db-behind",
  "trailing gap (applied only up to 0070, ships 0071) -> db-behind",
);
assert(
  classifyMigrationDrift("0070", fullSet(71)) === "db-ahead",
  "DB applied 0001..0071, code ships 0070 -> db-ahead (normal apply-then-deploy window)",
);
// The #814 bug: a hole in the MIDDLE. Earlier max-only compare called this in-sync.
{
  const withHole = fullSet(71).filter((v) => v !== "0032");
  assert(
    classifyMigrationDrift("0071", withHole) === "db-behind",
    "#814: 0032 missing while 0001..0071 otherwise applied -> db-behind (was falsely in-sync)",
  );
}
// The corner a count-only fix would miss: a version ABOVE shipped is applied while
// one at/below shipped is missing. Set of 0001..0070 + 0072, ships 0071. Count of
// applied (71) equals shipped count, and the max is ahead, yet 0071 is missing.
{
  const aheadWithHole = [...fullSet(70), "0072"];
  assert(
    classifyMigrationDrift("0071", aheadWithHole) === "db-behind",
    "#814: applied {0001..0070,0072}, ships 0071 -> db-behind (ahead-with-a-gap, count would miss it)",
  );
}
assert(
  classifyMigrationDrift("0071", null) === "unverified",
  "null applied set (read failed / RPC missing) -> unverified, NEVER in-sync",
);
assert(
  classifyMigrationDrift("0071", []) === "unverified",
  "empty applied set (schema_migrations cannot really be empty) -> unverified, not in-sync",
);
// Out-of-band / unparseable versions in the list are ignored, not fatal: the RPC
// already filters to ^[0-9]{4}$, and a stray entry must not flip a healthy DB.
assert(
  classifyMigrationDrift("0071", [...fullSet(71), "not-a-version"]) === "in-sync",
  "an unparseable extra entry is ignored -> still in-sync",
);
// Zero padding must not be compared as text: parsed as numbers throughout.
assert(
  classifyMigrationDrift("0100", fullSet(100)) === "in-sync",
  "0001..0100 vs shipped 0100 compares numerically -> in-sync",
);

// --- format -----------------------------------------------------------------
{
  const withHole = fullSet(71).filter((v) => v !== "0032");
  const behind = formatMigrationDriftAlert("db-behind", "0071", withHole);
  assert(behind.includes("0032"), "db-behind alert names the missing version (0032)");
  assert(
    /db push|apply/i.test(behind),
    "db-behind alert says what to do (apply the pending migration)",
  );
  assert(!/[\u2014\u2013]/.test(behind), "db-behind alert has no em/en dash (copy lint)");
}
{
  // Trailing behind: the missing versions are those between applied-max and shipped.
  const behind = formatMigrationDriftAlert("db-behind", "0071", fullSet(70));
  assert(behind.includes("0071"), "trailing db-behind alert names the missing 0071");
}

const unverified = formatMigrationDriftAlert("unverified", "0071", null);
assert(
  /could not|unable|cannot/i.test(unverified),
  "unverified alert says the version could not be read, not that things are fine",
);
assert(unverified.includes("0071"), "unverified alert still names the shipped version");
assert(!/[\u2014\u2013]/.test(unverified), "unverified alert has no em/en dash (copy lint)");

// Quiet statuses send nothing.
assert(formatMigrationDriftAlert("in-sync", "0071", fullSet(71)) === "", "in-sync sends nothing");
assert(
  formatMigrationDriftAlert("db-ahead", "0070", fullSet(71)) === "",
  "db-ahead sends nothing",
);

// --- runner (hand-written fakes, no module mocking) --------------------------
interface Sent {
  key: string;
  cooldownMs: number;
  text: string;
}

function harness(opts: {
  applied?: string[] | null;
  readThrows?: boolean;
  notifyThrows?: boolean;
  shipped?: string;
}) {
  const sent: Sent[] = [];
  const run = () =>
    runMigrationDriftCheck({
      shippedVersion: opts.shipped ?? "0071",
      readAppliedVersions: async () => {
        if (opts.readThrows) throw new Error("rpc applied_migration_versions does not exist");
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
  const { run, sent } = harness({ applied: fullSet(71) });
  const status = await run();
  assert(status === "in-sync" && sent.length === 0, "in-sync run alerts nothing");
}

{
  const { run, sent } = harness({ applied: fullSet(72) });
  const status = await run();
  assert(
    status === "db-ahead" && sent.length === 0,
    "db-ahead (migration applied before the deploy lands) is quiet, not an alert",
  );
}

{
  const { run, sent } = harness({ applied: fullSet(71).filter((v) => v !== "0032") });
  const status = await run();
  assert(status === "db-behind", "#814 middle-gap run reports db-behind");
  assert(sent.length === 1, "db-behind run sends exactly one alert");
  assert(sent[0].key === MIGRATION_VERSION_LAG_KEY, "alert uses the throttled lag key");
  assert(sent[0].cooldownMs === 60 * 60_000, "alert passes the caller's cooldown through");
  assert(sent[0].text.includes("0032"), "alert names the missing version");
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
  const { run, sent } = harness({
    applied: fullSet(71).filter((v) => v !== "0032"),
    notifyThrows: true,
  });
  const status = await run();
  assert(
    status === "db-behind" && sent.length === 1,
    "a throwing notify is swallowed: the check still returns its status",
  );
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

// The load test guard's secret lists still match the deployment's own inventory
// (#2335).
//
// `PRODUCTION_ONLY_SECRETS` is what a load test build is refused for carrying, so
// a name missing from it is a credential the guard will happily serve. Nothing in
// the app can notice that: the refusal stays silent and reads exactly like a clean
// deployment (L98). This is what notices, by deriving the list from DEPLOY.md's
// `wrangler secret put` lines and failing on any name neither list claims.
//
// Run: node --experimental-strip-types scripts/test-loadtest-secret-inventory.ts
import { readFileSync } from "node:fs";
import {
  LOADTEST_ALLOWED_SECRETS,
  PRODUCTION_ONLY_SECRETS,
} from "../src/lib/loadtest-secrets.ts";
import { deploySecretNames, partitionDeploySecrets } from "./lib/scan-deploy-secrets.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- positive controls, first -------------------------------------------------
//
// A comparison between a file and a constant is satisfied by reading NOTHING out
// of the file: an empty inventory classifies perfectly and reads as agreement
// (L98). So the planted cases run before the real one.

{
  const planted = `
### Secrets
wrangler secret put SUPABASE_SECRET_KEY   # required
wrangler secret put A_BRAND_NEW_SECRET    # added by somebody today
`;
  const p = partitionDeploySecrets(planted, ["SUPABASE_SECRET_KEY"], ["SLACK_BOT_TOKEN"]);
  eq(p.unclassified.join(","), "A_BRAND_NEW_SECRET", "a secret nobody classified is caught");
  eq(p.stale.join(","), "SLACK_BOT_TOKEN", "and one the runbook no longer names is caught");
}

{
  const planted = "wrangler secret put CRON_SECRET\n";
  const p = partitionDeploySecrets(planted, ["CRON_SECRET"], ["CRON_SECRET"]);
  eq(p.overlapping.join(","), "CRON_SECRET", "a name on both lists at once is caught");
}

{
  // A commented line still counts: the rotation key is not set today, which is
  // exactly why leaving it unclassified would exempt it.
  eq(
    deploySecretNames("# wrangler secret put BOOKING_API_KEY_2  # only when rotating").join(","),
    "BOOKING_API_KEY_2",
    "a commented secret line is part of the inventory",
  );
  eq(
    deploySecretNames("set the SLACK_BOT_TOKEN by hand").length,
    0,
    "and prose mentioning a name is not, so the scan reads commands rather than words",
  );
}

// --- the real comparison ------------------------------------------------------

{
  const deployMd = readFileSync("DEPLOY.md", "utf8");
  const p = partitionDeploySecrets(deployMd, LOADTEST_ALLOWED_SECRETS, PRODUCTION_ONLY_SECRETS);

  // Read something, or the three checks below are about an empty set.
  assert(
    p.inventory.length >= 20,
    `DEPLOY.md names ${p.inventory.length} secrets, which is too few to be the real inventory: ` +
      `the scan is reading the wrong file or the wrong shape`,
  );
  eq(
    p.unclassified.join(", "),
    "",
    "every secret DEPLOY.md names is either one of the load run's three or refused as production-only",
  );
  eq(
    p.stale.join(", "),
    "",
    "and nothing is refused that the runbook no longer names, which would read as a live rule about a dead setting",
  );
  eq(p.overlapping.join(", "), "", "and no name is permitted and refused at once");
}

finish();

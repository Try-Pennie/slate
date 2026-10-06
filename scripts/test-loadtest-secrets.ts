// The credential refusal: a load test build carrying production's own settings
// (#2335).
//
// The third refusal, and the one the other two structurally cannot catch. A build
// that baked production's `.env.local` into its bundle is pointed at the right
// branch and answering on the right address, so `loadtestPointedAtProduction` and
// `loadtestServingProductionHost` are both correctly silent while the deployment
// holds a live Slack token. On 2026-09-14 one paged the real alerts channel for six
// minutes about a roster that did not exist.
//
// Run: node --experimental-strip-types scripts/test-loadtest-secrets.ts
import { readFileSync } from "node:fs";
import {
  LOADTEST_ALLOWED_SECRETS,
  LOADTEST_DIAGNOSTIC_PATHS,
  PRODUCTION_ONLY_SECRETS,
  bakedSettingsForMode,
  loadtestCarryingProductionSecrets,
  LOADTEST_IDLE_ERROR,
  loadtestEntryRefusal,
  loadtestIdle,
  loadtestIdleBody,
  productionSecretsPresent,
} from "../src/lib/loadtest-secrets.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- the production-secret refusal (#2335) ------------------------------------
//
// The third refusal, and the one the other two could not have caught. A load test
// build carrying production's own credentials is pointed at the right database and
// answering on the right hostname: both guards above are correctly silent while the
// deployment holds a live Slack token and pages a real channel about a synthetic
// roster.

{
  // The quiet case, and the one that matters most: production holds every one of
  // these by design, and runs this on every request. If it ever went the other way
  // the whole product would refuse itself.
  const productionEnv: Record<string, string> = {};
  for (const name of PRODUCTION_ONLY_SECRETS) productionEnv[name] = "a real value";
  eq(
    loadtestCarryingProductionSecrets({ loadtest: false, env: productionEnv }),
    null,
    "production holding every production secret is not refused",
  );
}

{
  // The load test deployment's own three, and nothing else. This is what a correct
  // run looks like, so a guard that refused here would refuse every load run.
  eq(
    loadtestCarryingProductionSecrets({
      loadtest: true,
      env: {
        SUPABASE_SECRET_KEY: "the branch's key",
        CRON_SECRET: "a throwaway",
        BOOKING_API_KEY: "a throwaway",
        SLATE_LOADTEST: "true",
      },
    }),
    null,
    "a load test holding only its own three secrets is served",
  );
}

{
  const why = loadtestCarryingProductionSecrets({
    loadtest: true,
    env: { SUPABASE_SECRET_KEY: "the branch's key", SLACK_BOT_TOKEN: "xoxb-not-a-real-token" },
  });
  assert(why !== null, "a load test build carrying a production Slack token is refused");
  assert(why!.includes("SLACK_BOT_TOKEN"), "and the refusal NAMES the offender");
  // The message is logged and answered to a caller, so it may never carry the
  // value it found. Naming the variable is what somebody acts on; printing its
  // contents would put the credential in a transcript (L222).
  assert(
    !why!.includes("xoxb-not-a-real-token"),
    "and never the value, which would put the credential in the logs it is read from",
  );
  // The same environment with the flag off passed above, so this refusal is about
  // the flag AND the secret together rather than about either alone.
  eq(
    loadtestCarryingProductionSecrets({
      loadtest: false,
      env: { SLACK_BOT_TOKEN: "xoxb-not-a-real-token" },
    }),
    null,
    "and the same token in production is untouched",
  );
}

{
  // Every offender, not the first one. A build contaminated by a copied .env.local
  // carries two dozen at once, and a message naming one of them reads as a single
  // stray setting somebody can unset, which is the wrong repair entirely.
  const why = loadtestCarryingProductionSecrets({
    loadtest: true,
    env: {
      SLACK_BOT_TOKEN: "x",
      GOOGLE_SA_PRIVATE_KEY: "x",
      SF_CLIENT_SECRET: "x",
      BOOKING_API_KEY: "the run's own",
    },
  });
  assert(why !== null, "several offenders are refused");
  for (const name of ["SLACK_BOT_TOKEN", "GOOGLE_SA_PRIVATE_KEY", "SF_CLIENT_SECRET"]) {
    assert(why!.includes(name), `and the refusal names ${name}`);
  }
  // Asserted on the offender list rather than on the whole message, which names
  // the three permitted secrets as the RULE: a message that TALKS about a name is
  // not a message accusing it (L103), and "BOOKING_API_KEY" is also a substring of
  // "BOOKING_API_KEY_2".
  const offenders = productionSecretsPresent({
    SLACK_BOT_TOKEN: "x",
    GOOGLE_SA_PRIVATE_KEY: "x",
    SF_CLIENT_SECRET: "x",
    BOOKING_API_KEY: "the run's own",
  });
  assert(
    !offenders.includes("BOOKING_API_KEY"),
    "and never accuses one of the three the run legitimately holds",
  );
  eq(offenders.length, 3, "exactly the three offenders, nothing swept in beside them");
}

{
  // An empty value is an unset one. Wrangler answers an unset binding as absent and
  // a shell exports an empty string the same way; every reader in the app treats
  // "" as not configured (`slackConfigured` is `length > 0`), so a guard that
  // called it present would refuse a deployment that can reach nothing.
  eq(
    loadtestCarryingProductionSecrets({
      loadtest: true,
      env: { SLACK_BOT_TOKEN: "", GOOGLE_SA_PRIVATE_KEY: "   ", SF_CLIENT_SECRET: undefined },
    }),
    null,
    "an empty or whitespace value is absent, not present",
  );
}

{
  // The two lists are one decision and must not overlap: a name on both would be
  // refused and permitted at once, and whichever check ran first would decide.
  for (const allowed of LOADTEST_ALLOWED_SECRETS) {
    assert(
      !(PRODUCTION_ONLY_SECRETS as readonly string[]).includes(allowed),
      `${allowed} is what the run holds, so it cannot also be production-only`,
    );
  }
  assert(
    PRODUCTION_ONLY_SECRETS.length > 10,
    "and the production-only list is the deployment's real secret inventory, not a token few",
  );
}

// --- where it is ASKED: the Worker entry ---------------------------------------
//
// Two sources and neither answers the other: a credential baked into the bundle by
// the build, and one put on the environment by hand. And it must be answerable on
// the FIRST request, which is why it reads the bindings and the baked file directly
// rather than `process.env`, which the generated handler has not populated yet.

const BAKED_WITH_SECRET = {
  production: { SLACK_BOT_TOKEN: "xoxb-baked", NEXT_PUBLIC_APP_URL: "https://x" },
  development: {},
  test: {},
};

{
  // The quiet direction first: production never reaches any of this.
  eq(
    loadtestEntryRefusal({
      loadtest: false,
      pathname: "/api/bookings",
      bindings: { SLACK_BOT_TOKEN: "a real token" },
      baked: BAKED_WITH_SECRET,
    }),
    null,
    "production is never refused, whatever it is holding",
  );
}

{
  const why = loadtestEntryRefusal({
    loadtest: true,
    pathname: "/api/bookings",
    bindings: { SUPABASE_SECRET_KEY: "the branch's" },
    baked: BAKED_WITH_SECRET,
  });
  assert(why !== null, "a credential BAKED into the bundle refuses the request");
  assert(why!.includes("SLACK_BOT_TOKEN"), "and is named");
}

{
  const why = loadtestEntryRefusal({
    loadtest: true,
    pathname: "/api/bookings",
    bindings: { SLACK_BOT_TOKEN: "put here by hand" },
    baked: { production: {}, development: {}, test: {} },
  });
  assert(why !== null, "and so does one set on the environment by hand");
  assert(why!.includes("SLACK_BOT_TOKEN"), "and is named");
}

{
  // A name set BOTH ways is one setting. Counting it twice would report two.
  const why = loadtestEntryRefusal({
    loadtest: true,
    pathname: "/api/bookings",
    bindings: { SLACK_BOT_TOKEN: "a binding" },
    baked: BAKED_WITH_SECRET,
  });
  assert(why !== null, "a setting carried both ways still refuses");
  assert(why!.includes("1 of production"), `and is counted once, got ${why}`);
}

{
  // A clean load test deployment serves, or there would be no load runs at all.
  eq(
    loadtestEntryRefusal({
      loadtest: true,
      pathname: "/api/bookings",
      bindings: { SUPABASE_SECRET_KEY: "x", CRON_SECRET: "y", BOOKING_API_KEY: "z" },
      baked: { production: { NEXT_PUBLIC_APP_URL: "https://x" }, development: {}, test: {} },
    }),
    null,
    "a clean load test deployment serves",
  );
}

{
  // A scheduled tick has no path at all, and must still refuse: the lanes are what
  // reached Slack on 2026-09-14, not a request somebody made.
  const why = loadtestEntryRefusal({
    loadtest: true,
    pathname: undefined,
    bindings: {},
    baked: BAKED_WITH_SECRET,
  });
  assert(why !== null, "a cron tick with no path is refused too");
}

{
  // The one exemption, and it earns itself: this is how the run learns WHAT is
  // wrong. Refusing it would leave the preflight reporting a 503 about the one
  // request that could have named the settings instead (L11).
  for (const path of LOADTEST_DIAGNOSTIC_PATHS) {
    eq(
      loadtestEntryRefusal({
        loadtest: true,
        pathname: path,
        bindings: { SLACK_BOT_TOKEN: "x" },
        baked: BAKED_WITH_SECRET,
      }),
      null,
      `${path} still answers, so the preflight can say what is wrong`,
    );
  }
  // A base URL with a trailing slash produces a doubled one, and losing the
  // exemption there would cost the run its only readable diagnosis for a reason
  // nobody would look for.
  for (const spelling of ["/api/smoke/version/", "//api/smoke/version"]) {
    eq(
      loadtestEntryRefusal({
        loadtest: true,
        pathname: spelling,
        bindings: { SLACK_BOT_TOKEN: "x" },
        baked: BAKED_WITH_SECRET,
      }),
      null,
      `${spelling} reaches the same exemption`,
    );
  }
  // And the exemption is a PATH, not a prefix: a route underneath it is refused.
  assert(
    loadtestEntryRefusal({
      loadtest: true,
      pathname: "/api/smoke/version/../../bookings",
      bindings: { SLACK_BOT_TOKEN: "x" },
      baked: BAKED_WITH_SECRET,
    }) !== null,
    "and nothing else under that prefix is exempt",
  );
}

{
  // The mode the runtime would apply, not always production.
  eq(
    Object.keys(bakedSettingsForMode(BAKED_WITH_SECRET, "development")).length,
    0,
    "the development mode's own object is read when NEXTJS_ENV names it",
  );
  eq(
    Object.keys(bakedSettingsForMode(BAKED_WITH_SECRET, undefined)).length,
    2,
    "and production is the default, as it is in the runtime",
  );
  // Unreadable is empty rather than a throw: this half is a second source beside
  // the bindings, and the BUILD already refuses a file it cannot read.
  eq(Object.keys(bakedSettingsForMode(null, "production")).length, 0, "an absent file is empty");
  eq(Object.keys(bakedSettingsForMode("nonsense", "production")).length, 0, "and so is a broken one");
}

// --- idle between runs (#3310) --------------------------------------------------
//
// The load test Worker lives on between runs so Cloudflare keeps delivering its crons,
// and teardown takes its three secrets away instead of deleting it. A deployment
// missing ANY of them is idle: it answers nothing and runs no lane, rather than
// running every lane each minute for each one to fail on the missing secret. Judged
// on the same view of the settings `populateProcessEnv` builds: the baked file, then
// the bindings over it.

{
  const all = { SUPABASE_SECRET_KEY: "k", CRON_SECRET: "c", BOOKING_API_KEY_CANARY: "b" };
  const none = { production: {}, development: {}, test: {} };
  eq(loadtestIdle({ loadtest: false, bindings: {}, baked: none }), null, "production is never idle, whatever it holds");
  eq(loadtestIdle({ loadtest: true, bindings: all, baked: none }), null, "a load test deployment holding all three is serving a run");
  eq(loadtestIdle({ loadtest: true, bindings: {}, baked: none }), [...LOADTEST_ALLOWED_SECRETS], "one holding none is idle and names all three");
  eq(
    loadtestIdle({ loadtest: true, bindings: { SUPABASE_SECRET_KEY: "k", CRON_SECRET: "c" }, baked: none }),
    ["BOOKING_API_KEY_CANARY"],
    "a half provisioned one is idle too, naming only what it lacks, so a run cannot start on it",
  );
  eq(loadtestIdle({ loadtest: true, bindings: { ...all, CRON_SECRET: "" }, baked: none }), ["CRON_SECRET"], "an empty value is no credential");
  eq(loadtestIdle({ loadtest: true, bindings: { ...all, CRON_SECRET: "  " }, baked: none }), ["CRON_SECRET"], "nor is one of only spaces");
  eq(loadtestIdle({ loadtest: true, bindings: { ...all, CRON_SECRET: {} }, baked: none }), ["CRON_SECRET"], "nor a binding that is not a string");
  eq(
    loadtestIdle({ loadtest: true, bindings: { SUPABASE_SECRET_KEY: "k", CRON_SECRET: "c" }, baked: { production: { BOOKING_API_KEY_CANARY: "b" }, development: {}, test: {} } }),
    null,
    "a value the build baked counts, exactly as the app will read it",
  );
  // The diagnostic path is exempt from the production refusal so a contaminated
  // deployment can still SAY which production secrets it holds, on a key authed
  // endpoint. Idle must not take that away: a deployment holding production secrets
  // and missing a run secret is a contamination first, so the endpoint answers it.
  const contaminated = { SLACK_BOT_TOKEN: "production's", SUPABASE_SECRET_KEY: "k", BOOKING_API_KEY_CANARY: "b" };
  eq(
    loadtestIdle({ loadtest: true, bindings: contaminated, baked: none, pathname: "/api/smoke/version" }),
    null,
    "a contaminated deployment is not answered as idle on the diagnostic path, which then names the contamination",
  );
  eq(
    loadtestIdle({ loadtest: true, bindings: { SUPABASE_SECRET_KEY: "k", BOOKING_API_KEY_CANARY: "b" }, baked: none, pathname: "/api/smoke/version" }),
    ["CRON_SECRET"],
    "a clean one missing a run secret is still idle there, so a run one secret short stops with the name",
  );
  eq(
    loadtestIdle({ loadtest: true, bindings: contaminated, baked: none, pathname: "/api/smoke//version/" }),
    null,
    "spelled with stray slashes, as the production refusal reads it",
  );
  const body = loadtestIdleBody(["CRON_SECRET"]);
  eq(body, { error: LOADTEST_IDLE_ERROR, missing: ["CRON_SECRET"] }, "the idle answer names what is missing, for the preflight to quote");
  assert(!JSON.stringify(body).includes("=c"), "and carries names, never a value");
}

// --- and it is WIRED into the entry (L3) ---------------------------------------
//
// The entry cannot be imported here: it imports two build artifacts that only exist
// after `opennextjs-cloudflare build`. So this reads it as text, which is enough to
// say the refusal is reached on both surfaces rather than only written.

{
  const entry = readFileSync("worker/index.ts", "utf8");
  assert(
    entry.includes("loadtestEntryRefusal"),
    "worker/index.ts asks for the refusal, or it is written and never reached",
  );
  assert(
    entry.includes("next-env.mjs"),
    "and imports the adapter's baked env file, which is the source the bindings cannot show it",
  );
  // Both surfaces. The cron lanes are what actually paged the real channel, so an
  // entry that guarded only `fetch` would have missed the incident it exists for.
  const fetchHalf = entry.slice(entry.indexOf("fetch:"), entry.indexOf("async scheduled"));
  const scheduledHalf = entry.slice(entry.indexOf("async scheduled"));
  assert(fetchHalf.includes("loadtestEntryRefusal"), "the fetch handler asks it");
  assert(scheduledHalf.includes("loadtestEntryRefusal"), "and so does the scheduled handler");
  // #3310: idle on both surfaces too, and asked AFTER the production refusal, which is
  // the louder finding: a deployment holding production's secrets is an incident
  // whatever else it lacks.
  for (const [half, name] of [[fetchHalf, "fetch"], [scheduledHalf, "scheduled"]] as const) {
    const refusal = half.indexOf("loadtestEntryRefusal(");
    const idle = half.indexOf("loadtestIdle(");
    assert(idle > -1, `the ${name} handler asks whether the deployment is idle`);
    assert(refusal > -1 && idle > refusal, `and asks it after the production refusal in ${name}`);
  }
  // The fetch path hands idle the request's path, or the diagnostic path's exemption
  // for a contaminated deployment never applies (#3310).
  const fetchIdleCall = fetchHalf.slice(fetchHalf.indexOf("loadtestIdle("), fetchHalf.indexOf(");", fetchHalf.indexOf("loadtestIdle(")));
  assert(/pathname: safePathname\(request\.url\)/.test(fetchIdleCall), `the fetch handler passes the request path to idle (got ${fetchIdleCall})`);
  // Before the app is reached, or an idle request pays for Next's start and a lane runs.
  assert(fetchHalf.indexOf("loadtestIdle(") < fetchHalf.indexOf("app.fetch("), "the idle answer comes before the app is reached");
  assert(scheduledHalf.indexOf("loadtestIdle(") < scheduledHalf.indexOf("routesForCron("), "and before any lane is resolved");
  // The log shipping receipt is the third surface that reaches the app (#3182). It got
  // the production refusal with the lanes, and an idle Worker must not run it either:
  // it would reach a heartbeat write with no secret to authorise it.
  const receipt = entry.slice(entry.indexOf("class LogShippingReceipt"));
  const receiptRefusal = receipt.indexOf("loadtestEntryRefusal(");
  const receiptIdle = receipt.indexOf("loadtestIdle(");
  assert(receiptIdle > -1 && receiptIdle > receiptRefusal, "the log shipping receipt asks whether the deployment is idle, after the production refusal");
  assert(receiptIdle < receipt.indexOf("forwardReceipt("), "and before it forwards anything to the app");
}

finish();

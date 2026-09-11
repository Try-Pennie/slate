// The two refusals that keep a load test deployment away from production (#2242).
//
// Both directions on every one of them (L1, L159): a guard only ever seen to stay
// quiet is satisfied by a guard hard wired to stay quiet, and the quiet case here
// is production, which runs through this code on every single request.
//
// Run: node --experimental-strip-types scripts/test-loadtest-guard.ts
import {
  PRODUCTION_SUPABASE_REF,
  PRODUCTION_HOST,
  loadtestPointedAtProduction,
  loadtestServingProductionHost,
} from "../src/lib/loadtest-guard.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const PROD_URL = `https://${PRODUCTION_SUPABASE_REF}.supabase.co`;
const BRANCH_URL = "https://abcdefghijklmnopqrst.supabase.co";

// --- the database refusal -----------------------------------------------------

{
  // The quiet case, and the one that matters most: production is not a load test,
  // so it never consults the ref at all. If this ever went the other way, every
  // real request would be refused by a guard meant only to stop a load run.
  eq(
    loadtestPointedAtProduction({ loadtest: false, supabaseUrl: PROD_URL }),
    null,
    "production pointed at production is not refused",
  );
  eq(
    loadtestPointedAtProduction({ loadtest: false, supabaseUrl: undefined }),
    null,
    "and neither is production with no address readable here",
  );
}

{
  const why = loadtestPointedAtProduction({ loadtest: true, supabaseUrl: PROD_URL });
  assert(why !== null, "a load test build pointed at production is refused");
  assert(
    why!.includes(PRODUCTION_SUPABASE_REF),
    "and the refusal names the project ref, so the reader can check it themselves",
  );
  // The same URL with the flag off passed above, so this refusal is about the
  // flag AND the ref together rather than about either one alone.
  eq(
    loadtestPointedAtProduction({ loadtest: true, supabaseUrl: BRANCH_URL }),
    null,
    "a load test build pointed at a branch is served",
  );
}

{
  // "Cannot tell" is its own message and still refuses (L11, L98). An empty address
  // under load test is the one value that decides where six hundred bookings land.
  for (const [label, value] of [
    ["absent", undefined],
    ["empty", ""],
    ["whitespace", "   "],
  ] as const) {
    const why = loadtestPointedAtProduction({ loadtest: true, supabaseUrl: value });
    assert(why !== null, `a load test build with an ${label} address is refused`);
    assert(
      !why!.includes(PRODUCTION_SUPABASE_REF),
      `and the ${label} case does not claim it saw the production ref`,
    );
  }
  // The two refusals do not share wording, so a reader is never sent to check a
  // ref the check never read.
  const missing = loadtestPointedAtProduction({ loadtest: true, supabaseUrl: "" })!;
  const prod = loadtestPointedAtProduction({ loadtest: true, supabaseUrl: PROD_URL })!;
  assert(missing !== prod, "the two database refusals say different things");
}

{
  // The ref is matched anywhere in the address on purpose: a branch of the
  // production project carries the parent ref in its own hostname, and a load run
  // against one is the accident this exists to stop.
  const why = loadtestPointedAtProduction({
    loadtest: true,
    supabaseUrl: `https://${PRODUCTION_SUPABASE_REF}.supabase.co/rest/v1`,
    });
  assert(why !== null, "a production address carrying a path is still refused");
}

// --- the hostname refusal -----------------------------------------------------

{
  eq(
    loadtestServingProductionHost({ loadtest: false, url: `https://${PRODUCTION_HOST}/api/health` }),
    null,
    "production answering on its own hostname is not refused",
  );
  const why = loadtestServingProductionHost({
    loadtest: true,
    url: `https://${PRODUCTION_HOST}/api/health`,
  });
  assert(why !== null, "a load test build answering on the production hostname is refused");
  assert(why!.includes(PRODUCTION_HOST), "and the refusal names the hostname");
  eq(
    loadtestServingProductionHost({
      loadtest: true,
      url: "https://slate-loadtest.workers.dev/api/health",
    }),
    null,
    "a load test build on its own workers.dev address is served",
  );
}

{
  // Judged on the HOST, never a substring of the whole URL. A request carrying the
  // production hostname in a path or a query did not arrive on it, and refusing it
  // would take the load run down for a reason nobody could find.
  eq(
    loadtestServingProductionHost({
      loadtest: true,
      url: `https://slate-loadtest.workers.dev/book?next=https://${PRODUCTION_HOST}/x`,
    }),
    null,
    "the production hostname inside a query string is not arriving on it",
  );
  eq(
    loadtestServingProductionHost({
      loadtest: true,
      url: `https://evil.example.com/${PRODUCTION_HOST}`,
    }),
    null,
    "and neither is it inside a path",
  );
  // Case is not a difference in a hostname.
  assert(
    loadtestServingProductionHost({
      loadtest: true,
      url: `https://${PRODUCTION_HOST.toUpperCase()}/api/health`,
    }) !== null,
    "the hostname is matched without regard to case",
  );
}

{
  // An unreadable URL fails CLOSED and says so in its own words. A Worker's
  // request.url is always absolute, so this is unreachable in practice, which is
  // why refusing is free: production never reaches this function at all, so the
  // worst a refusal can do is stop a load run.
  const why = loadtestServingProductionHost({ loadtest: true, url: "not a url" });
  assert(why !== null, "an unreadable URL is refused rather than served");
  assert(why!.includes("could not be read"), "and says the URL could not be read");
  assert(
    !why!.includes(PRODUCTION_HOST),
    "rather than claiming it saw the production hostname it never parsed",
  );
  // And it is still silent when the flag is off, which is every production request.
  eq(
    loadtestServingProductionHost({ loadtest: false, url: "not a url" }),
    null,
    "production is untouched by an unreadable URL",
  );
}

finish();

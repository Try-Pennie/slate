// Where Cloudflare runs the Worker, judged as WRANGLER RESOLVES IT (#3693).
//
// Slate is placed with an explicit Placement Hint naming the cloud region its
// Supabase database lives in, not with Smart Placement. Smart Placement was tried
// first (#3720) and never moved the cron lanes near the database: the lane timings
// line read `local-BOM` or no header at all, and Supabase's edge logs showed the
// lane traffic going from Mumbai to Stockholm, never to Seattle beside Oregon. So
// the hint is a decision with evidence behind it, and an edit back to `smart`, or
// to a region the database is not in, must fail here rather than be found later in
// the Supabase origin times.
//
// Resolved through wrangler rather than read out of the file, because `placement`
// INHERITS into a named environment (measured: with no `placement` in
// env.loadtest, wrangler resolves the top level's), and only wrangler can say what
// an environment actually deploys with.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-worker-placement.ts
import { unstable_readConfig } from "wrangler";
import { DATABASE_PLACEMENT_REGION, placementFaults } from "./lib/worker-placement.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const CONFIG = "wrangler.jsonc";

function placementOf(env?: string): unknown {
  return (unstable_readConfig({ config: CONFIG, env }) as unknown as { placement?: unknown }).placement;
}

// --- the real thing -----------------------------------------------------------

eq(DATABASE_PLACEMENT_REGION, "aws:us-west-2", "the database's region is AWS us-west-2 (Supabase West US, Oregon)");

for (const [label, env] of [
  ["production", undefined],
  ["env.loadtest", "loadtest"],
] as const) {
  const faults = placementFaults(label, placementOf(env));
  eq(faults.join("; "), "", `${label} resolves to the Placement Hint ${DATABASE_PLACEMENT_REGION}`);
}

// --- positive controls: each wrong placement is named --------------------------
//
// A judge only ever seen quiet over one config is satisfied by a judge that cannot
// speak (L1), so each way the block can go wrong is fed to it and must be refused.

{
  const smart = placementFaults("x", { mode: "smart" });
  assert(smart.length > 0, "Smart Placement is refused");
  assert(/smart/i.test(smart.join(" ")), `and the refusal names Smart Placement (got ${smart.join("; ")})`);
}
{
  const wrong = placementFaults("x", { region: "aws:us-east-1" });
  assert(wrong.length > 0, "a hint naming a region the database is not in is refused");
  assert(wrong.join(" ").includes("aws:us-east-1"), "and the refusal names the region it found");
}
{
  assert(placementFaults("x", undefined).length > 0, "no placement at all is refused, since every request would run by the visitor");
  assert(placementFaults("x", { mode: "off" }).length > 0, "placement switched off is refused");
}
{
  const host = placementFaults("x", { host: "db.drukfvgaynzrralbzkzj.supabase.co:5432" });
  assert(host.length > 0, "a host probe instead of the region hint is refused (experimental per the docs, and not what was decided)");
}
{
  // wrangler's schema accepts `mode: "targeted"` beside a region, which means the same
  // hint, so it is not a fault; anything else beside the region is.
  eq(placementFaults("x", { mode: "targeted", region: "aws:us-west-2" }).join("; "), "", "the targeted spelling of the same hint passes");
  assert(placementFaults("x", { region: "aws:us-west-2", hostname: "api.example.com" }).length > 0, "a second key beside the region is refused");
}

finish();

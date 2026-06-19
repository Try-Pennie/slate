// Tripwire for the production cron wiring: every cron expression configured
// in wrangler.jsonc must have a route in worker/cron-routes.ts and vice versa,
// and the routes must be real cron endpoints. A drift here means a schedule
// silently does nothing in production (the exact failure this setup fixes).
// Run: node --experimental-strip-types scripts/test-cron-routes.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CRON_ROUTES, routesForCron } from "../worker/cron-routes.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

const root = join(import.meta.dirname, "..");
const wrangler = readFileSync(join(root, "wrangler.jsonc"), "utf8")
  // strip // comments so JSON.parse can handle the jsonc
  .replace(/^\s*\/\/.*$/gm, "");
const config = JSON.parse(wrangler) as {
  main?: string;
  triggers?: { crons?: string[] };
};

const configured = config.triggers?.crons ?? [];
const routed = Object.keys(CRON_ROUTES);

assert(configured.length > 0, "wrangler.jsonc declares cron triggers");
for (const cron of configured) {
  assert(
    routesForCron(cron).length > 0,
    `configured cron "${cron}" has at least one route in CRON_ROUTES`,
  );
}
for (const cron of routed) {
  assert(
    configured.includes(cron),
    `routed cron "${cron}" is configured in wrangler.jsonc triggers`,
  );
}

assert(
  config.main === "worker/index.ts",
  "wrangler main is the custom entry that handles scheduled()",
);

// A cron expression may now drive MORE THAN ONE route (independent lanes with
// their own locks). Every routed path must still map to a real route file.
for (const [cron, value] of Object.entries(CRON_ROUTES)) {
  const paths = Array.isArray(value) ? value : [value];
  for (const path of paths) {
    const routeFile = join(root, "src/app", path.replace(/^\//, ""), "route.ts");
    assert(
      existsSync(routeFile),
      `"${cron}" -> ${path} maps to a real route file`,
    );
  }
}

// The every-minute trigger fans out to TWO independent lanes: backstop sync and
// bucket recompute. Splitting them (each under its own lock) stops a busy sync
// tick from starving the slot refresh (#273).
{
  const minute = routesForCron("* * * * *");
  assert(
    minute.includes("/api/cron/sync"),
    "* * * * * drives the backstop sync lane",
  );
  assert(
    minute.includes("/api/cron/recompute"),
    "* * * * * drives the bucket-recompute lane",
  );
}

assert(routesForCron("0 0 31 2 *").length === 0, "unknown cron expressions route to nothing");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

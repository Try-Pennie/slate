// Tripwire for the production cron wiring: every cron expression configured
// in wrangler.jsonc must have a route in worker/cron-routes.ts and vice versa,
// and the routes must be real cron endpoints. A drift here means a schedule
// silently does nothing in production (the exact failure this setup fixes).
// Run: node --experimental-strip-types scripts/test-cron-routes.ts
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CRON_ROUTES, routesForCron } from "../worker/cron-routes.ts";
import { assert, finish } from "./lib/harness.ts";

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
  assert(
    minute.includes("/api/cron/outbox"),
    "* * * * * drives the booking-outbox drain lane (#429)",
  );
  assert(
    minute.includes("/api/cron/selfheal"),
    "* * * * * drives the self-heal sweep lane (#433)",
  );
}

// Watch renewal moves off the 1-min tick onto its own */5 lane (watch TTL is
// days, not minutes), sharing the */5 trigger with the completion sweep (#273).
{
  const fiveMin = routesForCron("*/5 * * * *");
  assert(
    fiveMin.includes("/api/cron/complete"),
    "*/5 * * * * drives the completion sweep",
  );
  assert(
    fiveMin.includes("/api/cron/watch"),
    "*/5 * * * * drives the watch-renewal lane",
  );
}

// The Salesforce roster reconcile runs HOURLY through the single locked agents
// path (#267). Retiring the duplicate slate-cron worker removed the unlocked
// */15 salesforce trigger, and the daily 0 6 slot moved to hourly so a new hire
// becomes bookable-eligible within the hour rather than next day.
{
  const hourly = routesForCron("0 * * * *");
  assert(
    hourly.includes("/api/cron/agents"),
    "0 * * * * drives the hourly roster reconcile (single locked path)",
  );
  assert(
    routesForCron("0 6 * * *").length === 0,
    "the old daily 0 6 agents slot is retired",
  );
}

assert(routesForCron("0 0 31 2 *").length === 0, "unknown cron expressions route to nothing");

// #1713: the retention lanes gate on the export lane being current, and both used
// to fire at 03:00 exactly, so the gate read the mirror while the export tick it
// was judging was still working through six tables. Derived from the routes, not
// from the expressions, so a renamed cron is still checked.
{
  const cronFor = (route: string) =>
    Object.entries(CRON_ROUTES).find(([, r]) => (Array.isArray(r) ? r : [r]).includes(route))?.[0];
  const exportCron = cronFor("/api/cron/snowflake-export");
  assert(exportCron !== undefined, "the export lane has a cron");
  // The export's minutes, from either an every N form or a fixed list (#4349).
  const exportMinuteField = (exportCron ?? "").split(" ")[0] ?? "";
  const exportStep = Number(/^\*\/(\d+)$/.exec(exportMinuteField)?.[1]);
  const exportMinutes = Number.isInteger(exportStep) && exportStep > 0
    ? Array.from({ length: Math.ceil(60 / exportStep) }, (_, i) => i * exportStep)
    : exportMinuteField.split(",").map(Number);
  assert(exportMinutes.length > 0 && exportMinutes.every((m) => Number.isInteger(m) && m >= 0 && m < 60), `the export lane's minutes are readable (${exportCron})`);
  for (const route of ["/api/cron/prune-routing", "/api/cron/prune-webhook-payloads", "/api/cron/prune-bookings-pii"]) {
    const cron = cronFor(route);
    assert(cron !== undefined, `${route} has a cron`);
    const minute = Number(cron?.split(" ")[0]);
    assert(Number.isInteger(minute), `${route} fires at a fixed minute (${cron})`);
    assert(
      !exportMinutes.includes(minute),
      `${route} (${cron}) never fires on the export lane's own minute (${exportMinutes.join(", ")}), so the gate never reads mid tick`,
    );
  }
}

// --- Doc/runbook consistency guards (docs cluster #639/#642/#644) ---
// The setup + deploy docs drift out of sync with this file and wrangler.jsonc
// (an audit found README describing Vercel crons that no longer exist, and
// DEPLOY.md listing 3 of the 10 real lanes). Pin the docs to the code here so a
// future edit that reintroduces the drift fails CI instead of shipping.
const readme = readFileSync(join(root, "README.md"), "utf8");
const deploy = readFileSync(join(root, "DEPLOY.md"), "utf8");
const envExample = readFileSync(join(root, ".env.example"), "utf8");

// #639: crons run on Cloudflare (wrangler.jsonc triggers), never Vercel. No
// stale vercel.json / "Vercel Cron" wording may creep back into the docs.
for (const [name, text] of [
  ["README.md", readme],
  ["DEPLOY.md", deploy],
  [".env.example", envExample],
] as const) {
  assert(!/vercel\.json/i.test(text), `${name} has no stale vercel.json reference`);
  assert(!/vercel cron/i.test(text), `${name} has no stale "Vercel Cron" reference`);
}

// #644: DEPLOY.md is the ops runbook, so every cron lane in CRON_ROUTES must be
// named there, or a route is invisible to whoever debugs it in production.
for (const value of Object.values(CRON_ROUTES)) {
  const paths = Array.isArray(value) ? value : [value];
  for (const path of paths) {
    assert(deploy.includes(path), `DEPLOY.md documents cron lane ${path}`);
  }
}

// #642: one canonical production host in the runbook. slate.trypennie.app is
// live; wrangler.jsonc is the source of truth for the routes (it binds a second
// domain too), so the runbook names only the canonical host, never the .dev one.
assert(
  deploy.includes("slate.trypennie.app"),
  "DEPLOY.md names the canonical host slate.trypennie.app",
);
assert(
  !/slate\.trypennie\.dev/.test(deploy),
  "DEPLOY.md does not hardcode the non-canonical slate.trypennie.dev host",
);
// #750: the retired .dev host must not be bound as a route on the production
// Worker either. It never emitted a URL (manage links + OAuth use the .app
// NEXT_PUBLIC_APP_URL), so it only misleads. slate.trypennie.app is the sole host.
assert(
  !/slate\.trypennie\.dev/.test(wrangler),
  "wrangler.jsonc does not bind the retired slate.trypennie.dev host (#750)",
);

// #645: the README Layout block must map the real subsystem tree, not a stale
// subset (an audit found half the lib/ and app/ dirs missing). Assert every
// source subsystem dir is named in the Layout section so it can't silently rot.
const layout = (readme.match(/## Layout\n([\s\S]*?)(?:\n## |$)/)?.[1] ?? "");
assert(layout.length > 0, "README has a Layout section");
// Non-subsystem dirs legitimately absent from the map: a dev-preview harness
// and static font assets.
const LAYOUT_EXEMPT = new Set(["dev", "fonts"]);
for (const base of ["src/lib", "src/app"]) {
  for (const dir of readdirSync(join(root, base))) {
    if (LAYOUT_EXEMPT.has(dir)) continue;
    if (!statSync(join(root, base, dir)).isDirectory()) continue;
    assert(layout.includes(dir), `README Layout names ${base}/${dir}`);
  }
}
assert(/worker\//.test(layout), "README Layout names the worker/ dir");
assert(/scripts\//.test(layout), "README Layout names the scripts/ dir");

finish();

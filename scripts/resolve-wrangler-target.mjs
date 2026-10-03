// Print, as JSON, the Worker name and routes wrangler resolves for this checkout's
// wrangler.jsonc and WRANGLER_ENV (#3165), through wrangler's own config reader rather
// than a reading of the file, because environment inheritance (routes inherit, a name
// is derived) is exactly where a hand reading goes wrong.
//
// Run as its own process by scripts/deploy-gradual.ts and scripts/rollback-production.ts,
// which run on bare node and import nothing outside scripts/; this is the one place that
// loads wrangler. Exits non-zero, printing nothing on stdout, when it cannot resolve.
//
// Run: WRANGLER_ENV=loadtest node scripts/resolve-wrangler-target.mjs
import { join } from "node:path";
import { unstable_readConfig } from "wrangler";

const root = join(import.meta.dirname, "..");
// env-ok: WRANGLER_ENV (the load test rehearsal only; production is the top level)
const env = (process.env.WRANGLER_ENV ?? "").trim();
try {
  const cfg = unstable_readConfig(
    { config: join(root, "wrangler.jsonc"), ...(env ? { env } : {}) },
    { hideWarnings: true },
  );
  process.stdout.write(JSON.stringify({ name: cfg.name ?? null, routes: cfg.routes ?? [] }));
} catch (err) {
  console.error(`could not resolve the wrangler target: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

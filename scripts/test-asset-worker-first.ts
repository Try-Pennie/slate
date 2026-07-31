// Tripwire for the static-asset security wiring (#1203 / #1204).
//
// Cloudflare's asset binding answers a request for anything under `public/`
// WITHOUT invoking the Worker, so neither the #1024 https redirect
// (worker/index.ts) nor Next's global headers() ever ran for those files.
// Measured live 2026-07-31: http://slate.trypennie.app/widget.js returned 200
// with no Strict-Transport-Security, no X-Content-Type-Options and no
// Referrer-Policy, while /api/health returned a 308 and carried all three.
//
// The lever is `assets.run_worker_first` in wrangler.jsonc: a matching path is
// routed to this Worker first, so the redirect runs and OpenNext's asset
// resolver serves the file through the routing layer, which applies the
// next.config headers to it.
//
// This guard asserts the CONFIG covers every file we actually ship in public/.
// It deliberately does NOT claim to prove the headers appear on the wire: that
// is behavior, and it is asserted against the live site by the smoke canary
// (scripts/lib/https-redirect.ts, checkStaticAssetTransport in
// scripts/smoke-booking-api.ts). Config here, behavior there.
//
// Run: node --experimental-strip-types scripts/test-asset-worker-first.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
// The REAL matcher OpenNext compiles into the Worker, imported rather than
// reimplemented. A hand-rolled copy of the glob rules would happily agree with
// itself while the shipping matcher disagreed (L52), which is the whole failure
// mode this file exists to catch.
import { isUserWorkerFirst } from "../node_modules/@opennextjs/cloudflare/dist/api/overrides/asset-resolver/index.js";
import { assert, finish } from "./lib/harness.ts";

const root = join(import.meta.dirname, "..");

const config = JSON.parse(
  // strip // comments so JSON.parse can handle the jsonc
  readFileSync(join(root, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
) as { assets?: { run_worker_first?: boolean | string[] } };

const rules = config.assets?.run_worker_first;

assert(
  Array.isArray(rules) && rules.length > 0,
  "wrangler.jsonc scopes assets.run_worker_first to a path list (not `true`, which " +
    "would cost a Worker invocation for every hashed /_next/ build asset)",
);

/** Every file we ship in public/, as the path a browser requests it at. */
function publicAssetPaths(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...publicAssetPaths(full));
    // Split on the platform separator so a nested file becomes /brand/x.svg.
    else out.push("/" + relative(join(root, "public"), full).split(sep).join("/"));
  }
  return out;
}

const assets = publicAssetPaths(join(root, "public"));

// Positive control for the enumeration itself: an empty list would make every
// assertion below vacuously true, the exact "green while protecting nothing"
// shape this repo keeps hitting (L1).
assert(assets.length > 0, "public/ enumeration found files to check");
assert(
  assets.includes("/widget.js"),
  "public/ enumeration finds widget.js, the asset the issues are about",
);

for (const path of assets) {
  assert(
    isUserWorkerFirst(rules, path),
    `${path} is routed to the Worker first, so it gets the https redirect + security headers`,
  );
}

// The deliberate exclusion. Next's hashed build output is high-volume, immutable
// and always a subresource of an https page we already redirect, so paying a
// Worker invocation per request buys nothing. If someone flips run_worker_first
// to `true`, this fails and makes the cost explicit rather than silent.
for (const buildAsset of [
  "/_next/static/chunks/main-abc123.js",
  "/_next/static/css/abc123.css",
]) {
  assert(
    !isUserWorkerFirst(rules, buildAsset),
    `${buildAsset} still bypasses the Worker (hashed build output stays on the asset path)`,
  );
}

// Positive control: the per-asset assertion must FAIL with the rules removed, or
// it is decoration that would keep passing through a bad edit.
assert(
  !isUserWorkerFirst([], "/widget.js"),
  "positive control: with no rules configured, widget.js is NOT worker-first",
);

// The header half of the fix. Being worker-first only helps because next.config
// serves the hardening headers on a catch-all source; a narrower source would
// route the asset through the Worker and still ship it bare.
const nextConfig = readFileSync(join(root, "next.config.ts"), "utf8");
assert(
  /source:\s*"\/:path\*"/.test(nextConfig),
  "next.config headers() applies on a catch-all source, so a worker-served asset gets them",
);
for (const header of [
  "Strict-Transport-Security",
  "X-Content-Type-Options",
  "Referrer-Policy",
]) {
  assert(
    nextConfig.includes(header),
    `next.config headers() still serves ${header} (the header widget.js was missing)`,
  );
}

finish();

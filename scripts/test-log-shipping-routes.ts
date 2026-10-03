/**
 * #3105: every dynamic route under src/app is classified for the log shipper.
 *
 * The tail worker replaces a credential bearing path segment (a manage token, a
 * legacy advisor link token) before a URL leaves for Better Stack. That list is a
 * literal in `src/lib/log-shipping/redact.ts`, because the worker cannot read the
 * route tree at runtime, so this walks the tree and fails when the two disagree in
 * EITHER direction (L41, L96): a new `[param]` route cannot ship its value
 * unclassified, and a removed one cannot linger as apparent coverage. It also
 * checks each entry's static siblings against the tree, since those decide which
 * names under a redacted prefix are routes and must be kept.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-log-shipping-routes.ts
 */
import { join } from "node:path";
import { DYNAMIC_SEGMENT_POLICY } from "../src/lib/log-shipping/redact.ts";
import { dynamicRouteFaults, scanDynamicRoutes } from "./lib/scan-dynamic-routes.ts";
import { assert, eq, fail, finish } from "./lib/harness.ts";

const { routes, unsupported } = scanDynamicRoutes(join(import.meta.dirname, "..", "src", "app"));

assert(routes.length >= 5, `the walk found the dynamic routes (${routes.length}), so a clean result means something`);
assert(
  routes.some((r) => r.route === "/booking/manage/[token]"),
  "including the manage token route, the one that most needs redacting",
);
eq(unsupported.length, 0, "no route group, private folder or slot, which would put a route at a different URL");

{
  const faults = dynamicRouteFaults(routes, DYNAMIC_SEGMENT_POLICY);
  if (faults.length > 0) for (const f of faults) fail(f);
  else assert(true, "DYNAMIC_SEGMENT_POLICY and src/app agree in both directions");
}

for (const p of DYNAMIC_SEGMENT_POLICY) {
  assert(p.why.trim().length > 10, `${p.route} carries a reason for its classification`);
}

// --- positive controls: the judge must speak (L1) ----------------------------

{
  const extra = [...routes, { route: "/booking/confirm/[secret]", siblings: [] }];
  const faults = dynamicRouteFaults(extra, DYNAMIC_SEGMENT_POLICY);
  assert(
    faults.some((f) => f.includes("/booking/confirm/[secret]") && f.includes("no entry")),
    "a new dynamic route nobody classified is named",
  );
}

{
  const stale = [...DYNAMIC_SEGMENT_POLICY, { route: "/gone/[id]", action: "keep" as const, siblings: [], why: "a removed route" }];
  const faults = dynamicRouteFaults(routes, stale);
  assert(faults.some((f) => f.includes("/gone/[id]")), "a policy entry for a route that no longer exists is named");
}

{
  const tree = routes.map((r) =>
    r.route === "/api/bookings/[token]" ? { ...r, siblings: [...r.siblings, "export"] } : r,
  );
  const faults = dynamicRouteFaults(tree, DYNAMIC_SEGMENT_POLICY);
  assert(
    faults.some((f) => f.includes("/api/bookings/[token]") && f.includes("export")),
    "a new static route beside a redacted token, which the redaction would eat, is named",
  );
}

finish();

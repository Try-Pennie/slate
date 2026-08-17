// Repo invariant (#1525): the code's list of Workers rate-limit bindings and the ones
// wrangler.jsonc actually creates must be the same set.
//
// `EDGE_LIMITER_BINDINGS` (src/lib/rate-limit-core.ts) is what types every binding lookup
// AND what the monitor lane walks when it reports a limiter missing from the deployment.
// wrangler.jsonc is what brings the bindings into existence. Neither can see the other, so
// a limiter added to one and forgotten in the other fails silently in whichever direction
// it was forgotten (L41):
//
//   - in wrangler.jsonc only: the binding exists, is typed loosely, and is UNMONITORED,
//     so it can vanish from a later deploy with nothing to say so;
//   - in the code only: the monitor lane reports it missing every minute, which is a
//     page nobody can fix because the binding was never meant to exist.
//
// Both directions are checked, because a one-sided comparison is satisfied by the list
// that happens to be the superset.
//
// Run: node --experimental-strip-types scripts/test-edge-limiter-bindings.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { EDGE_LIMITER_BINDINGS } from "@/lib/rate-limit-core";

const ROOT = join(import.meta.dirname, "..");
const raw = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");

// wrangler.jsonc is JSONC. Strip line comments before parsing rather than regexing the
// names out of the raw text, so a name inside a COMMENT can never answer for a binding
// that is not declared (L103).
const withoutComments = raw
  .split("\n")
  .map((line) => {
    // Only strip a `//` that is not inside a string. Every comment in this file starts a
    // line (after indentation) or follows a value, and no value here contains `//`
    // except a URL, which is why the check is for `://`.
    const idx = line.indexOf("//");
    if (idx === -1) return line;
    if (line.slice(Math.max(0, idx - 1), idx + 1) === ":/") return line;
    return line.slice(0, idx);
  })
  .join("\n");

const config = JSON.parse(withoutComments) as {
  ratelimits?: { name: string; namespace_id: string; simple: { limit: number; period: number } }[];
};

const declared = (config.ratelimits ?? []).map((r) => r.name);
assert(declared.length > 0, "wrangler.jsonc declares at least one rate-limit binding");

const inCode = [...EDGE_LIMITER_BINDINGS].sort();
const inConfig = [...declared].sort();

eq(inConfig.join(","), inCode.join(","), "wrangler.jsonc bindings match EDGE_LIMITER_BINDINGS");

for (const name of inCode) {
  assert(inConfig.includes(name), `${name} is declared in wrangler.jsonc`);
}
for (const name of inConfig) {
  assert(inCode.includes(name), `${name} is listed in EDGE_LIMITER_BINDINGS`);
}

// Each namespace_id must be unique: two bindings sharing one would silently share a
// counter, so the tighter limit would be spent by the looser endpoint's traffic.
const ids = (config.ratelimits ?? []).map((r) => r.namespace_id);
eq(new Set(ids).size, ids.length, "every rate-limit namespace_id is unique");

// A positive control: the comment-stripping above must not be what makes this pass. If it
// silently produced an empty list, every "is declared" assertion would still need
// inConfig to be non-empty, but the reverse loop would vacuously pass, so assert the
// parse found the real shape.
assert(
  (config.ratelimits ?? []).every((r) => r.simple?.period === 10 || r.simple?.period === 60),
  "every binding declares a period the platform accepts (10 or 60)",
);

finish();

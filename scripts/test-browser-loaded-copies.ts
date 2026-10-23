// #4113 (L802): a lockfile bump patches only the copies the build RESOLVES. What the
// browser runs can be a copy the lockfile never describes, and then an advisory reads as
// fixed (the audit goes green) while the browser keeps the vulnerable code.
//
// Slate has two such copies, and the advisory runbook has to name both:
//
//   - React. An App Router build sends the browser the React Next VENDORS under
//     next/dist/compiled (a canary build), not node_modules/react-dom. Measured on the
//     2026-10-02 build: the lockfile held react-dom 19.2.8, and every client chunk
//     carried React 19.3.0-canary-cbb046ab-20260731. Bumping `react-dom` changes only
//     the copy the tests use.
//   - The dotLottie player's wasm, which Slate serves itself from public/brand and is
//     held to the installed player by scripts/test-confirmation-mark-assets.ts.
//
// This holds the runbook's React claim to the installed tree, so a Next release that
// stops vendoring React fails here and sends somebody to rewrite the paragraph, rather
// than leaving it telling people to bump the wrong package.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-browser-loaded-copies.ts
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";
import { buildContentSecurityPolicy } from "@/lib/csp";

const root = join(import.meta.dirname, "..");

/** React's version as the vendored SOURCE spells it (`version = "..."`, spaced). */
const VERSION_IN_SOURCE = /\bversion = "([^"]+)"/;

// --- the fact: Next ships its own React, apart from the lockfile's ----------
const vendoredDir = join(root, "node_modules/next/dist/compiled/react-dom");
const vendoredClient = join(vendoredDir, "cjs/react-dom-client.production.js");
const vendoredReact = join(root, "node_modules/next/dist/compiled/react/cjs/react.production.js");
assert(
  existsSync(vendoredClient) && existsSync(vendoredReact),
  "next still vendors React under next/dist/compiled; if this fails, the runbook's React paragraph is out of date",
);
const lockfileReactDom = realpathSync(join(root, "node_modules/react-dom"));
assert(
  realpathSync(vendoredDir) !== lockfileReactDom,
  "the vendored react-dom is a different copy from the lockfile's react-dom",
);
const vendoredVersion = existsSync(vendoredReact)
  ? readFileSync(vendoredReact, "utf8").match(VERSION_IN_SOURCE)?.[1]
  : undefined;
assert(
  typeof vendoredVersion === "string" && /^\d+\.\d+\.\d+/.test(vendoredVersion),
  `the vendored React carries a readable version (got ${String(vendoredVersion)})`,
);

// --- the runbook says so, where a person fixing an advisory reads ------------
const runbook = readFileSync(join(root, "docs/alerts-runbook.md"), "utf8");
const start = runbook.indexOf("## A dependency advisory was found");
assert(start >= 0, "the advisory section exists");
const nextHeading = runbook.indexOf("\n## ", start + 1);
const section = runbook.slice(start, nextHeading < 0 ? undefined : nextHeading);

// The confirm command's OWN pattern, taken from the runbook text, run against the shape
// measured in a real minified chunk (2026-10-02 build). A pattern edited into one that
// cannot read a chunk fails here rather than on the day somebody needs it.
const grepPattern = section.match(/grep -rhoE '([^']+)' \.open-next\/assets\/_next\/static\/chunks/)?.[1];
assert(typeof grepPattern === "string", "the advisory section carries the grep that reads React out of the built chunks");
const confirm = new RegExp(grepPattern ?? "(?!)");
const measuredChunk = 'function(){return T.H.useTransition()},r.version="19.3.0-canary-cbb046ab-20260731"},2159';
assert(
  confirm.exec(measuredChunk)?.[0] === '.version="19.3.0-canary-cbb046ab-20260731"',
  "the runbook's pattern reads the version out of a real client chunk",
);
assert(!confirm.test('const name="react",o.version=""'), "and matches nothing where no version is set");

// "No page loads a script from a CDN": the policy every page is served with allows
// scripts from Slate only, so no CDN copy of a library can run, framed or not.
/** The script-src sources of a policy, or null when it has no script-src at all. */
function scriptSources(policy: string): string[] | null {
  const directive = policy
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("script-src "));
  return directive ? directive.split(/\s+/).slice(1) : null;
}
/** Every source that is not a quoted keyword, nonce or hash: an origin or a scheme. */
const outsideSources = (sources: string[]) => sources.filter((s) => !s.startsWith("'"));
// Positive control: the reading must be able to find a CDN, and must not call a policy
// with no script-src at all clean.
const cdnPolicy = "default-src 'self'; script-src 'self' https://cdn.example.com 'nonce-n'; object-src 'none'";
assert(
  outsideSources(scriptSources(cdnPolicy) ?? []).join(" ") === "https://cdn.example.com",
  "positive control: a script-src naming a CDN is caught",
);
assert(scriptSources("default-src 'self'") === null, "positive control: a policy with no script-src is not read as clean");
for (const frameable of [false, true]) {
  const sources = scriptSources(buildContentSecurityPolicy({ nonce: "n", frameable }));
  assert(sources !== null && sources.includes("'self'"), `frameable=${frameable}: script-src is set and allows Slate itself`);
  const foreign = outsideSources(sources ?? []);
  assert(foreign.length === 0, `frameable=${frameable}: script-src names no outside origin (got ${foreign.join(" ") || "none"})`);
}
assert(section.includes("next/dist/compiled"), "the advisory section says the browser's React is Next's vendored copy");
assert(/a `next` release/.test(section), "and that a React advisory is fixed by a `next` release, not a react bump");
assert(section.includes(".open-next/assets/_next/static/chunks"), "and how to read the version the browser actually loads");
assert(section.includes("public/brand/dotlottie-player.wasm"), "and names the self-served dotLottie wasm");
assert(section.includes("build:confirmation-mark"), "and how that wasm is rebuilt after a player bump");

finish();

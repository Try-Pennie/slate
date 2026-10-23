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
// Run: node --experimental-strip-types scripts/test-browser-loaded-copies.ts
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const root = join(import.meta.dirname, "..");

/** The pattern the runbook's confirm step greps built chunks with, stated once here. */
const REACT_VERSION_IN_BUNDLE = /\.version ?= ?"([^"]+)"/;

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
  ? readFileSync(vendoredReact, "utf8").match(REACT_VERSION_IN_BUNDLE)?.[1]
  : undefined;
assert(
  typeof vendoredVersion === "string" && /^\d+\.\d+\.\d+/.test(vendoredVersion),
  `the confirm step's pattern reads a version out of the vendored React (got ${String(vendoredVersion)})`,
);
// Positive control: the pattern must be able to say no.
assert(!REACT_VERSION_IN_BUNDLE.test('const name="react"'), "the pattern matches nothing without a version");
assert(
  REACT_VERSION_IN_BUNDLE.exec('r.version="19.3.0-canary-cbb046ab-20260731"')?.[1] === "19.3.0-canary-cbb046ab-20260731",
  "the pattern reads the shape measured in a real client chunk",
);

// --- the runbook says so, where a person fixing an advisory reads ------------
const runbook = readFileSync(join(root, "docs/alerts-runbook.md"), "utf8");
const start = runbook.indexOf("## A dependency advisory was found");
assert(start >= 0, "the advisory section exists");
const nextHeading = runbook.indexOf("\n## ", start + 1);
const section = runbook.slice(start, nextHeading < 0 ? undefined : nextHeading);
assert(section.includes("next/dist/compiled"), "the advisory section says the browser's React is Next's vendored copy");
assert(/a `next` release/.test(section), "and that a React advisory is fixed by a `next` release, not a react bump");
assert(section.includes(".open-next/assets/_next/static/chunks"), "and how to read the version the browser actually loads");
assert(section.includes("public/brand/dotlottie-player.wasm"), "and names the self-served dotLottie wasm");
assert(section.includes("build:confirmation-mark"), "and how that wasm is rebuilt after a player bump");

finish();

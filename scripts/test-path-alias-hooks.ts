// The `@/` and extensionless-relative resolution hook (scripts/path-alias-hooks.mjs). Run:
//   node --experimental-strip-types scripts/test-path-alias-hooks.ts
//
// This is shared infrastructure: every node-native script that pulls in real
// source resolves through it. It grew a second case for #1377, because a source
// file importing a sibling as `./service` (no extension, which tsc accepts and
// node does not) made the whole import graph unloadable outside next/vitest, and
// the symptom was a bare ERR_MODULE_NOT_FOUND naming a file that plainly exists.
//
// The rule the assertions below defend: the hook may only ever ADD a resolution
// node could not make on its own. Anything node already resolves has to keep
// resolving exactly as it did, or a package whose name happens to look like a
// path starts loading a file out of src/.
import { resolve } from "./path-alias-hooks.mjs";
import { assert, eq, finish } from "./lib/harness.ts";
import { pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");
const url = (rel: string) => pathToFileURL(path.join(ROOT, rel)).href;

/** Stands in for node's own resolver: succeeds only for what it is told about. */
function nextResolveOver(known: string[]) {
  const seen: string[] = [];
  const fn = async (specifier: string) => {
    seen.push(specifier);
    if (known.includes(specifier)) return { url: `resolved:${specifier}`, shortCircuit: true };
    const err = new Error(`Cannot find module ${specifier}`) as Error & { code?: string };
    err.code = "ERR_MODULE_NOT_FOUND";
    throw err;
  };
  return Object.assign(fn, { seen });
}

// --- the `@/` alias, the case the hook was written for ---
{
  const next = nextResolveOver([]);
  const out = await resolve("@/lib/booking/core", { parentURL: url("scripts/x.ts") }, next);
  eq(out.url, pathToFileURL(path.join(SRC, "lib/booking/core.ts")).href, "@/ maps into src and finds the .ts");
  eq(next.seen.length, 0, "and never asks node, which cannot resolve it");
}
{
  const next = nextResolveOver([]);
  const out = await resolve("@/lib/db/types", { parentURL: url("scripts/x.ts") }, next);
  assert(out.url.endsWith("/src/lib/db/types.ts"), "a deeper @/ path resolves too");
}

// --- extensionless relative imports INSIDE src, the #1377 case ---
{
  const next = nextResolveOver([]);
  const parent = pathToFileURL(path.join(SRC, "lib/availability/slot-cache.ts")).href;
  const out = await resolve("./service", { parentURL: parent }, next);
  eq(
    out.url,
    pathToFileURL(path.join(SRC, "lib/availability/service.ts")).href,
    "a sibling imported without its extension resolves to the .ts file",
  );
  eq(next.seen, ["./service"], "only AFTER node has been given first refusal");
}
{
  const next = nextResolveOver([]);
  const parent = pathToFileURL(path.join(SRC, "lib/booking/core.ts")).href;
  const out = await resolve("../db/types", { parentURL: parent }, next);
  assert(out.url.endsWith("/src/lib/db/types.ts"), "a parent-relative extensionless import resolves too");
}

// --- the hook only ADDS: it must never take over a resolution node can make ---
{
  const next = nextResolveOver(["./service"]);
  const parent = pathToFileURL(path.join(SRC, "lib/availability/slot-cache.ts")).href;
  const out = await resolve("./service", { parentURL: parent }, next);
  eq(out.url, "resolved:./service", "node's own answer wins when node has one");
}
{
  const next = nextResolveOver(["luxon"]);
  const out = await resolve("luxon", { parentURL: url("src/lib/x.ts") }, next);
  eq(out.url, "resolved:luxon", "a bare package specifier is left to node");
}
{
  // The failure this guard exists for: swallowing node's error and answering
  // with a src/ path would turn a genuinely missing package into a confusing
  // wrong-file load rather than an honest not-found.
  const next = nextResolveOver([]);
  let threw = false;
  try {
    await resolve("some-absent-package", { parentURL: url("src/lib/x.ts") }, next);
  } catch {
    threw = true;
  }
  assert(threw, "a specifier the hook cannot place still throws node's own not-found");
}
{
  const next = nextResolveOver([]);
  let threw = false;
  try {
    await resolve("./nothing-here", { parentURL: pathToFileURL(path.join(SRC, "lib/x.ts")).href }, next);
  } catch {
    threw = true;
  }
  assert(threw, "a relative import matching no file on disk throws rather than inventing one");
}
// --- extensionless PACKAGE SUBPATHS, the other half of the #1377 case ---
{
  // `next/server` is spelled without its extension all over src/. Node only
  // resolves `next/server.js`, so one such import made every node-native script
  // touching request-scoped source unloadable.
  const next = nextResolveOver(["next/server.js"]);
  const out = await resolve("next/server", { parentURL: url("src/lib/after-response.ts") }, next);
  eq(out.url, "resolved:next/server.js", "a package subpath retries with the .js spelling");
  eq(next.seen, ["next/server", "next/server.js"], "and the retry goes back to NODE, not to disk");
}
{
  // The retry must not become a way to load a file the package does not export.
  // Node refusing the `.js` spelling has to leave the ORIGINAL error standing.
  const next = nextResolveOver([]);
  let threw = false;
  try {
    await resolve("some-pkg/private/internals", { parentURL: url("src/lib/x.ts") }, next);
  } catch {
    threw = true;
  }
  assert(threw, "a subpath node refuses both ways still throws");
  eq(next.seen.length, 2, "after exactly one retry, never a filesystem guess");
}
{
  // A BARE package name has no subpath to re-spell, so appending .js would only
  // ever be a guess. It must not be attempted at all.
  const next = nextResolveOver([]);
  try {
    await resolve("absent-package", { parentURL: url("src/lib/x.ts") }, next);
  } catch {
    /* expected */
  }
  eq(next.seen, ["absent-package"], "a bare package name is asked once and never re-spelled");
}
{
  // A relative specifier that ALREADY carries an extension is node's business.
  // Re-deriving it here would quietly rewrite a .js import to a .ts file.
  const next = nextResolveOver(["./harness.js"]);
  const out = await resolve("./harness.js", { parentURL: url("scripts/lib/x.ts") }, next);
  eq(out.url, "resolved:./harness.js", "an explicit extension is never second-guessed");
}

finish();

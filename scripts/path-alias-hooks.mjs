// Module resolution hook so node --experimental-strip-types can load source
// files that import via the `@/` tsconfig path alias (mapped to ./src). Without
// this, node-native tests (scripts/test-*.ts) that pull in any `@/`-importing
// source throw ERR_MODULE_NOT_FOUND. Registered via scripts/register-paths.mjs.
//
// It handles two more extensionless spellings that tsc and the bundlers accept
// and node's ESM resolver does not (#1377). Either one, anywhere in the import
// graph, made the whole graph unloadable outside next/vitest, and the symptom
// was a bare ERR_MODULE_NOT_FOUND naming a file that plainly exists:
//
//   `./service`      a sibling source file, imported without its extension
//   `next/server`    a package subpath whose real entry is `next/server.js`
//
// All three cases only ever ADD a resolution node could not make on its own.
// Node gets first refusal on every non-`@/` specifier, and the package-subpath
// retry is handed back to NODE rather than resolved from disk here, so it can
// only ever succeed on a subpath the package genuinely exports. A specifier this
// hook cannot place still fails with node's own error rather than a wrong file.
// Pinned by scripts/test-path-alias-hooks.ts.
import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

/** First of the TypeScript spellings of `base` that exists on disk. */
function firstExisting(base) {
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")];
  return candidates.find((c) => existsSync(c)) ?? null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const base = path.join(SRC, specifier.slice(2));
    const hit = firstExisting(base) ?? `${base}.ts`;
    return { url: pathToFileURL(hit).href, shortCircuit: true };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    // Only an extensionless relative specifier is worth a second attempt. Anything
    // else (a real missing package, a typo'd path, an explicit `.js` that is not
    // there) must keep node's own not-found, because answering it from disk here
    // would swap an honest error for a silently wrong module.
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    if (path.extname(specifier) !== "") throw err;
    if (relative) {
      if (!context?.parentURL) throw err;
      const parentDir = path.dirname(fileURLToPath(context.parentURL));
      const hit = firstExisting(path.resolve(parentDir, specifier));
      if (!hit) throw err;
      return { url: pathToFileURL(hit).href, shortCircuit: true };
    }
    // A package SUBPATH (`next/server`), never a bare package name. The retry is
    // node's to answer, not ours: guessing a file inside node_modules would walk
    // straight past the package's exports map and load something it does not
    // publish. If node refuses the `.js` spelling too, the original error stands.
    if (!specifier.includes("/") || specifier.startsWith("#")) throw err;
    try {
      return await nextResolve(`${specifier}.js`, context);
    } catch {
      throw err;
    }
  }
}

// Module resolution hook so node --experimental-strip-types can load source
// files that import via the `@/` tsconfig path alias (mapped to ./src). Without
// this, node-native tests (scripts/test-*.ts) that pull in any `@/`-importing
// source throw ERR_MODULE_NOT_FOUND. Registered via scripts/register-paths.mjs.
// No-op for every non-`@/` specifier, so npm packages and relative imports are
// untouched.
import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const base = path.join(SRC, specifier.slice(2));
    const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")];
    const hit = candidates.find((c) => existsSync(c)) ?? `${base}.ts`;
    return { url: pathToFileURL(hit).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

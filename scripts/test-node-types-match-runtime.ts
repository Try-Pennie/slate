// Repo invariant: the @types/node major must match the Node major CI actually runs.
//
// @types/node describes ONE Node version's API surface, and it is the only thing
// telling `tsc` whether a call into node: builtins is real. Which direction it is
// wrong in decides whether the mistake is caught or shipped:
//
//   types BEHIND the runtime  -> tsc can only be too strict. A real API looks
//                                missing, you notice immediately, nothing ships.
//   types AHEAD of the runtime -> tsc is too PERMISSIVE. A builtin that exists
//                                only in the newer Node type-checks clean, and
//                                fails at runtime, in a scripts/ job or the
//                                OpenNext build, with a green typecheck behind it.
//
// The ahead case is the dangerous one and it is exactly what Dependabot proposes:
// it reads the registry, not `node-version:`, so it offered @types/node 26 while
// every workflow pins Node 24 (2026-07-30, PR #1184). Nothing in the toolchain
// declares an upper bound, so no install error would have caught it, and CI would
// have stayed green while the type checker described a Node nobody runs.
//
// Note this deliberately pins EQUALITY, not "types <= runtime". Types behind the
// runtime is safe for correctness but still wrong: it hides genuinely available
// builtins and invites per-call-site `any` casts to work around a phantom gap.
// One number, derived from the workflows, so the pair can never silently drift
// (and so a Node upgrade is forced to move both).
//
// Run: node --experimental-strip-types scripts/test-node-types-match-runtime.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const WORKFLOW_DIR = join(ROOT, ".github", "workflows");

/** Every `node-version:` value declared across the workflows, deduped. */
export function pinnedNodeMajors(yaml: string): number[] {
  const found = new Set<number>();
  for (const m of yaml.matchAll(/^\s*node-version:\s*["']?(\d+)/gm)) {
    found.add(Number(m[1]));
  }
  return [...found];
}

/** The major from a semver range like "^20", "^24.1.2", "24.x", "~26.0.0". */
export function rangeMajor(range: string): number | null {
  const m = range.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

const workflows = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith(".yml"));
assert(workflows.length > 0, "workflow files were found (the scan is not vacuous)");

const majors = new Set<number>();
for (const f of workflows) {
  for (const n of pinnedNodeMajors(readFileSync(join(WORKFLOW_DIR, f), "utf8"))) {
    majors.add(n);
  }
}

assert(majors.size > 0, "at least one workflow pins an explicit node-version");
eq(
  majors.size,
  1,
  `every workflow pins the SAME Node major (found ${[...majors].join(", ")}); a split runtime means one of them is type-checked against the wrong Node`,
);

const runtimeMajor = [...majors][0];
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
};
const declared = pkg.devDependencies?.["@types/node"] ?? pkg.dependencies?.["@types/node"];
assert(typeof declared === "string", "@types/node is declared in package.json");

const typesMajor = rangeMajor(declared ?? "");
assert(typesMajor !== null, `@types/node range "${declared}" has a readable major`);

eq(
  typesMajor,
  runtimeMajor,
  `@types/node major matches the Node major CI runs. Types ahead of the runtime let tsc accept builtins that do not exist where the code runs; types behind it hide builtins that do. Bump BOTH (package.json and every workflow node-version) in one change`,
);

// --- unit coverage for the two parsers, incl. the shapes that would false-pass ---
eq(pinnedNodeMajors("        node-version: 24\n"), [24], "parses a bare node-version");
eq(pinnedNodeMajors("  node-version: '24'\n"), [24], "parses a single-quoted node-version");
eq(pinnedNodeMajors('  node-version: "26.1"\n'), [26], "parses a double-quoted minor-qualified pin");
eq(
  pinnedNodeMajors("  node-version: 24\n  node-version: 26\n"),
  [24, 26],
  "reports BOTH majors when workflows disagree (so a split runtime cannot read as consistent)",
);
eq(pinnedNodeMajors("# node-version-file: .nvmrc\n"), [], "no false positive on an unrelated key");
eq(rangeMajor("^20"), 20, "reads the major from a caret range");
eq(rangeMajor("^24.18.1"), 24, "reads the major from a fully-qualified caret range");
eq(rangeMajor("~26.0.0"), 26, "reads the major from a tilde range");
eq(rangeMajor("24.x"), 24, "reads the major from an x-range");
eq(rangeMajor("latest"), null, "returns null for a range with no readable major");

finish();

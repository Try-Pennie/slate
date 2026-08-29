// Repo invariant (#608): jsdom is expensive and only component tests need it.
//
// The vitest suite defaults to the `node` environment; a file that needs a DOM
// opts in with a `@vitest-environment jsdom` docblock. This guard stops the
// boundary eroding again: every component test (*.test.tsx) must opt in, and a
// plain *.test.ts may only opt in if it is on the documented exception list.
// Run: node --experimental-strip-types scripts/test-vitest-environment.ts
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "src");

/** Plain *.test.ts files allowed to request jsdom, with the reason they need it. */
const JSDOM_TS_EXCEPTIONS = new Map<string, string>([
  ["src/components/widget-embed.test.ts", "drives the real widget.js IIFE in a browser environment"],
]);

const DOCBLOCK = /@vitest-environment\s+jsdom/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(SRC).map((f) => ({
  rel: relative(ROOT, f),
  src: readFileSync(f, "utf8"),
}));

assert(files.length > 0, "found vitest test files to check");

// 1. The config must default to node, or every file pays for jsdom regardless.
{
  const cfg = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
  assert(/environment:\s*"node"/.test(cfg), "vitest.config.ts defaults to the node environment");
  assert(
    !/environment:\s*"jsdom"/.test(cfg),
    "vitest.config.ts does not force jsdom on the whole suite",
  );
}

// 2. Every component test opts into jsdom explicitly (it renders, so it needs one).
for (const f of files.filter((f) => f.rel.endsWith(".test.tsx"))) {
  assert(DOCBLOCK.test(f.src), `${f.rel} declares @vitest-environment jsdom`);
}

// 3. No plain *.test.ts drags jsdom back in without being a documented exception.
for (const f of files.filter((f) => f.rel.endsWith(".test.ts"))) {
  const wants = DOCBLOCK.test(f.src);
  const allowed = JSDOM_TS_EXCEPTIONS.has(f.rel);
  if (wants) {
    assert(allowed, `${f.rel} requests jsdom and is on the documented exception list`);
  } else {
    assert(!allowed, `${f.rel} is listed as a jsdom exception but no longer requests it (prune the list)`);
  }
}

// --- #1595: the pool, and the one speed-up that is out of bounds ---------------
//
// `isolate: false` would be the biggest remaining win and it is ruled out: every
// file in this suite mocks modules, so a shared module registry makes one file's
// mocks answer for another's, and the failures that produces look like flakes
// rather than like a configuration choice. A rule that lives only in a comment is
// a hope (L27), so it is a build failure here.
{
  const config = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
  assert(
    !/isolate:\s*false/.test(config),
    "#1595: `isolate: false` is out of bounds; it trades test independence for seconds, and every file here relies on a fresh module registry for its mocks",
  );
  const pool = config.match(/^\s*pool:\s*"(\w+)"/m)?.[1] ?? "";
  assert(
    pool === "threads" || pool === "forks",
    `the vitest pool is set explicitly to a known value (got ${pool || "nothing"}), so a change to it is a decision rather than a default drifting`,
  );
}

finish();

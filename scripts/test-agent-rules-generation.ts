// Repo invariant (#2201): `next dev` must not rewrite AGENTS.md into a form the
// style gate then refuses.
//
// Next 16 auto-generates a managed agent-rules block into AGENTS.md whenever it
// detects an AI coding agent and the current block is absent
// (`node_modules/next/dist/server/lib/generate-agent-files.js`). Slate's copy of
// AGENTS.md carries the ADVICE in its own words and not the managed markers, so
// every `next dev` re-appended the block, and the block's own wording contains a
// character the repo bans. The pre-push style hook then refused the push,
// correctly, over a file nobody had edited. It happened three times in one
// session on 2026-09-10, and the only way through was `git restore AGENTS.md`
// before every push.
//
// The cost is not the restore. It is that the failure arrives as a style
// violation in a file nobody touched, so the first reaction is to hunt for a
// change that was never made. A guard that fires on a file the tooling wrote is a
// guard people learn to work around (L36).
//
// The remedy is the supported one: `agentRules: false` in `next.config.ts`. Slate
// keeps the advice itself, in its own words, at the top of AGENTS.md.
//
// THE POSITIVE CONTROL IS THE PART THAT MATTERS. A test that only asserted the
// setting would go on passing if Next ever cleaned up its wording, and would say
// nothing about whether the setting is still preventing anything. So this reads
// Next's OWN generator out of node_modules and requires the block it would write
// to contain a banned code point. When that stops being true, this fails and says
// so, which is the moment to re-decide rather than to keep a guard nobody can
// explain.
//
// Run: node --experimental-strip-types scripts/test-agent-rules-generation.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const HERE = import.meta.dirname; // scripts/
const ROOT = join(HERE, "..");

/**
 * The characters the repo's copy rules ban, by CODE POINT.
 *
 * Written as numbers rather than as literals because the pre-push style hook
 * cannot tell a line that BANS a character from a line that uses one, and it is
 * right not to: a test naming the character would be caught by the guard it
 * exists to support.
 */
const BANNED = [
  { code: 0x2014, name: "em dash" },
  { code: 0x2013, name: "en dash" },
];

function bannedCodePointsIn(text: string): string[] {
  const found = new Set<string>();
  for (const ch of text) {
    const hit = BANNED.find((b) => b.code === ch.codePointAt(0));
    if (hit) found.add(hit.name);
  }
  return [...found];
}

// --- the setting -------------------------------------------------------------

const configPath = join(ROOT, "next.config.ts");
const config = readFileSync(configPath, "utf8");
assert(
  /\bagentRules:\s*false\b/.test(config),
  "next.config.ts sets agentRules: false, so `next dev` never rewrites AGENTS.md",
);

// --- the positive control: the generated block really is refusable ------------
//
// Reading the installed generator, not a remembered quote of it. A claim that
// something cannot be measured must come from attempting it (L460), so an absent
// generator REFUSES rather than passing: no node_modules and a clean tree would
// otherwise read the same (L98).

const generatorPath = join(
  ROOT,
  "node_modules",
  "next",
  "dist",
  "server",
  "lib",
  "generate-agent-files.js",
);
if (!existsSync(generatorPath)) {
  assert(
    false,
    `cannot read Next's agent-rules generator at ${generatorPath}, so nothing here was ` +
      `measured. Install dependencies and run again rather than reading this as a pass.`,
  );
} else {
  const generator = readFileSync(generatorPath, "utf8");
  assert(
    generator.includes("AGENTS.md"),
    "the generator this guard is about still writes AGENTS.md",
  );
  const offenders = bannedCodePointsIn(generator);
  assert(
    offenders.length > 0,
    `the block Next would write still carries a character the repo bans (found: ` +
      `${offenders.join(", ")}). If this ever fails, Next has cleaned up its wording and ` +
      `agentRules: false is worth re-deciding rather than keeping unexplained.`,
  );
}

// --- the end state: a clean tree stays clean ---------------------------------

const agentsPath = join(ROOT, "AGENTS.md");
const agents = readFileSync(agentsPath, "utf8");
const inFile = bannedCodePointsIn(agents);
assert(
  inFile.length === 0,
  `AGENTS.md carries no banned character (found: ${inFile.join(", ")})`,
);

// The advice the managed block existed to give is KEPT, in Slate's own words, so
// turning the generator off removes the churn and not the guidance. A guard that
// only stopped the write would quietly delete the one thing it was carrying.
assert(
  agents.includes("node_modules/next/dist/docs"),
  "AGENTS.md still tells a reader where this version's own guides live",
);
assert(
  !agents.includes("BEGIN:nextjs-agent-rules"),
  "AGENTS.md carries no managed block, so nothing regenerates it",
);

finish();

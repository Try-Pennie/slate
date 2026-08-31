// Repo invariant (#1598): the scripts a workflow runs on BARE node must reach
// nothing outside local files.
//
// The alerting for a failed deploy (#122) and for an unreviewed push to main (#1027)
// is the thing that has to still work when something else has gone wrong. #1524
// removed `pnpm/action-setup` plus a full `pnpm install --frozen-lockfile` from the
// main push guard after a 429 downloading that action left the only control over
// main unrun; #1598 is the same removal for its sibling, the deploy failure alert.
//
// The removal is only real while the SCRIPT stays dependency free. A guard that
// checked the workflow no longer says `pnpm install` would pass with the script
// still importing the app through the alias hook, which is a check on a proxy for
// the quantity it exists to protect rather than on the quantity itself (L63). So
// this walks the actual transitive import graph
// (scripts/lib/scan-local-import-graph.ts) and fails on any edge that leaves the
// local set: a package, a `@/` alias, a file outside scripts/, or a relative
// specifier that resolves to nothing.
//
// Both halves are covered, each blind where the other looks:
//   - the DECLARED alerters below must be dependency free and must actually be
//     invoked without the alias hook, so the declaration matches what ships;
//   - every script the workflows run on bare node is walked too, whether or not it
//     is declared, so a new one is covered by construction rather than exempt from
//     the guard meant to catch it (L96).
//
// It carries positive controls in both places a control can rot: synthetic fixtures
// for each way an edge can leave the local set, and an OVERLAY of the real tree that
// puts the removed `@/lib/notify/slack` import back (in the entry, and one module
// deeper) and requires the walk to catch it. Nothing is written to the repo: the
// overlay replaces one file's content in memory.
//
// There is deliberately NO opt-out. This is not a style rule with reasonable
// exceptions: a script invoked on bare node that imports anything out of node_modules
// throws on load in the job that runs it, so an exemption would only let a broken
// invocation ship. A script that genuinely needs the app is invoked WITH the alias
// hook, in a job that installs, and this guard then never looks at it.
//
// Run: node --experimental-strip-types scripts/test-dependency-free-scripts.ts
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  describeForeign,
  walkImportGraph,
  type ForeignEdge,
  type ImportGraphIo,
} from "./lib/scan-local-import-graph.ts";
import { bareNodeScripts, workflowNodeScripts } from "./lib/scan-workflow-node-scripts.ts";

const ROOT = join(import.meta.dirname, "..");
const SCRIPTS_DIR = join(ROOT, "scripts");
const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");

/**
 * The alerters that must survive without an install, and why each one must.
 *
 * These are declared rather than derived because the requirement comes from what the
 * script is FOR, not from how a workflow happens to invoke it today: a workflow that
 * quietly reintroduced the alias hook would otherwise remove its own script from the
 * guard's reach. The completeness check below runs the other way and covers the case
 * this list misses.
 */
const DECLARED_ALERTERS: { script: string; why: string }[] = [
  {
    script: "scripts/check-main-push.ts",
    why: "the only control over pushes to main, and a 429 on an action download once left it unrun (#1524)",
  },
  {
    script: "scripts/notify-deploy-failure.ts",
    why: "the only notification that a push to main failed to build or deploy (#122, #1598)",
  },
  {
    script: "scripts/notify-smoke-failure.ts",
    why: "the only notification that the production booking canary failed (#525, #1598)",
  },
];

// ---------------------------------------------------------------------------
// Positive control 1: synthetic graphs, one per way an edge can leave the local set
// ---------------------------------------------------------------------------

function fakeIo(files: Record<string, string>): ImportGraphIo {
  return {
    readFile: (p) => {
      const v = files[p];
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    exists: (p) => Object.hasOwn(files, p),
  };
}

const FAKE_ROOTS = ["/repo/scripts"];
const ENTRY = "/repo/scripts/entry.ts";

interface Fixture {
  name: string;
  files: Record<string, string>;
  /** Expected foreign edges as `from|specifier|reason`, sorted. */
  expect: string[];
}

const FIXTURES: Fixture[] = [
  {
    name: "clean: builtins plus a local lib",
    files: {
      [ENTRY]: `import { readFileSync } from "node:fs";\nimport { helper } from "./lib/helper.ts";\nhelper(readFileSync);`,
      "/repo/scripts/lib/helper.ts": `import { join } from "node:path";\nexport const helper = (f: unknown) => join(String(f));`,
    },
    expect: [],
  },
  {
    name: "flagged: the entry imports the app through the @/ alias",
    files: {
      [ENTRY]: `import { postSlack } from "@/lib/notify/slack";\npostSlack;`,
    },
    expect: [`${ENTRY}|@/lib/notify/slack|alias`],
  },
  {
    name: "flagged: a package pulled in one module DEEPER names that module, not the entry",
    files: {
      [ENTRY]: `import { post } from "./lib/poster.ts";\npost;`,
      "/repo/scripts/lib/poster.ts": `import { createClient } from "@supabase/supabase-js";\nexport const post = createClient;`,
    },
    expect: ["/repo/scripts/lib/poster.ts|@supabase/supabase-js|package"],
  },
  {
    name: "flagged: a relative specifier that escapes the local roots",
    files: {
      [ENTRY]: `import { postSlack } from "../src/lib/notify/slack.ts";\npostSlack;`,
      "/repo/src/lib/notify/slack.ts": `export const postSlack = () => {};`,
    },
    expect: [`${ENTRY}|../src/lib/notify/slack.ts|outside-local-roots`],
  },
  {
    name: "flagged: a relative specifier that resolves to nothing",
    files: {
      [ENTRY]: `import { gone } from "./lib/gone.ts";\ngone;`,
    },
    expect: [`${ENTRY}|./lib/gone.ts|unresolved`],
  },
  {
    name: "flagged: a dynamic import of a package",
    files: {
      [ENTRY]: `const { DateTime } = await import("luxon");\nDateTime;`,
    },
    expect: [`${ENTRY}|luxon|package`],
  },
  {
    name: "clean: a header comment quoting the import it describes is not an import",
    files: {
      // Both directions of the comment problem in one fixture: a line comment and a
      // block comment quoting the removed import, and a URL whose // must not start
      // a comment and swallow the import on the same line.
      [ENTRY]:
        `// It used to be: import { postSlack } from "@/lib/notify/slack";\n` +
        `/* and also: import { supabaseAdmin } from "@supabase/supabase-js"; */\n` +
        `import { helper } from "./lib/helper.ts"; const url = "https://slack.com/api/chat.postMessage";\n` +
        `helper(url);`,
      "/repo/scripts/lib/helper.ts": `export const helper = (s: string) => s;`,
    },
    expect: [],
  },
  {
    name: "clean: a multi line import list from a local module resolves as one statement",
    files: {
      [ENTRY]: `import {\n  a,\n  b,\n} from "./lib/helper.ts";\n\nconst from = "not an import: from \\"luxon\\"";\na; b; from;`,
      "/repo/scripts/lib/helper.ts": `export const a = 1;\nexport const b = 2;`,
    },
    expect: [],
  },
];

const key = (e: ForeignEdge): string => `${e.from}|${e.specifier}|${e.reason}`;

for (const f of FIXTURES) {
  const graph = walkImportGraph(ENTRY, { localRoots: FAKE_ROOTS, io: fakeIo(f.files) });
  eq(
    JSON.stringify(graph.foreign.map(key)),
    JSON.stringify(f.expect),
    `fixture: ${f.name}`,
  );
}

// ---------------------------------------------------------------------------
// The workflow side: which scripts run on bare node, and do the declarations match
// ---------------------------------------------------------------------------

const workflowFiles = readdirSync(WORKFLOWS_DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort()
  .map((name) => ({ name, yaml: readFileSync(join(WORKFLOWS_DIR, name), "utf8") }));

assert(workflowFiles.length > 0, "there are workflow files to read");

const allInvocations = workflowFiles.flatMap((f) =>
  workflowNodeScripts(f.yaml).map((inv) => ({ ...inv, workflow: f.name })),
);
// A derivation that matched nothing would let every check below pass while measuring
// nothing at all (L98), so it is asserted before anything is concluded from it.
assert(
  allInvocations.length > 0,
  "the workflow scan found node invocations to classify (a scan that matched nothing proves nothing)",
);
assert(
  allInvocations.some((i) => i.aliasHook),
  "and it can still see an invocation that DOES carry the alias hook, so the two are told apart",
);

const bare = bareNodeScripts(workflowFiles);
assert(bare.length > 0, "at least one workflow runs a script on bare node");

for (const declared of DECLARED_ALERTERS) {
  assert(
    bare.includes(declared.script),
    `${declared.script} is invoked with no alias hook and no install: ${declared.why}`,
  );
}

// ---------------------------------------------------------------------------
// The real graphs: every entry must be clean
// ---------------------------------------------------------------------------

const realIo: ImportGraphIo = {
  readFile: (p) => readFileSync(p, "utf8"),
  exists: (p) => existsSync(p) && statSync(p).isFile(),
};

function overlayIo(overrides: Record<string, string>): ImportGraphIo {
  return {
    readFile: (p) => (Object.hasOwn(overrides, p) ? (overrides[p] as string) : realIo.readFile(p)),
    exists: (p) => Object.hasOwn(overrides, p) || realIo.exists(p),
  };
}

const entries = [...new Set([...DECLARED_ALERTERS.map((d) => d.script), ...bare])].sort();

for (const rel of entries) {
  const abs = join(ROOT, rel);
  assert(existsSync(abs), `${rel} exists`);
  if (!existsSync(abs)) continue;
  const graph = walkImportGraph(abs, { localRoots: [SCRIPTS_DIR], io: realIo });
  assert(
    graph.foreign.length === 0,
    `${rel} reaches nothing outside scripts/ and node builtins` +
      (graph.foreign.length > 0 ? `\n${describeForeign(graph.foreign, ROOT)}` : ""),
  );
  assert(graph.files.includes(abs), `${rel} is in its own walk, so the entry was read at all`);
}

// The alerters go through the shared poster, which is also the proof that the walk
// DESCENDS on the real tree: a walker that read the entry and stopped would report
// exactly one file and still say "nothing foreign".
for (const declared of DECLARED_ALERTERS) {
  const abs = join(ROOT, declared.script);
  if (!existsSync(abs)) continue;
  const graph = walkImportGraph(abs, { localRoots: [SCRIPTS_DIR], io: realIo });
  assert(
    graph.files.includes(join(SCRIPTS_DIR, "lib", "slack-post.ts")),
    `${declared.script} posts through the dependency free poster, and the walk followed it there`,
  );
}

// ---------------------------------------------------------------------------
// Positive control 2: put the removed import back, in the REAL files
// ---------------------------------------------------------------------------
//
// The fixtures prove the walker flags the shapes; these prove it flags them in the
// tree that ships, at both depths. Without the deeper one the guard would be
// satisfied by an entry that imports a local module which imports the app.

const APP_IMPORT = `import { postSlack } from "@/lib/notify/slack";\n`;

for (const declared of DECLARED_ALERTERS) {
  const abs = join(ROOT, declared.script);
  if (!existsSync(abs)) continue;
  const mutated = APP_IMPORT + readFileSync(abs, "utf8");
  const graph = walkImportGraph(abs, {
    localRoots: [SCRIPTS_DIR],
    io: overlayIo({ [abs]: mutated }),
  });
  assert(
    graph.foreign.some((e) => e.from === abs && e.reason === "alias"),
    `positive control: reintroducing the app import into ${declared.script} is caught`,
  );
}

{
  // One module deeper: the shared dependency free poster every alerter now goes
  // through. A package import here is invisible to anything that only reads the
  // entry file.
  const poster = join(SCRIPTS_DIR, "lib", "slack-post.ts");
  assert(existsSync(poster), "the dependency free Slack poster is where the alerters import it from");
  const mutated = `import { createClient } from "@supabase/supabase-js";\n${readFileSync(poster, "utf8")}\nvoid createClient;`;
  let caughtSomewhere = 0;
  for (const declared of DECLARED_ALERTERS) {
    const abs = join(ROOT, declared.script);
    if (!existsSync(abs)) continue;
    const graph = walkImportGraph(abs, {
      localRoots: [SCRIPTS_DIR],
      io: overlayIo({ [poster]: mutated }),
    });
    const hit = graph.foreign.find((e) => e.specifier === "@supabase/supabase-js");
    if (hit && hit.from === poster) caughtSomewhere++;
  }
  assert(
    caughtSomewhere === DECLARED_ALERTERS.length,
    "positive control: a package import added one module deeper is caught for every alerter, and blamed on that module",
  );
}

// ---------------------------------------------------------------------------
// Run it, do not only read it: the deploy alerter on bare node
// ---------------------------------------------------------------------------
//
// The static walk is the guard; this is the independent confirmation that node
// agrees. It runs the alerter exactly as the workflow does, with no alias hook, and
// with Slack deliberately unconfigured so it refuses before any network call: what
// is asserted is that it reached its OWN refusal rather than dying on a module it
// could not resolve.

{
  const res = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(SCRIPTS_DIR, "notify-deploy-failure.ts")],
    {
      encoding: "utf8",
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_OPTIONS: "",
        WORKFLOW_NAME: "CI",
        BRANCH: "main",
        RUN_URL: "https://github.com/Try-Pennie/slate/actions/runs/1",
        COMMIT_SHA: "abc1234def5678",
        ACTOR: "someone",
        SLACK_BOT_TOKEN: "",
        SLACK_ALERTS_CHANNEL: "",
      },
    },
  );
  const out = `${res.stdout}${res.stderr}`;
  assert(
    !/Cannot find package|Cannot find module|ERR_MODULE_NOT_FOUND/.test(out),
    `the deploy alerter resolves every import on bare node, with no alias hook\n${out}`,
  );
  eq(res.status, 1, "and fails loud when Slack is unconfigured rather than pretending it warned anyone");
  assert(
    /Deploy-failure alert not sent/.test(out),
    "and the failure it reports is its own, which is only reachable once every import resolved",
  );
}

finish();

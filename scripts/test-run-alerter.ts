// One entry point idiom for the bare node alerters (#2572).
//
// Every alerter (`scripts/notify-*.ts`, `scripts/check-main-push.ts`) ended the same
// way: an `isMain` guard comparing argv[1] against its own module, a Slack poster
// built from SLACK_BOT_TOKEN, and a `.then` that printed and called `process.exit`.
// The global duplication guard named the third copy. `scripts/lib/run-alerter.ts`
// owns it now.
//
// The constraint that matters (AGENTS.md, "An alerting workflow carries no
// dependency install"): these scripts run on bare node with nothing installed, so
// the helper may import nothing outside `scripts/` and node builtins. That is
// asserted here by walking its import graph, as `test-dependency-free-scripts.ts`
// does for the alerters themselves.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-run-alerter.ts
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { walkImportGraph, describeForeign, type ImportGraphIo } from "./lib/scan-local-import-graph.ts";
import { isEntryPoint, runAlerter } from "./lib/run-alerter.ts";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPTS_DIR);
const HELPER = join(SCRIPTS_DIR, "lib", "run-alerter.ts");
const HERE = fileURLToPath(import.meta.url);

// --- isEntryPoint: the module node was asked to run, and only that --------------
assert(isEntryPoint(import.meta.url, [process.execPath, HERE]), "the file node was asked to run is the entry point");
assert(
  !isEntryPoint(import.meta.url, [process.execPath, join(SCRIPTS_DIR, "lib", "harness.ts")]),
  "a module that was imported is not the entry point, so importing an alerter in a test runs nothing",
);
assert(!isEntryPoint(import.meta.url, [process.execPath]), "no script argument at all is not the entry point");
assert(
  !isEntryPoint(import.meta.url, [process.execPath, join(SCRIPTS_DIR, "does-not-exist.ts")]),
  "a script path that does not exist is not the entry point rather than a thrown error",
);

// --- runAlerter: hands main a poster and the env, and exits with main's code -----
type Exit = { code: number | null; errors: string[]; calls: number };
async function drive(main: Parameters<typeof runAlerter>[1], argv: string[]): Promise<Exit> {
  const out: Exit = { code: null, errors: [], calls: 0 };
  await runAlerter(import.meta.url, main, {
    argv,
    env: { SLACK_BOT_TOKEN: "xoxb-test" },
    exit: (code) => {
      out.code = code;
      out.calls++;
    },
    error: (line) => out.errors.push(line),
  });
  return out;
}

{
  let seen: { post: unknown; env: Record<string, string | undefined> } | null = null;
  const res = await drive(async (post, env) => {
    seen = { post, env };
    return 0;
  }, [process.execPath, HERE]);
  assert(seen !== null, "main runs when the module is the entry point");
  assert(typeof seen!.post === "function", "and is handed a poster function");
  eq(seen!.env.SLACK_BOT_TOKEN, "xoxb-test", "and the env it was given");
  eq(res.code, 0, "a main returning 0 exits 0");
  eq(res.calls, 1, "exit is called exactly once");
}
{
  const res = await drive(async () => 3, [process.execPath, HERE]);
  eq(res.code, 3, "main's own code is the exit code, so an alerter keeps its own exit vocabulary");
}
{
  const res = await drive(async () => {
    throw new Error("slack exploded");
  }, [process.execPath, HERE]);
  eq(res.code, 1, "a main that throws exits 1 rather than hanging or ending with no verdict");
  assert(
    res.errors.some((l) => l.includes("slack exploded")),
    "and the reason is printed, so the failure is the alerter's own rather than a silent one",
  );
}
{
  let ran = false;
  const res = await drive(async () => {
    ran = true;
    return 0;
  }, [process.execPath, join(SCRIPTS_DIR, "lib", "harness.ts")]);
  assert(!ran, "an imported module's main never runs");
  eq(res.calls, 0, "and nothing exits, so a test that imports an alerter keeps running");
}

// --- the helper imports nothing outside scripts/ and node builtins ---------------
const realIo: ImportGraphIo = {
  readFile: (p) => readFileSync(p, "utf8"),
  exists: (p) => existsSync(p) && statSync(p).isFile(),
};
{
  const graph = walkImportGraph(HELPER, { localRoots: [SCRIPTS_DIR], io: realIo });
  assert(
    graph.foreign.length === 0,
    `run-alerter.ts reaches nothing outside scripts/ and node builtins` +
      (graph.foreign.length > 0 ? `\n${describeForeign(graph.foreign, ROOT)}` : ""),
  );
  assert(
    graph.files.includes(join(SCRIPTS_DIR, "lib", "slack-post.ts")),
    "and it builds the poster from the dependency free poster, so the walk descended",
  );
}

// --- every alerter uses it, and nobody spells the idiom by hand any more ---------
const alerters = [
  ...readdirSync(SCRIPTS_DIR).filter((n) => /^notify-.*\.ts$/.test(n)),
  "check-main-push.ts",
].map((n) => join(SCRIPTS_DIR, n));
assert(alerters.length >= 8, `the alerter list is real (found ${alerters.length})`);
for (const abs of alerters) {
  const src = readFileSync(abs, "utf8");
  const rel = abs.slice(ROOT.length + 1);
  assert(/runAlerter\(import\.meta\.url,/.test(src), `${rel} enters through runAlerter`);
  assert(
    !/realpathSync\(process\.argv\[1\]\)/.test(src),
    `${rel} no longer spells the entry point comparison by hand`,
  );
  assert(!/process\.exit\(/.test(src), `${rel} returns its exit code to runAlerter rather than exiting itself`);
}
{
  // The one non-alerter that carried the same comparison. It is not a Slack
  // alerter, so it takes the predicate alone.
  const logs = readFileSync(join(SCRIPTS_DIR, "logs.ts"), "utf8");
  assert(/isEntryPoint\(import\.meta\.url\)/.test(logs), "scripts/logs.ts asks isEntryPoint");
  assert(!/realpathSync\(process\.argv\[1\]\)/.test(logs), "and no longer compares argv by hand");
}

finish();

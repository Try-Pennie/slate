// The shared confirm line is bound, created and exported, in production AND in the
// load test Worker (#3325), judged as wrangler RESOLVES the config.
//
// A binding without its migration names a class that is never created; a migration
// without the export deploys a class the runtime cannot find; and a binding missing
// from env.loadtest (durable_objects do not inherit) would have the load run measure
// the per isolate fallback while believing it measured the shared line. Each of the
// three is a quiet fallback rather than a crash, which is why each is asserted.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-confirm-line-binding.ts
import { readFileSync } from "node:fs";
import { unstable_readConfig } from "wrangler";
import {
  CONFIRM_LINE_BINDING,
  CONFIRM_LINE_CLASS,
  CONFIRM_LINE_PROTOCOL,
  CONFIRM_LINE_TRACE_TAG,
  TRACED_CALL_MSG,
} from "../src/lib/booking/confirm-line-object.ts";
import { ConfirmLine } from "../worker/confirm-line.ts";
import { POOL_GROUPING_DIRECTORY, groupingGetMessage, groupingPutMessage, groupingSnapshotOf } from "../src/lib/booking/pool-grouping.ts";
import { memoryGroupingStorage } from "./lib/memory-grouping-storage.ts";
import { confirmLineObjectName } from "../src/lib/booking/shared-confirm-line.ts";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { walkWorkerImports } from "./lib/scan-local-import-graph.ts";

interface Resolved {
  name?: string;
  main?: string;
  workers_dev?: boolean;
  routes?: unknown[];
  durable_objects?: { bindings?: { name?: string; class_name?: string; script_name?: string }[] } | null;
  migrations?: { tag?: string; new_sqlite_classes?: string[] }[] | null;
}

// #3500: the line object lives in its OWN small Worker, so waking an idle one no longer
// loads the whole 21 MB app (load run 37829565739: a cold isolate's first line call took
// 1.1 to 1.4s against about 0.4s warm). Slate binds it by script name, production to
// production's and the load test to the load test's, so a load run never shares lines
// with production and production never reaches a load test object.
const LINE_SCRIPT = { production: "slate-confirm-line", loadtest: "slate-confirm-line-loadtest" } as const;
for (const env of [undefined, "loadtest"] as const) {
  const label = env ?? "production";
  const cfg = unstable_readConfig({ config: "wrangler.jsonc", env }) as unknown as Resolved;
  const binding = (cfg.durable_objects?.bindings ?? []).find((b) => b.name === CONFIRM_LINE_BINDING);
  assert(binding?.class_name === CONFIRM_LINE_CLASS, `${label}: ${CONFIRM_LINE_BINDING} is bound to ${CONFIRM_LINE_CLASS} (got ${JSON.stringify(binding ?? null)})`);
  eq(binding?.script_name, LINE_SCRIPT[label], `${label}: ${CONFIRM_LINE_BINDING} is served by the small line Worker, by script name`);
  // The old class stays exported and declared in Slate until a later deleted_classes
  // migration (#3500 step 3), so this deploy needs no migration of Slate's own.
  const created = (cfg.migrations ?? []).some((m) => (m.new_sqlite_classes ?? []).includes(CONFIRM_LINE_CLASS));
  assert(created, `${label}: Slate's migration history still declares ${CONFIRM_LINE_CLASS}, so no migration is pending`);

  const line = unstable_readConfig({ config: "wrangler.confirm-line.jsonc", env }) as unknown as Resolved;
  eq(line.name, LINE_SCRIPT[label], `${label}: the line Worker is named for its environment`);
  eq(line.main?.replace(/^.*?(worker\/)/, "$1"), "worker/confirm-line/index.ts", `${label}: the line Worker's entry is its own small module`);
  const own = (line.durable_objects?.bindings ?? []).find((b) => b.name === CONFIRM_LINE_BINDING);
  assert(own?.class_name === CONFIRM_LINE_CLASS && own.script_name === undefined, `${label}: the line Worker hosts ${CONFIRM_LINE_CLASS} itself (got ${JSON.stringify(own ?? null)})`);
  assert(
    (line.migrations ?? []).some((m) => (m.new_sqlite_classes ?? []).includes(CONFIRM_LINE_CLASS)),
    `${label}: the line Worker's migration creates ${CONFIRM_LINE_CLASS} as a SQLite class`,
  );
  assert(line.workers_dev === false && (line.routes ?? []).length === 0, `${label}: the line Worker has no address; only Slate's binding reaches it`);
}

// #3500: the whole point is that the line Worker loads almost nothing. Its entry's local
// imports are walked to the end, and every file reached must be one of the line's own,
// so an import that pulled the app back in (a Supabase client, Next, a notifier) fails
// here rather than silently undoing the fix.
{
  const LINE_FILES = new Set([
    "worker/confirm-line/index.ts",
    "worker/confirm-line.ts",
    "src/lib/booking/confirm-line-object.ts",
    "src/lib/booking/confirm-queue.ts",
    "src/lib/booking/pool-grouping.ts",
    "src/lib/booking/line-key.ts",
    // #4102: the ladder key's hash, shared with the booking pace readings. No imports of its own.
    "src/lib/cyrb53.ts",
    "src/lib/routing/tiers.ts",
    "src/lib/xbc.ts",
    "src/lib/read-within-deadline.ts",
    "src/lib/log.ts",
  ]);
  const { seen, foreign } = walkWorkerImports(join(import.meta.dirname, ".."), "worker/confirm-line/index.ts", LINE_FILES);
  assert(foreign.length === 0, `the line Worker reaches only the line's own files (got ${foreign.join(", ")})`);
  assert(seen.has("src/lib/booking/confirm-queue.ts"), "the walk did reach the line's rules (positive control: it read the imports at all)");
}

const entry = readFileSync("worker/index.ts", "utf8");
assert(
  new RegExp(`export\\s*\\{\\s*${CONFIRM_LINE_CLASS}\\s*\\}\\s*from\\s*"\\./confirm-line"`).test(entry),
  `worker/index.ts exports ${CONFIRM_LINE_CLASS} from ./confirm-line`,
);

// #3354: the deployed shell reports a traced call, on the tag and message the load
// run's reader looks for. Driven through the real class rather than a scan of its
// text, because a host that accepts `onTrace` proves nothing when the shell never
// passes it (L3), and a scan would pass on a mention in a comment (L135).
async function shellReports(message: Record<string, unknown>): Promise<string[]> {
  const lines: string[] = [];
  const real = console.info;
  console.info = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const res = await new ConfirmLine().fetch(
      new Request("https://confirm-line/", { method: "POST", body: JSON.stringify({ v: CONFIRM_LINE_PROTOCOL, ...message }) }),
    );
    await res.text();
  } finally {
    console.info = real;
  }
  return lines;
}
{
  const traced = await shellReports({ op: "enter", attempt: "A", line: "100", waitMs: 0, trace: "t-1", stage: "wait" });
  const line = traced.find((l) => l.includes(`tag=${CONFIRM_LINE_TRACE_TAG}`));
  assert(
    line !== undefined && line.includes(`msg="${TRACED_CALL_MSG}"`) && line.includes('op="enter"') && line.includes('trace="t-1"') && line.includes('stage="wait"'),
    `the ConfirmLine shell logs a traced call with its op, trace and stage (got ${JSON.stringify(traced)})`,
  );
  const untraced = await shellReports({ op: "enter", attempt: "B", line: "200", waitMs: 0 });
  assert(untraced.length === 0, `and logs nothing for a call with no trace, which is every production call (got ${JSON.stringify(untraced)})`);
}

// #3460: the same class hosts the pool grouping directory, a reserved instance reached
// on its own path by the client's one directory constructor. Driven through the real
// class, because the role is decided in the shell from the URL and, when the runtime
// supplies it, the instance's own name, which a test of the host alone never sees.
{
  const call = async (shell: ConfirmLine, path: string, message: Record<string, unknown>) => {
    const res = await shell.fetch(new Request(`https://confirm-line${path}`, { method: "POST", body: JSON.stringify(message) }));
    return JSON.parse(await res.text()) as Record<string, unknown>;
  };
  const snapshot = groupingSnapshotOf([["120", "pool-a"], ["121", "pool-a"]], Date.now());
  // The instance's storage, as the runtime hands it over on `ctx.storage` (#3479).
  const ctxWith = (extra: Record<string, unknown> = {}) => ({ storage: memoryGroupingStorage(), ...extra }) as never;
  // No name from the runtime: the path alone decides, as on a runtime that does not
  // expose `ctx.id.name` (L82: measured on neither, so both must work).
  const storage = memoryGroupingStorage();
  const bare = new ConfirmLine({ storage } as never);
  eq((await call(bare, "/directory", groupingPutMessage(snapshot))).kind, "stored", "the shell stores a grouping put on the directory path");
  const got = await call(bare, "/directory", groupingGetMessage());
  eq(JSON.stringify(got.snapshot), JSON.stringify(snapshot), "and hands the same snapshot back on a get");
  eq((await call(bare, "/directory", { v: CONFIRM_LINE_PROTOCOL, op: "enter", attempt: "D", line: "1", waitMs: 0 })).kind, "bad", "a line message on the directory path is refused");
  // #3479: a NEW instance over the same storage is a woken one, and still answers.
  const woken = await call(new ConfirmLine({ storage } as never), "/directory", groupingGetMessage());
  eq(JSON.stringify(woken.snapshot), JSON.stringify(snapshot), "the shell hands its storage to the directory, so a woken instance still holds the snapshot");
  // #3481: and says where each get answered from, which the daily proof reads to tell a
  // woken instance from one that never slept.
  eq(got.from, "memory", "the deployed class answers a get after a put from memory, since the put already loaded its storage");
  eq(woken.from, "storage", "and a woken instance's first get says it read its storage");
  // With no storage on the context the directory refuses rather than keeping the snapshot
  // in memory alone, which would read as healthy and be empty within a minute.
  eq((await call(new ConfirmLine(), "/directory", groupingPutMessage(snapshot))).kind, "bad", "an instance with no storage refuses a put");
  eq((await call(new ConfirmLine(), "/line", groupingGetMessage())).kind, "bad", "a grouping message on a line path is refused");
  eq((await call(new ConfirmLine(), "/", { v: CONFIRM_LINE_PROTOCOL, op: "enter", attempt: "E", line: "1", waitMs: 0 })).kind, "lead", "and the bare path an older client sends is still a line");

  // With the runtime's name: it must agree with the path, so the monitor's and every
  // real line's instance refuse directory messages even on the directory path.
  const named = (name: unknown) => new ConfirmLine(ctxWith({ id: { name } }));
  eq((await call(named(confirmLineObjectName("monitor:confirm-line-verify")), "/directory", groupingGetMessage())).kind, "bad", "the monitor instance refuses a directory message on the directory path");
  eq((await call(named(confirmLineObjectName("code:121")), "/directory", groupingGetMessage())).kind, "bad", "so does a real line's instance");
  eq((await call(named(confirmLineObjectName(POOL_GROUPING_DIRECTORY)), "/directory", groupingGetMessage())).kind, "grouping", "and the directory's own instance answers it");
  // A runtime whose id throws on `name` is read as one with no name, never a crash.
  const throwing = new ConfirmLine(
    ctxWith({
      id: {
        get name(): string {
          throw new Error("no name here");
        },
      },
    }),
  );
  eq((await call(throwing, "/directory", groupingGetMessage())).kind, "grouping", "an id whose name cannot be read leaves the path to decide");
}

finish();

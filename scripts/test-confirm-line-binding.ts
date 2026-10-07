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
import { assert, eq, finish } from "./lib/harness.ts";

interface Resolved {
  durable_objects?: { bindings?: { name?: string; class_name?: string }[] } | null;
  migrations?: { tag?: string; new_sqlite_classes?: string[] }[] | null;
}

for (const env of [undefined, "loadtest"] as const) {
  const label = env ?? "production";
  const cfg = unstable_readConfig({ config: "wrangler.jsonc", env }) as unknown as Resolved;
  const binding = (cfg.durable_objects?.bindings ?? []).find((b) => b.name === CONFIRM_LINE_BINDING);
  assert(binding?.class_name === CONFIRM_LINE_CLASS, `${label}: ${CONFIRM_LINE_BINDING} is bound to ${CONFIRM_LINE_CLASS} (got ${JSON.stringify(binding ?? null)})`);
  const created = (cfg.migrations ?? []).some((m) => (m.new_sqlite_classes ?? []).includes(CONFIRM_LINE_CLASS));
  assert(created, `${label}: a migration creates ${CONFIRM_LINE_CLASS} as a SQLite class`);
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

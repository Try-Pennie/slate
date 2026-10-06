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
import { assert, finish } from "./lib/harness.ts";

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

finish();

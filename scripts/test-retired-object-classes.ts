// The main `slate` Worker no longer hosts BurstLimiter or ConfirmLine (#4025).
//
// Both objects moved to their own small Workers on 2026-10-09 (`slate-burst-limiter`,
// #3555; `slate-confirm-line`, #3500), and Slate's bindings have named those Workers by
// script name since. The old classes stayed exported and declared in Slate as rollback
// insurance, with a promise in #3500 step 3 that a `deleted_classes` migration would
// retire them a week later. Nothing tracked that step, so two weeks on they were still
// there (Dan decided to retire them, 2026-10-23). This holds the retirement in place:
//
//   1. worker/index.ts exports neither class, because Cloudflare refuses to delete a
//      namespace whose class the Worker still ships;
//   2. Slate's migration history, replayed in order, leaves neither class live, in
//      production AND in env.loadtest (migrations do not inherit), while still keeping
//      the tags that created them, since an applied tag is never removed (#3352);
//   3. every binding the app uses still resolves: each names its small Worker by
//      script name, that Worker's own migration creates the class, and that Worker's
//      entry exports it. A binding with no script_name would now point at a namespace
//      this very migration deletes.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-retired-object-classes.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unstable_readConfig } from "wrangler";
import { BURST_LIMITER_BINDING, BURST_LIMITER_CLASS } from "../src/lib/rate-limit-burst.ts";
import { CONFIRM_LINE_BINDING, CONFIRM_LINE_CLASS } from "../src/lib/booking/confirm-line-object.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");

interface Migration {
  tag?: string;
  new_sqlite_classes?: string[];
  new_classes?: string[];
  deleted_classes?: string[];
  renamed_classes?: { from: string; to: string }[];
}
interface Resolved {
  name?: string;
  main?: string;
  durable_objects?: { bindings?: { name?: string; class_name?: string; script_name?: string }[] } | null;
  migrations?: Migration[] | null;
}

/** The classes a migration history leaves live, replayed in order as Cloudflare applies it. */
function liveClasses(migrations: readonly Migration[]): Set<string> {
  const live = new Set<string>();
  for (const m of migrations) {
    for (const c of m.new_sqlite_classes ?? []) live.add(c);
    for (const c of m.new_classes ?? []) live.add(c);
    for (const { from, to } of m.renamed_classes ?? []) {
      live.delete(from);
      live.add(to);
    }
    for (const c of m.deleted_classes ?? []) live.delete(c);
  }
  return live;
}

/** Every class a history ever created, deleted or not. */
function everCreated(migrations: readonly Migration[]): Set<string> {
  return new Set(migrations.flatMap((m) => [...(m.new_sqlite_classes ?? []), ...(m.new_classes ?? [])]));
}

/** Source with comments removed, so a mention in a comment never reads as an export. */
function code(path: string): string {
  return readFileSync(join(ROOT, path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Whether a module's code exports `name` in any of the forms that would ship it. */
function exportsClass(src: string, name: string): boolean {
  return new RegExp(`export\\s+(?:\\{[^}]*\\b${name}\\b[^}]*\\}|(?:class|const|let|function)\\s+${name}\\b)`).test(src);
}

const RETIRED = [
  {
    binding: BURST_LIMITER_BINDING,
    cls: BURST_LIMITER_CLASS,
    config: "wrangler.burst-limiter.jsonc",
    entry: "worker/burst-limiter/index.ts",
    script: { production: "slate-burst-limiter", loadtest: "slate-burst-limiter-loadtest" },
  },
  {
    binding: CONFIRM_LINE_BINDING,
    cls: CONFIRM_LINE_CLASS,
    config: "wrangler.confirm-line.jsonc",
    entry: "worker/confirm-line/index.ts",
    script: { production: "slate-confirm-line", loadtest: "slate-confirm-line-loadtest" },
  },
] as const;

// --- 1. the main Worker's entry ships neither class --------------------------------
{
  const entry = code("worker/index.ts");
  for (const { cls } of RETIRED) {
    assert(!exportsClass(entry, cls), `worker/index.ts no longer exports ${cls}; Cloudflare will not delete a namespace whose class is still shipped`);
  }
  // Positive control: the same reader finds the export the file used to carry, and the
  // OpenNext classes the entry still re-exports, so "not found" is a measurement.
  assert(exportsClass('export { BurstLimiter } from "./burst-limiter";', BURST_LIMITER_CLASS), "control: the old export line is recognised");
  assert(exportsClass('export { ConfirmLine } from "./confirm-line";', CONFIRM_LINE_CLASS), "control: the old confirm line export is recognised");
  assert(exportsClass(entry, "DOQueueHandler"), "control: the reader finds an export worker/index.ts really carries");
  assert(!exportsClass("// export { BurstLimiter } from \"./burst-limiter\";".replace(/^\s*\/\/.*$/gm, ""), BURST_LIMITER_CLASS), "control: a commented out export is not an export");
}

// --- 2. Slate's history retires both, in both environments ------------------------
for (const env of [undefined, "loadtest"] as const) {
  const label = env ?? "production";
  const slate = unstable_readConfig({ config: "wrangler.jsonc", env }) as unknown as Resolved;
  const history = slate.migrations ?? [];
  const live = liveClasses(history);
  const created = everCreated(history);
  for (const { cls } of RETIRED) {
    assert(created.has(cls), `${label}: Slate's history still holds the tag that created ${cls}, since an applied tag is never removed (#3352)`);
    assert(!live.has(cls), `${label}: Slate's migrations delete ${cls}, so the replayed history leaves it live nowhere (got live: ${JSON.stringify([...live])})`);
  }
  eq(live.size, 0, `${label}: Slate's own Worker hosts no Durable Object class at all once the history is replayed`);
  // The retirement is ONE new tag, after the ones that created the classes.
  const deleting = history.filter((m) => (m.deleted_classes ?? []).length > 0);
  eq(deleting.length, 1, `${label}: one migration entry carries the deletes`);
  eq(history.indexOf(deleting[0]!), history.length - 1, `${label}: and it is the last entry, so it is the one the next deploy applies`);
}
// Control: the same replay over the history before #4025 finds both classes live.
{
  const before: Migration[] = [
    { tag: "v1", new_sqlite_classes: [BURST_LIMITER_CLASS] },
    { tag: "v2", new_sqlite_classes: [CONFIRM_LINE_CLASS] },
  ];
  eq([...liveClasses(before)].sort(), [BURST_LIMITER_CLASS, CONFIRM_LINE_CLASS].sort(), "control: the history before #4025 leaves both classes live");
  const half: Migration[] = [...before, { tag: "v3", deleted_classes: [CONFIRM_LINE_CLASS] }];
  eq([...liveClasses(half)], [BURST_LIMITER_CLASS], "control: a delete naming only one class leaves the other live");
}

// --- 3. every binding the app uses still resolves, through its small Worker ---------
for (const env of [undefined, "loadtest"] as const) {
  const label = env ?? "production";
  const slate = unstable_readConfig({ config: "wrangler.jsonc", env }) as unknown as Resolved;
  const bindings = slate.durable_objects?.bindings ?? [];
  // No binding may resolve to Slate's own Worker: every class Slate hosted is deleted,
  // so a binding without a script name would name a namespace that no longer exists.
  for (const b of bindings) {
    assert(typeof b.script_name === "string" && b.script_name !== "" && b.script_name !== slate.name, `${label}: ${b.name} names another Worker by script name, never Slate's own (got ${JSON.stringify(b)})`);
  }
  for (const r of RETIRED) {
    const b = bindings.find((x) => x.name === r.binding);
    eq(b?.class_name, r.cls, `${label}: ${r.binding} is still bound to ${r.cls}`);
    eq(b?.script_name, r.script[label], `${label}: ${r.binding} is served by ${r.script[label]}`);
    const own = unstable_readConfig({ config: r.config, env }) as unknown as Resolved;
    eq(own.name, r.script[label], `${label}: ${r.config} deploys the Worker the binding names`);
    assert(liveClasses(own.migrations ?? []).has(r.cls), `${label}: ${r.script[label]}'s own migrations keep ${r.cls} live`);
  }
}
for (const r of RETIRED) {
  assert(exportsClass(code(r.entry), r.cls), `${r.entry} exports ${r.cls}, so the Worker the binding names really hosts it`);
}

finish();

// #3105: Slate's tail consumer, judged as WRANGLER RESOLVES both configs.
//
// Three things that read fine in either file and break in the pair:
//   - Slate names a tail consumer that is not the Worker the tail config deploys
//     (a rename on one side), so logs go nowhere and nothing says so;
//   - the tail worker names a tail consumer of its own, which would invoke it once
//     per its own invocation, for ever;
//   - the load test environment ships its synthetic traffic to Better Stack.
// Plus the secret rule: Slate itself holds no Better Stack setting at all.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-log-tail-config.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unstable_readConfig } from "wrangler";
import { assert, eq, finish } from "./lib/harness.ts";
import { tailHandlerWrapFault } from "./lib/scan-tail-handler.ts";

type Resolved = {
  name?: string;
  main?: string;
  tail_consumers?: { service: string }[];
  vars?: Record<string, unknown>;
  workers_dev?: boolean;
  observability?: { enabled?: boolean };
};

function read(config: string, env?: string): Resolved {
  return unstable_readConfig({ config, env }) as unknown as Resolved;
}

const slate = read("wrangler.jsonc");
const loadtest = read("wrangler.jsonc", "loadtest");
const tail = read("wrangler.log-tail.jsonc");

eq(tail.name, "slate-log-tail", "the tail worker deploys under its own name");
assert(
  (slate.tail_consumers ?? []).some((c) => c.service === tail.name),
  "Slate's tail_consumers names exactly the Worker the tail config deploys",
);
eq((tail.tail_consumers ?? []).length, 0, "the tail worker tails nothing, so it can never invoke itself");
eq((loadtest.tail_consumers ?? []).length, 0, "the load test environment ships nothing to Better Stack");
eq(tail.workers_dev, false, "the tail worker has no public address");
eq(tail.observability?.enabled, true, "its own drop counts are kept in Cloudflare's logs");
assert(
  String(tail.main ?? "").endsWith("worker/log-tail/index.ts"),
  "and its entry is the tail handler",
);
assert("BETTERSTACK_INGEST_HOST" in (tail.vars ?? {}), "the ingest host is a committed var on the tail worker");

// Slate needs no new secret or setting: nothing in its config or its runtime code
// names Better Stack. The token lives on the tail worker alone.
assert(!Object.keys(slate.vars ?? {}).some((k) => k.startsWith("BETTERSTACK")), "Slate's vars carry no Better Stack setting");

// The handler file is what Cloudflare calls; a tail worker without a `tail` export
// is refused at deploy, which would leave Slate's reference pointing at nothing.
const entry = readFileSync(join(import.meta.dirname, "..", "worker/log-tail/index.ts"), "utf8");
assert(/async tail\(/.test(entry), "the tail worker exports a tail() handler");
{
  // The handler's OWN body is one try/catch (review of #3160). A whole file search
  // for try and catch is satisfied by any catch anywhere, which is not containment.
  const fault = tailHandlerWrapFault(entry);
  assert(fault === null, `and its whole body is wrapped, so it contains its failures (${fault ?? "wrapped"})`);
}

// --- positive controls: the judge must speak (L1) -----------------------------
{
  // The wrap removed while a catch survives elsewhere in the file: exactly the
  // shape the old whole file regex passed.
  const unwrapped = `
    async function helper() { try { await x(); } catch { /* elsewhere */ } }
    const w = { async tail(events: TraceItem[], env: Env): Promise<void> {
      const records = recordsFromTraces(events);
      await shipRecords(records, env, fetch);
    } };`;
  assert(/try\s*\{[\s\S]*\}\s*catch/.test(unwrapped), "control: the old regex is satisfied by this handler");
  assert(tailHandlerWrapFault(unwrapped) !== null, "while the judge names an unwrapped handler");

  const workAfter = `const w = { async tail(events: TraceItem[]): Promise<void> {
      try { a(); } catch (e) { b(e); }
      await shipRecords([], {}, fetch);
    } };`;
  assert(tailHandlerWrapFault(workAfter)?.includes("after") === true, "and work after the try/catch");

  const workBefore = `const w = { async tail(events: TraceItem[]): Promise<void> {
      const r = recordsFromTraces(events);
      try { a(r); } catch (e) { b(e); }
    } };`;
  assert(tailHandlerWrapFault(workBefore)?.includes("first statement") === true, "and work before it");

  const tricky = `const w = { async tail(e: T[]): Promise<void> {
      try { log("a } brace in a string"); /* and } in a comment */ } catch (err) { log(\`\${err}}\`); }
    } };`;
  eq(tailHandlerWrapFault(tricky), null, "a brace inside a string, comment or template does not confuse it");
}

finish();

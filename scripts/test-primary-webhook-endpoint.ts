// The org's primary webhook endpoint is its OLDEST row (#4381).
//
// The webhooks admin page, its save action and its test send each read "the org's
// endpoint" with `.limit(1)`, which was safe while every org had one row. #4381
// adds a second (the dialer's lead sender), and an unordered `.limit(1)` may then
// return either: the admin page would show and SAVE OVER the sender's row as if it
// were Regal's, and a test send could be aimed at the wrong host. This pins the one
// read they now share, and refuses a new unordered single-row read of the table.
//
// Run: node --experimental-strip-types scripts/test-primary-webhook-endpoint.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readPrimaryWebhookEndpoint } from "../src/lib/webhooks/primary-endpoint.ts";
import { assert, eq, finish } from "./lib/harness.ts";

type Call = [string, ...unknown[]];

/** A query builder that records every call, and answers maybeSingle with a fixed row. */
function recordingDb() {
  const calls: Call[] = [];
  const builder: Record<string, (...args: unknown[]) => unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) {
    builder[m] = (...args: unknown[]) => {
      calls.push([m, ...args]);
      return builder;
    };
  }
  builder.maybeSingle = () => {
    calls.push(["maybeSingle"]);
    return Promise.resolve({ data: { id: "ep-regal" }, error: null });
  };
  const db = {
    from: (table: string) => {
      calls.push(["from", table]);
      return builder;
    },
  };
  return { db, calls };
}

{
  const { db, calls } = recordingDb();
  const res = await readPrimaryWebhookEndpoint(db as never, "org-1", "id, url, format");
  eq(res.data, { id: "ep-regal" }, "the row maybeSingle answered is returned as is");
  eq(
    calls,
    [
      ["from", "webhook_endpoints"],
      ["select", "id, url, format"],
      ["eq", "org_id", "org-1"],
      ["order", "created_at", { ascending: true }],
      ["order", "id", { ascending: true }],
      ["limit", 1],
      ["maybeSingle"],
    ],
    "the read is scoped to the org and takes the OLDEST row, with id breaking a tie",
  );
}

// The guard: no other single-row read of webhook_endpoints in src may pick a row
// without this order. A statement that names the table and ends in limit(1) or
// maybeSingle() without an id filter is the shape that broke.
const HELPER = join("src", "lib", "webhooks", "primary-endpoint.ts");

function unorderedSingleRowReads(src: string): string[] {
  const found: string[] = [];
  const re = /\.from\(\s*["']webhook_endpoints["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const end = src.indexOf(";", m.index);
    const stmt = src.slice(m.index, end === -1 ? undefined : end);
    const single = /\.limit\(\s*1\s*\)|\.maybeSingle\(\)|\.single\(\)/.test(stmt);
    const byId = /\.eq\(\s*["']id["']/.test(stmt);
    const write = /\.(insert|update|upsert|delete)\(/.test(stmt);
    if (single && !byId && !write) found.push(stmt.replace(/\s+/g, " ").slice(0, 120));
  }
  return found;
}

// Positive control: the shape the three call sites had is caught, and an id read is not.
eq(
  unorderedSingleRowReads(`db.from("webhook_endpoints").select("id").eq("org_id", o).limit(1).maybeSingle();`).length,
  1,
  "the guard catches an unordered single-row read",
);
eq(
  unorderedSingleRowReads(`db.from("webhook_endpoints").select("*").eq("id", id).eq("org_id", o).maybeSingle();`).length,
  0,
  "a read by primary key is not flagged",
);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const offenders: string[] = [];
for (const file of walk("src")) {
  if (file === HELPER) continue;
  for (const stmt of unorderedSingleRowReads(readFileSync(file, "utf8"))) offenders.push(`${file}: ${stmt}`);
}
assert(
  offenders.length === 0,
  `read the org's endpoint through readPrimaryWebhookEndpoint, never an unordered single-row read:\n  ${offenders.join("\n  ")}`,
);

finish();

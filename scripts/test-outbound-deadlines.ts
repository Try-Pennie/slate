// Every outbound call in server code carries a timeout of its own (#3972, L1028).
//
// Cloudflare kills a Worker invocation at hard deadlines: work after the response
// (`after()`, `ctx.waitUntil`) is cancelled 30 seconds after it (#2922,
// docs/cloudflare-platform-notes.md), and a scheduled tick has its own wall limit. A
// kill runs no catch block, so the failure handling a call carries (a `side_effects`
// "failed" record, an alert, a lane failure page) never runs, and a dependency that
// HANGS goes silent while one that REFUSES is reported. Supabase, Google and token
// mints already go through `fetchWithinBudget` (#3102); this sweep found cal.com, the
// Gmail send, GitHub, Snowflake, the Twilio worker listing and a Slack reply still
// calling the global `fetch` with no bound, including cal.com's time off write inside
// the Slack approve button's `after()`.
//
// The guard (`scripts/lib/scan-outbound-deadlines.ts`) fails on a global `fetch` call
// whose options name no `signal`, and on the global `fetch` handed on as a value,
// unless `// deadline-ok: <why>` names what bounds it instead.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-outbound-deadlines.ts
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { outboundWithoutDeadline, scanTree } from "./lib/scan-outbound-deadlines.ts";

const ROOT = join(import.meta.dirname, "..");

// ---- controls: each shape the scan must see, and each it must let through ----------
const flagged: [string, string][] = [
  ["a bare call", `export async function f() { return fetch("https://x"); }`],
  ["options without a signal", `export async function f() { return fetch("https://x", { method: "POST" }); }`],
  ["options passed through", `export async function f(init: RequestInit) { return fetch("https://x", init); }`],
  ["a spread with no signal of its own", `export async function f(init: RequestInit) { return fetch("https://x", { ...init, method: "GET" }); }`],
  ["handed on as a property", `export const deps = { fetchImpl: fetch };`],
  ["a default", `export function f(impl: typeof fetch = fetch) { return impl; }`],
  ["a fallback", `export function f(impl?: typeof fetch) { return impl ?? fetch; }`],
  ["an argument", `declare function run(f: typeof fetch): void; run(fetch);`],
  ["an opt out with no reason", `// deadline-ok:\nexport async function f() { return fetch("https://x"); }`],
];
for (const [label, src] of flagged) {
  eq(outboundWithoutDeadline("src/lib/x.ts", src).length, 1, `flags ${label}`);
}

const passed: [string, string][] = [
  ["a timeout signal", `export async function f() { return fetch("https://x", { signal: AbortSignal.timeout(5000) }); }`],
  ["a shorthand signal", `export async function f(signal: AbortSignal) { return fetch("https://x", { signal }); }`],
  ["a signal beside a spread", `export async function f(init: RequestInit) { return fetch("https://x", { ...init, signal: init.signal ?? AbortSignal.timeout(1) }); }`],
  ["an opt out on the line", `export const g = (i: string) => fetch(i); // deadline-ok: the inner fetch of fetchWithBudget`],
  ["an opt out in the block above", `// The wrapper lays the deadline over it.\n// deadline-ok: inner fetch of fetchWithBudget\nexport const g = (i: string) => fetch(i);`],
  ["a client module", `"use client";\nexport function f() { return fetch("/api/x"); }`],
  ["a method named fetch", `export const o = { async fetch() { return new Response(); } }; export const r = (s: { fetch(u: string): Promise<Response> }) => s.fetch("u");`],
  ["a type", `export type F = typeof fetch; export interface S { fetch(u: string): Promise<Response> }`],
];
for (const [label, src] of passed) {
  eq(outboundWithoutDeadline("src/lib/x.ts", src).length, 0, `lets through ${label}`);
}

// ---- the tree --------------------------------------------------------------------
const { findings, filesScanned, callsSeen } = scanTree(ROOT);
// Proof it looked (L98): the tree has hundreds of server modules and dozens of fetches.
assert(filesScanned > 500, `scanned the server modules (${filesScanned})`);
assert(callsSeen > 30, `and met the word fetch in them (${callsSeen} times)`);
for (const f of findings) console.error(`  ${f.file}:${f.line} [${f.kind}] ${f.text}`);
eq(findings.length, 0, "every outbound fetch in server code carries its own timeout, or names what bounds it");

finish();

// Keep the load test Worker and take its secrets, then confirm it is idle (#3310).
//
// Thin on purpose: it reads the settings and wrangler.jsonc and hands them, with a real
// request function, to `keepWorkerIdle` in idle-worker.ts, which holds the whole flow and
// is driven against a fake Cloudflare by scripts/test-loadtest-idle-worker.ts. Then it
// prints the verdict and exits on its code.
//
// Run: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... LOADTEST_WORKER_NAME=slate-loadtest \
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/loadtest/keep-worker-idle.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keepWorkerIdle, type CallResult } from "./idle-worker.ts";

// `?? ""` and not a real default: a workflow reference to a setting nobody created
// interpolates the EMPTY STRING (#1498), and an empty value is refused by name.
const token = (process.env.CLOUDFLARE_API_TOKEN ?? "").trim();
const account = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
const configured = (process.env.LOADTEST_WORKER_NAME ?? "").trim();

let wranglerJsonc: string | null;
try {
  wranglerJsonc = readFileSync(join(import.meta.dirname, "..", "..", "wrangler.jsonc"), "utf8");
} catch {
  wranglerJsonc = null;
}

/** One request, returning the status and the body text, or the error that stopped it. */
async function call(method: "GET" | "DELETE", url: string): Promise<CallResult> {
  try {
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, accept: "application/json" } });
    // Text, never `res.json()`: a platform error page is HTML, and a parse that threw
    // here would read as Cloudflare never answering, which is a different cause.
    return { status: res.status, bodyText: await res.text() };
  } catch (err) {
    return { failed: (err as Error).message || String(err) };
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const result = await keepWorkerIdle({ settings: { token, account, configured }, wranglerJsonc, call, sleep });
if (result.idle) console.log(result.message);
else console.error(`FAILED: ${result.message}`);
process.exit(result.exitCode);

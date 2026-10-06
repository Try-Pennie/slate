// Keep the load test Worker and take its secrets, then confirm it is idle (#3310).
//
// Thin on purpose: it reads the settings, checks which Worker it may touch, deletes
// every secret the Worker lists plus the three a run puts, then reads the listing and
// the cron schedules again and exits on the verdict. Every decision is in
// idle-worker.ts and driven offline by scripts/test-loadtest-idle-worker.ts.
//
// Safe to run twice: a secret already gone answers 404, which counts as done. A delete
// that fails does not stop the others, so one failure never leaves the rest in place.
//
// Run: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... LOADTEST_WORKER_NAME=slate-loadtest \
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/loadtest/keep-worker-idle.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOADTEST_ALLOWED_SECRETS } from "../../src/lib/loadtest-secrets.ts";
import {
  idleVerdict,
  loadtestWorkerName,
  readDeleteSecret,
  readSchedules,
  readSecretNames,
  schedulesUrl,
  secretUrl,
  secretsUrl,
  targetRefusal,
  type IdleVerdict,
} from "./idle-worker.ts";

// `?? ""` and not a real default: a workflow reference to a setting nobody created
// interpolates the EMPTY STRING (#1498), and an empty value is refused by name below.
const token = (process.env.CLOUDFLARE_API_TOKEN ?? "").trim();
const account = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
const configured = (process.env.LOADTEST_WORKER_NAME ?? "").trim();

/** One request, returning the status and the body text, or the error that stopped it. */
async function call(method: "GET" | "DELETE", url: string): Promise<{ status: number; bodyText: string } | { failed: string }> {
  try {
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, accept: "application/json" } });
    // Text, never `res.json()`: a platform error page is HTML, and a parse that threw
    // here would read as Cloudflare never answering, which is a different cause.
    return { status: res.status, bodyText: await res.text() };
  } catch (err) {
    return { failed: (err as Error).message || String(err) };
  }
}

async function verdict(): Promise<IdleVerdict> {
  const missing: string[] = [];
  if (!token) missing.push("CLOUDFLARE_API_TOKEN");
  if (!account) missing.push("CLOUDFLARE_ACCOUNT_ID");
  if (!configured) missing.push("LOADTEST_WORKER_NAME");
  if (missing.length > 0) return idleVerdict({ misconfigured: missing });

  let names: ReturnType<typeof loadtestWorkerName> = null;
  try {
    names = loadtestWorkerName(readFileSync(join(import.meta.dirname, "..", "..", "wrangler.jsonc"), "utf8"));
  } catch {
    names = null;
  }
  const refusal = targetRefusal({ configured, names });
  if (refusal !== null || names === null) return idleVerdict({ wrongTarget: refusal ?? "no load test Worker name" });
  const workerName = names.loadtest;

  const before = await call("GET", secretsUrl(account, workerName));
  if ("failed" in before) return idleVerdict({ noAnswer: before.failed });
  const listed = readSecretNames(before.status, before.bodyText);
  if ("exitCode" in listed) return idleVerdict({ read: listed });

  const deleted: string[] = [];
  const failedDeletes: { name: string; why: string }[] = [];
  for (const name of [...new Set([...listed.names, ...LOADTEST_ALLOWED_SECRETS])]) {
    const res = await call("DELETE", secretUrl(account, workerName, name));
    if ("failed" in res) {
      failedDeletes.push({ name, why: `no answer, ${res.failed}` });
      continue;
    }
    const outcome = readDeleteSecret(res.status, res.bodyText);
    if (outcome === "deleted") deleted.push(name);
    else if (outcome !== "absent") failedDeletes.push({ name, why: outcome.why });
  }

  // Idle is what the Worker LISTS afterwards, never what the deletes answered.
  const after = await call("GET", secretsUrl(account, workerName));
  if ("failed" in after) return idleVerdict({ noAnswer: after.failed });
  const remaining = readSecretNames(after.status, after.bodyText);
  if ("exitCode" in remaining) return idleVerdict({ read: remaining });

  const sched = await call("GET", schedulesUrl(account, workerName));
  if ("failed" in sched) return idleVerdict({ noAnswer: sched.failed });
  const schedules = readSchedules(sched.status, sched.bodyText);
  if ("exitCode" in schedules) return idleVerdict({ read: schedules });

  return idleVerdict({ workerName, remaining: remaining.names, crons: schedules.crons, deleted, failedDeletes });
}

const result = await verdict();
if (result.idle) console.log(result.message);
else console.error(`FAILED: ${result.message}`);
process.exit(result.exitCode);

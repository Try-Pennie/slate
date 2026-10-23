/**
 * `pnpm test:e2e`: the browser checks, end to end (#3079, #3100).
 *
 *   1. refuse a checkout carrying a `.env*` or `.dev.vars*` file (the rule is
 *      shared with `pnpm cf:preview`, `scripts/lib/live-env-files.ts`), a second
 *      run while another checkout's is in progress, and anything already
 *      listening on the app's port (`e2e/run-guards.ts`, #4018);
 *   2. start a throwaway local Supabase from the committed migrations;
 *   3. seed it (`e2e/seed.ts`);
 *   4. `next build` and `next start` with an environment built from nothing
 *      (`e2e/env.ts`) and the egress guard loaded into the server;
 *   5. run Playwright (`e2e/playwright.config.ts`);
 *   6. fail the run if the server tried to reach anything that is not this
 *      machine (read from the guard's log AND the server's own output), if the
 *      guard never loaded, or if its log is missing or unreadable, whatever
 *      Playwright said (`e2e/egress-verdict.ts`).
 *
 * Local iteration knobs, none of which CI sets:
 *   E2E_REUSE_STACK=1   keep the stack running between runs (it is reset, not reused dirty)
 *   E2E_SKIP_BUILD=1    reuse the last `.next` build (only when nothing under src changed)
 *
 * Arguments after `--` go to `playwright test` (a file, `--grep`, `--headed`).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  E2E_APP_ORIGIN,
  E2E_APP_PORT,
  e2eServerEnv,
  envFileRefusal,
  localStackRefusal,
  type LocalStack,
} from "./env.ts";
import { seedStack } from "./seed.ts";
import { egressVerdict } from "./egress-verdict.ts";
import { acquireRunLock, portHolders, portInUseRefusal, waitForOwnServer } from "./run-guards.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKDIR = join(tmpdir(), "slate-e2e-supabase");
const ARTIFACTS = join(ROOT, "e2e", ".artifacts");
const EGRESS_LOG = join(ARTIFACTS, "egress.log");
const reuseStack = process.env.E2E_REUSE_STACK === "1";
const skipBuild = process.env.E2E_SKIP_BUILD === "1";

function say(line: string): void {
  console.log(`[e2e] ${line}`);
}

function supabase(args: string[], opts: { allowFail?: boolean } = {}): string {
  const res = spawnSync("supabase", [...args, "--workdir", WORKDIR], {
    encoding: "utf8",
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0 && !opts.allowFail) {
    throw new Error(`supabase ${args.join(" ")} failed (${res.status}):\n${res.stdout}\n${res.stderr}`);
  }
  return res.status === 0 ? res.stdout : "";
}

/** The committed config and migrations, copied into a scratch workdir. */
function prepareWorkdir(): void {
  rmSync(join(WORKDIR, "supabase", "migrations"), { recursive: true, force: true });
  mkdirSync(join(WORKDIR, "supabase", "migrations"), { recursive: true });
  cpSync(join(ROOT, "e2e", "supabase.config.toml"), join(WORKDIR, "supabase", "config.toml"));
  for (const f of readdirSync(join(ROOT, "supabase", "migrations"))) {
    if (f.endsWith(".sql")) {
      cpSync(join(ROOT, "supabase", "migrations", f), join(WORKDIR, "supabase", "migrations", f));
    }
  }
}

function readStack(): LocalStack {
  const raw = supabase(["status", "-o", "json"]);
  const json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as Record<string, string>;
  return {
    apiUrl: json.API_URL ?? "",
    dbUrl: json.DB_URL ?? "",
    publishableKey: json.PUBLISHABLE_KEY ?? "",
    secretKey: json.SECRET_KEY ?? "",
    mailpitUrl: json.MAILPIT_URL ?? json.INBUCKET_URL ?? "",
  };
}

function startStack(): LocalStack {
  prepareWorkdir();
  const running = supabase(["status", "-o", "json"], { allowFail: true }) !== "";
  if (running && reuseStack) {
    say("resetting the running local Supabase to the committed migrations");
    supabase(["db", "reset", "--local", "--no-seed"]);
  } else {
    if (running) supabase(["stop", "--no-backup"], { allowFail: true });
    say("starting a throwaway local Supabase");
    supabase(["start"]);
  }
  const stack = readStack();
  const refusal = localStackRefusal(stack);
  if (refusal) throw new Error(refusal);
  return stack;
}

function basics(): { PATH?: string; HOME?: string; TMPDIR?: string } {
  return { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
}

const NEXT_BIN = join(ROOT, "node_modules", "next", "dist", "bin", "next");

/** The env built from nothing, typed for `spawn` (Next's types make NODE_ENV required). */
function asProcessEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  return env as NodeJS.ProcessEnv;
}

function build(env: Record<string, string>): void {
  say("building the app for production (next build)");
  const res = spawnSync(process.execPath, [NEXT_BIN, "build"], {
    cwd: ROOT,
    env: asProcessEnv(env),
    stdio: "inherit",
  });
  if (res.status !== 0) throw new Error(`next build failed (${res.status})`);
}

/** Ready only once OUR server says it is listening and is still running (#4018). */
function waitForServer(server: ChildProcess, output: () => string): Promise<void> {
  return waitForOwnServer({
    exitCode: () => server.exitCode,
    output,
    answers: async () => {
      try {
        const res = await fetch(`${E2E_APP_ORIGIN}/login`, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
        return res.status < 500;
      } catch {
        return false; // Not answering yet.
      }
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    timeoutMs: 60_000,
    origin: E2E_APP_ORIGIN,
  });
}

/** One browser run per machine at a time: they share the local Supabase and the port (#4018). */
const RUN_LOCK = join(tmpdir(), "slate-e2e-run.lock");

function stopServer(server: ChildProcess | null): void {
  if (!server?.pid || server.exitCode !== null) return;
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill("SIGTERM");
  }
}

/** Stops the server and waits (bounded) for it to exit, so its output is complete. */
async function stopServerAndWait(server: ChildProcess | null): Promise<void> {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
  stopServer(server);
  await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 10_000))]);
}

/** The guard's log, or null with the reason when it is missing or unreadable. */
function readEgressLog(): { log: string | null; logProblem?: string } {
  if (!existsSync(EGRESS_LOG)) return { log: null, logProblem: "the file is missing" };
  try {
    return { log: readFileSync(EGRESS_LOG, "utf8") };
  } catch (err) {
    return { log: null, logProblem: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<number> {
  const refusal = envFileRefusal(readdirSync(ROOT));
  if (refusal) throw new Error(refusal);

  // Before the stack is touched: a second run would stop or reset the first one's.
  const lock = acquireRunLock(RUN_LOCK, { pid: process.pid, checkout: ROOT });
  if (!lock.ok) throw new Error(lock.refusal);
  try {
    return await runLocked();
  } finally {
    lock.release();
  }
}

async function runLocked(): Promise<number> {
  // A server already on the port would answer for ours (#4018, L797).
  const portRefusal = portInUseRefusal(E2E_APP_PORT, await portHolders(E2E_APP_PORT));
  if (portRefusal) throw new Error(portRefusal);

  rmSync(ARTIFACTS, { recursive: true, force: true });
  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(EGRESS_LOG, "");

  const stack = startStack();
  let server: ChildProcess | null = null;
  // Collected outside the try, and written in the finally, so a server that fails
  // to start keeps the output that says why.
  const serverLog: string[] = [];
  try {
    say("seeding the local database");
    const seeded = await seedStack(stack);

    const env = e2eServerEnv(stack, basics());
    if (!skipBuild) build(env);

    say(`starting the production server on ${E2E_APP_ORIGIN}`);
    const started = spawn(
      process.execPath,
      [NEXT_BIN, "start", "-p", String(E2E_APP_PORT), "-H", "localhost"],
      {
        cwd: ROOT,
        env: asProcessEnv({
          ...env,
          E2E_EGRESS_LOG: EGRESS_LOG,
          NODE_OPTIONS: `--import ${JSON.stringify(join(ROOT, "e2e", "egress-guard.mjs"))}`,
        }),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    server = started;
    started.stdout?.on("data", (d) => serverLog.push(String(d)));
    started.stderr?.on("data", (d) => serverLog.push(String(d)));
    await waitForServer(started, () => serverLog.join(""));

    const extra = process.argv.slice(2).filter((a) => a !== "--");
    const pw = spawnSync(
      process.execPath,
      [join(ROOT, "node_modules", "@playwright", "test", "cli.js"), "test", "-c", join(ROOT, "e2e", "playwright.config.ts"), ...extra],
      {
        cwd: ROOT,
        stdio: "inherit",
        env: {
          ...process.env,
          E2E_STACK: JSON.stringify(stack),
          E2E_SEED: JSON.stringify(seeded),
        },
      },
    );
    // Stop the server before judging, so every line it printed is in hand.
    await stopServerAndWait(server);
    const egress = egressVerdict({
      loaded: existsSync(`${EGRESS_LOG}.loaded`),
      ...readEgressLog(),
      serverOutput: serverLog.join(""),
    });
    if (egress) {
      console.error(`[e2e] FAIL: ${egress}`);
      return 1;
    }
    say("egress guard: loaded, and the server reached nothing beyond this machine");
    return pw.status ?? 1;
  } finally {
    writeFileSync(join(ARTIFACTS, "server.log"), serverLog.join(""));
    stopServer(server);
    if (!reuseStack) supabase(["stop", "--no-backup"], { allowFail: true });
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[e2e] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);

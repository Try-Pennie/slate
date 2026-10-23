// The browser run must test the build THIS checkout made (#4018, L797).
//
// `e2e/run.ts` serves on a fixed port (3100, which the local auth server's redirect
// list names) against one machine wide local Supabase. Before this, a second run from
// another worktree stopped the first run's stack, and its own `next start` died on
// EADDRINUSE while the readiness poll accepted the FIRST run's server answering on the
// port, so the specs ran against a build this checkout never made. Reproduced on
// 2026-10-23 with the old poll copied verbatim: it returned ready while the spawned
// server had exited with EADDRINUSE.
//
// Three guards, each driven here without a stack:
//   - one run per machine at a time, by a lock file whose holder is a live process;
//   - nothing may already be listening on the port, on either loopback family;
//   - ready means OUR server said it is listening and is still running, never merely
//     that something answered on the port.
//
// Run: node --experimental-strip-types scripts/test-e2e-run-guards.ts
import { createServer, type Server } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { acquireRunLock, portHolders, portInUseRefusal, waitForOwnServer } from "../e2e/run-guards.ts";

// Next prints a check mark before its ready line, built from its code point here.
const READY = ` ${String.fromCodePoint(0x2713)} Ready in 412ms\n`;

const dir = mkdtempSync(join(tmpdir(), "slate_e2e_guards_"));
const lockPath = join(dir, "run.lock");

// ---- the run lock -----------------------------------------------------------------
{
  const alive = new Set<number>([111, 222]);
  const isAlive = (pid: number) => alive.has(pid);

  const a = acquireRunLock(lockPath, { pid: 111, checkout: "/work/checkout_a" }, { isAlive });
  assert(a.ok, "the first run takes the lock");

  const b = acquireRunLock(lockPath, { pid: 222, checkout: "/work/checkout_b" }, { isAlive });
  assert(!b.ok, "a second run is refused while the first run's process is alive");
  if (!b.ok) {
    assert(b.refusal.includes("/work/checkout_a") && b.refusal.includes("111"), `the refusal names the holder's checkout and pid: ${b.refusal}`);
  }

  // The holder died without releasing (killed, crashed): its lock is stale.
  alive.delete(111);
  const c = acquireRunLock(lockPath, { pid: 222, checkout: "/work/checkout_b" }, { isAlive });
  assert(c.ok, "a lock whose holder is no longer running is taken over");

  // The dead run's release must not remove the lock the live run now holds.
  if (a.ok) a.release();
  assert(JSON.parse(readFileSync(lockPath, "utf8")).pid === 222, "a superseded holder's release leaves the new holder's lock in place");
  if (c.ok) c.release();
  const d = acquireRunLock(lockPath, { pid: 333, checkout: "/work/checkout_c" }, { isAlive });
  assert(d.ok, "the holder's own release frees the lock");
  if (d.ok) d.release();

  // An unreadable lock file (a write cut off part way) proves no live holder.
  writeFileSync(lockPath, "{not json");
  const e = acquireRunLock(lockPath, { pid: 444, checkout: "/work/checkout_d" }, { isAlive });
  assert(e.ok, "an unreadable lock file is treated as stale, not as held for ever");
  if (e.ok) e.release();
}

// ---- the port --------------------------------------------------------------------
function listen(host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer((sock) => sock.end());
    s.once("error", reject);
    s.listen(0, host, () => resolve(s));
  });
}

{
  const held = await listen("127.0.0.1");
  const port = (held.address() as { port: number }).port;
  const holders = await portHolders(port);
  assert(holders.includes("127.0.0.1"), `a server already on the port is found (${JSON.stringify(holders)})`);
  const refusal = portInUseRefusal(port, holders);
  assert(refusal !== null && refusal.includes(String(port)), `and refused, naming the port: ${refusal}`);
  await new Promise<void>((r) => held.close(() => r()));
  const after = await portHolders(port);
  eq(after.length, 0, "a free port has no holders");
  eq(portInUseRefusal(port, after), null, "and is not refused");
}

// ---- readiness -------------------------------------------------------------------
type Fake = { exit: number | null; out: string; answers: boolean };
function deps(f: Fake, step: (n: number) => void = () => {}) {
  let clock = 0;
  let polls = 0;
  return {
    exitCode: () => f.exit,
    output: () => f.out,
    answers: async () => f.answers,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
      step(++polls);
    },
    timeoutMs: 5_000,
    origin: "http://localhost:3100",
  };
}

async function outcome(p: Promise<void>): Promise<string> {
  try {
    await p;
    return "ready";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

{
  // THE DEFECT: another checkout's server answers on the port while ours is still
  // starting, then ours dies on EADDRINUSE. The old poll returned ready on the first answer.
  const f: Fake = { exit: null, out: "", answers: true };
  const r = await outcome(waitForOwnServer(deps(f, (n) => {
    if (n === 2) {
      f.out = "Error: listen EADDRINUSE: address already in use :::3100";
      f.exit = 1;
    }
  })));
  assert(r !== "ready", "an answer on the port before our server says it is listening is not ready");
  assert(r.includes("EADDRINUSE") || r.toLowerCase().includes("already"), `our server dying on a taken port is named as such: ${r}`);
}

{
  // Our server printed its ready line and something answers: ready.
  const f: Fake = { exit: null, out: "", answers: false };
  const r = await outcome(waitForOwnServer(deps(f, (n) => {
    if (n === 1) f.out = `   Local: http://localhost:3100\n${READY}`;
    if (n === 2) f.answers = true;
  })));
  eq(r, "ready", "our own server, listening and answering, is ready");
}

{
  // Ready line printed, but the server then exited: not ready.
  const f: Fake = { exit: null, out: READY, answers: true };
  const d = deps(f);
  f.exit = 0;
  const r = await outcome(waitForOwnServer(d));
  assert(r !== "ready" && r.includes("exited"), `a server that exited is never ready, ready line or not: ${r}`);
}

{
  // Never says ready: times out on the injected clock, not on real time.
  const f: Fake = { exit: null, out: "", answers: true };
  const r = await outcome(waitForOwnServer(deps(f)));
  assert(r.includes("did not") && r.includes("3100"), `a server that never reports listening times out, naming the origin: ${r}`);
}

rmSync(dir, { recursive: true, force: true });
finish();

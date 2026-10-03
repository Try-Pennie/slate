// The server half of "the browser checks cannot reach a real system" (#3079, #3100).
//
// Loaded into `next start` with `NODE_OPTIONS=--import`, so it runs in the server
// process and in every node process that one starts, before any application code.
// It patches the ONE place every outbound TCP connection passes through,
// `net.Socket.prototype.connect`: `fetch` (undici), `http`, `https`, `tls` and the
// `pg` driver all end there, so a leak through a client nobody thought of is still
// caught. A connection to anything that is not this machine is REFUSED (the socket
// errors before a byte leaves) and RECORDED, one JSON line per attempt, in the file
// named by E2E_EGRESS_LOG. The runner fails the run on any line, because a refused
// connection usually surfaces in the app as an ordinary handled error and would
// otherwise pass.
//
// It refuses rather than merely records on purpose: recording alone would let the
// first leak land somewhere real before the run turned red (L2).
//
// A host given as a name rather than an address is judged by the NAME, never by
// resolving it, because resolution is itself a request outward and a name that
// happens to resolve to loopback today is not a promise.
import net from "node:net";
import { appendFileSync } from "node:fs";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "::ffff:127.0.0.1"]);
const logPath = process.env.E2E_EGRESS_LOG;

function targetOf(args) {
  const first = args[0];
  if (Array.isArray(first)) return targetOf(first);
  if (first && typeof first === "object") {
    if (typeof first.path === "string") return { local: true, host: first.path };
    return { local: false, host: String(first.host ?? "localhost"), port: first.port };
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return { local: true, host: first };
  return { local: false, host: typeof args[1] === "string" ? args[1] : "localhost", port: first };
}

const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const target = targetOf(args);
  // A unix socket path never leaves the machine.
  if (target.local || LOOPBACK.has(target.host.toLowerCase())) {
    return original.apply(this, args);
  }
  const line = JSON.stringify({ host: target.host, port: target.port ?? null, at: new Date().toISOString() });
  if (logPath) {
    try {
      appendFileSync(logPath, `${line}\n`);
    } catch {
      // The refusal below still stands; the runner also refuses a run whose log it
      // cannot read, so an unwritable log cannot pass as an empty one.
    }
  }
  const err = new Error(`e2e egress guard: refused a connection to ${target.host}:${target.port ?? "?"}`);
  err.code = "E2E_EGRESS_REFUSED";
  process.nextTick(() => this.destroy(err));
  return this;
};

// Marks the process so the runner can confirm the guard really loaded: a server
// started without it would answer every request and record nothing, which reads
// exactly like a clean run (L98).
globalThis.__slateE2eEgressGuard = true;
if (logPath) {
  try {
    appendFileSync(`${logPath}.loaded`, `${process.pid}\n`);
  } catch {
    // Absent marker refuses the run.
  }
}

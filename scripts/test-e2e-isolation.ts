// The browser checks must be structurally unable to reach a real system (#3079,
// #3100, L2). This drives the two pieces that make that true without a stack:
//
//   - `e2e/env.ts`, which builds the server's environment from nothing and refuses
//     a stack, or a checkout, that could point the build somewhere live;
//   - `e2e/egress-guard.mjs`, which refuses every outbound connection that is not
//     to this machine and records it.
//
// The guard is exercised in a real child process, the way the runner loads it,
// and each direction is asserted: a connection outward must be REFUSED by the
// guard (its own error code, not a sandbox's network error, L156) and RECORDED,
// and a loopback connection must still work. A guard that refused everything
// would pass the first half and fail the second; one that loaded nothing would
// fail both.
//
// Run: node --experimental-strip-types scripts/test-e2e-isolation.ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, finish } from "./lib/harness.ts";
import {
  E2E_PUBLIC_APP_URL,
  e2eServerEnv,
  envFileRefusal,
  isLoopbackHost,
  localStackRefusal,
  type LocalStack,
} from "../e2e/env.ts";
import { PRODUCTION_SUPABASE_REF } from "../src/lib/loadtest-guard.ts";
import { EGRESS_REFUSED_MARKER, egressVerdict } from "../e2e/egress-verdict.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const LOCAL: LocalStack = {
  apiUrl: "http://127.0.0.1:54421",
  dbUrl: "postgresql://postgres:postgres@127.0.0.1:54422/postgres",
  publishableKey: "sb_publishable_local",
  secretKey: "sb_secret_local",
  mailpitUrl: "http://127.0.0.1:54424",
};

// --- the stack refusal -----------------------------------------------------------

assert(localStackRefusal(LOCAL) === null, "a loopback stack with keys is accepted");
assert(
  localStackRefusal({ ...LOCAL, apiUrl: `https://${PRODUCTION_SUPABASE_REF}.supabase.co` }) !== null,
  "the production project's API address is refused",
);
assert(
  localStackRefusal({ ...LOCAL, dbUrl: "postgresql://postgres:x@db.example.com:5432/postgres" }) !== null,
  "a database on another machine is refused",
);
assert(
  localStackRefusal({ ...LOCAL, secretKey: `sb_secret_${PRODUCTION_SUPABASE_REF}` }) !== null,
  "any value naming the production project is refused, not only an address",
);
assert(localStackRefusal({ ...LOCAL, apiUrl: "not a url" }) !== null, "an unreadable address refuses");
assert(localStackRefusal({ ...LOCAL, secretKey: "" }) !== null, "a stack with no keys refuses");
assert(isLoopbackHost("127.0.0.1") && isLoopbackHost("localhost") && isLoopbackHost("::1"), "loopback names");
assert(!isLoopbackHost("127.0.0.1.example.com"), "a name that merely starts like loopback is not loopback");

// --- the env file refusal -----------------------------------------------------------

assert(envFileRefusal([".env.example", "package.json"]) === null, "the committed template is not a refusal");
for (const f of [".env", ".env.local", ".env.production", ".env.production.local", ".dev.vars"]) {
  assert(envFileRefusal([f]) !== null, `${f} in the checkout refuses the build`);
}

// --- the server environment ----------------------------------------------------------

const env = e2eServerEnv(LOCAL, { PATH: "/usr/bin", HOME: "/home/x" });
assert(env.SLATE_LOADTEST === "true", "the server runs with every outside system synthetic");
assert(env.NEXT_PUBLIC_SUPABASE_URL === LOCAL.apiUrl, "the build is pointed at the local API");
assert(env.NEXT_PUBLIC_APP_URL === E2E_PUBLIC_APP_URL, "public links are built on a name that cannot resolve");
assert(new URL(env.NEXT_PUBLIC_APP_URL).hostname.endsWith(".invalid"), "the public URL is under .invalid");
for (const name of [
  "SLACK_BOT_TOKEN",
  "GOOGLE_SA_PRIVATE_KEY",
  "SF_CLIENT_SECRET",
  "CALCOM_API_KEY",
  "TWILIO_API_KEY_SECRET",
  "CRON_SECRET",
]) {
  assert(!(name in env), `${name} is never handed to the server`);
}
{
  // The parent's environment contributes nothing but the basics: set a secret in
  // THIS process and confirm it does not ride along.
  process.env.SLACK_BOT_TOKEN = "xoxb-should-not-leak";
  const built = e2eServerEnv(LOCAL, { PATH: process.env.PATH });
  assert(!Object.values(built).includes("xoxb-should-not-leak"), "an exported shell secret does not reach the server");
  delete process.env.SLACK_BOT_TOKEN;
}
{
  let threw = false;
  try {
    e2eServerEnv({ ...LOCAL, apiUrl: `https://${PRODUCTION_SUPABASE_REF}.supabase.co` }, {});
  } catch (err) {
    threw = String(err).includes(PRODUCTION_SUPABASE_REF);
  }
  assert(threw, "building a server environment for the production project throws, naming it");
}

// --- the egress guard, in a real child process ---------------------------------------

const dir = mkdtempSync(join(tmpdir(), "slate-egress-"));
const log = join(dir, "egress.log");
const probe = `
import http from "node:http";
const server = http.createServer((_q, s) => s.end("ok"));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const out = {};
try { out.local = await (await fetch("http://127.0.0.1:" + port + "/")).text(); } catch (e) { out.local = "error " + e; }
try { await fetch("https://example.com/"); out.remote = "reached"; } catch (e) { out.remote = e?.cause?.code ?? e?.code ?? String(e); }
await new Promise((r) => { const req = http.get("http://example.org/", () => { out.http = "reached"; r(); }); req.on("error", (e) => { out.http = e.code; r(); }); });
server.close();
console.log(JSON.stringify(out));
`;
const run = spawnSync(
  process.execPath,
  ["--import", join(ROOT, "e2e", "egress-guard.mjs"), "--input-type=module", "-e", probe],
  { env: { PATH: process.env.PATH ?? "", E2E_EGRESS_LOG: log }, encoding: "utf8", timeout: 30_000 },
);
let result: { local?: string; remote?: string; http?: string } = {};
try {
  result = JSON.parse(run.stdout.trim().split("\n").pop() ?? "{}");
} catch {
  console.error(run.stdout, run.stderr);
}
assert(result.local === "ok", `a loopback connection still works under the guard (got ${result.local})`);
assert(
  result.remote === "E2E_EGRESS_REFUSED",
  `fetch to another machine is refused BY THE GUARD, not by the network (got ${result.remote})`,
);
assert(result.http === "E2E_EGRESS_REFUSED", `node:http to another machine is refused too (got ${result.http})`);
const recorded = existsSync(log) ? readFileSync(log, "utf8") : "";
assert(recorded.includes("example.com") && recorded.includes("example.org"), "both refusals are recorded for the runner");
assert(!recorded.includes("127.0.0.1"), "a loopback connection is not recorded as egress");
assert(existsSync(`${log}.loaded`), "the guard leaves a marker the runner checks, so an unloaded guard cannot pass as a clean run");
const printedRefusals = run.stderr.split("\n").filter((l) => l.includes(EGRESS_REFUSED_MARKER));
assert(
  printedRefusals.some((l) => l.includes("example.com")) && printedRefusals.some((l) => l.includes("example.org")),
  "every refusal is ALSO printed on the server's stderr, a second record independent of the log (L345)",
);
rmSync(dir, { recursive: true, force: true });

// --- the runner's verdict over that evidence ------------------------------------------

{
  const clean = { loaded: true, log: "", serverOutput: "ready on localhost:3100\n" };
  assert(egressVerdict(clean) === null, "a loaded guard, an empty log and quiet output pass");
  const verdicts = [
    egressVerdict({ ...clean, loaded: false }),
    egressVerdict({ ...clean, log: null, logProblem: "the file is missing" }),
    egressVerdict({ ...clean, log: '{"host":"example.com"}\n' }),
    egressVerdict({ ...clean, serverOutput: `${EGRESS_REFUSED_MARKER} {"host":"example.com"}\n` }),
  ];
  assert(verdicts.every((v) => v !== null), "an unloaded guard, a missing log, a logged refusal and a printed refusal each fail");
  assert(/never loaded/.test(verdicts[0]!), "an unloaded guard says so");
  assert(/could not be read \(the file is missing\)/.test(verdicts[1]!), "a missing log is its own failure, never read as an empty one");
  assert(/refused it/.test(verdicts[2]!), "a logged refusal names it");
  assert(/own output/.test(verdicts[3]!), "a refusal only the server's output carries still fails, saying where it was seen");
  assert(new Set(verdicts).size === verdicts.length, "the four causes carry four different messages (L11)");
}

finish();

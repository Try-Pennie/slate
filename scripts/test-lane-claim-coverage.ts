// #4222: every scheduled cron lane claims its tick before any work.
//
// A lane re-sent after a relay failure (#4189) is harmless only if its route claims
// (tick id, lane) in lane_runs FIRST: a read, a lock, a heartbeat or a write ahead of the
// claim runs twice on a re-send. So every route the dispatcher drives (derived from
// CRON_ROUTES, so a new lane is covered by construction, L96) must make its first awaited
// call
//
//   const <name> = await claimLaneTick(req.headers, "<its own path>");
//   if (<name>) return <name>;
//
// straight after the cron secret check, which awaits nothing. The path is checked
// against the file's own, because a copied line naming another lane would claim the
// wrong key and let this one run twice. Comments are stripped first, so a comment that
// mentions an await cannot stand in for the call.
//
// What it cannot see: work done synchronously before the claim (nothing in a handler
// reaches the database or the network without awaiting), and a lane route not in
// CRON_ROUTES, which the dispatcher never sends.
//
// Run: node --experimental-strip-types scripts/test-lane-claim-coverage.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CRON_ROUTES } from "../worker/cron-routes.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const root = join(import.meta.dirname, "..");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Null when the handler claims its tick first, else what is wrong. */
export function claimFirstProblem(source: string, path: string): string | null {
  const code = stripComments(source);
  const start = code.indexOf("export async function GET(");
  if (start < 0) return "has no exported async GET handler";
  const body = code.slice(start);
  const firstAwait = body.search(/\bawait\b/);
  if (firstAwait < 0) return "awaits nothing, so it never claims its tick";
  const claim = new RegExp(
    `^await claimLaneTick\\(req\\.headers, "${escape(path)}"\\);\\s*if \\((\\w+)\\) return \\1;`,
  );
  const before = body.slice(0, firstAwait);
  const assigned = /const (\w+) = $/.exec(before);
  const rest = body.slice(firstAwait);
  const match = claim.exec(rest);
  if (!match) {
    const other = /^await claimLaneTick\(req\.headers, "([^"]*)"\)/.exec(rest);
    if (other && other[1] !== path) return `claims "${other[1]}", not its own path "${path}"`;
    if (other) return "does not return the claim's answer when it refuses";
    return `awaits ${JSON.stringify(rest.slice(0, 60).split("\n")[0])} before claiming its tick`;
  }
  if (!assigned || assigned[1] !== match[1]) return "does not return the claim's answer when it refuses";
  return null;
}

// --- the checker, against planted handlers (L1) -----------------------------------------
const AUTH = `export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }
`;
const P = "/api/cron/sync";
eq(
  claimFirstProblem(`${AUTH}  const claimed = await claimLaneTick(req.headers, "${P}");\n  if (claimed) return claimed;\n  const lock = await acquireLock("x", 1);\n}`, P),
  null,
  "a handler that claims first passes",
);
const planted: Array<[string, string, RegExp]> = [
  [`${AUTH}  const lock = await acquireLock("x", 1);\n  const claimed = await claimLaneTick(req.headers, "${P}");\n  if (claimed) return claimed;\n}`, "a lock before the claim", /acquireLock/],
  [`${AUTH}  await recordHeartbeat("x");\n}`, "no claim at all", /recordHeartbeat/],
  [`${AUTH}  const claimed = await claimLaneTick(req.headers, "/api/cron/recompute");\n  if (claimed) return claimed;\n}`, "another lane's path", /recompute/],
  [`${AUTH}  await claimLaneTick(req.headers, "${P}");\n  const lock = await acquireLock("x", 1);\n}`, "the claim's answer ignored", /awaits|answer/],
  [`${AUTH}  const claimed = await claimLaneTick(req.headers, "${P}");\n  const lock = await acquireLock("x", 1);\n}`, "the refusal not returned", /awaits|answer/],
  [`${AUTH}  // await claimLaneTick(req.headers, "${P}");\n  const lock = await acquireLock("x", 1);\n}`, "a commented out claim", /acquireLock/],
  [`export async function POST(req: NextRequest) {\n  return null;\n}`, "no GET handler", /GET/],
];
for (const [source, what, says] of planted) {
  const problem = claimFirstProblem(source, P);
  assert(problem !== null && says.test(problem), `the checker refuses ${what} (${problem})`);
}

// --- every scheduled lane ----------------------------------------------------------------
const paths = [...new Set(Object.values(CRON_ROUTES).flatMap((v) => (Array.isArray(v) ? v : [v])))];
assert(paths.length >= 25, `found the scheduled lanes from CRON_ROUTES (${paths.length})`);
for (const path of paths) {
  const file = join(root, "src", "app", ...path.split("/").filter(Boolean), "route.ts");
  if (!existsSync(file)) {
    assert(false, `${path} has a route file at ${file}`);
    continue;
  }
  const problem = claimFirstProblem(readFileSync(file, "utf8"), path);
  assert(problem === null, `${path} claims its tick before any work${problem ? `: it ${problem}` : ""}`);
}

finish();

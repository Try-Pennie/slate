// #3561: an object Worker (the confirm line's, the burst limiter's, the token holder's) is
// redeployed only when what would be deployed differs from what is serving. A Worker
// deploy restarts its Durable Objects, so a needless one drops whatever a line object
// holds in memory, and it puts exit 26 in front of a Slate deploy that never touched it.
//
// The skip is decided from something MEASURED: a hash of the bundle wrangler builds, the
// wrangler config text, the environment and the wrangler version, compared against the
// same hash stamped on the serving version's message when it was deployed. Never from a
// list of paths (L96, L312). Every way the comparison can fail to be made deploys.
//
// Run: node --experimental-strip-types scripts/test-object-worker-skip.ts
import {
  OBJECT_BUNDLE_MESSAGE_PREFIX,
  decideObjectWorker,
  deployObjectWorkers,
  objectBundleHash,
  objectBundleStamp,
  stampFromMessage,
  type BundleInput,
  type ObjectWorkerFacts,
  type ObjectWorkerOps,
} from "./lib/object-worker-skip.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const SERVING = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const BASE: BundleInput = {
  config: "wrangler.confirm-line.jsonc",
  configText: '{ "name": "slate-confirm-line", "main": "worker/confirm-line/index.ts" }',
  env: "",
  wranglerVersion: "4.147.0",
  files: [
    { path: "index.js", bytes: "export class ConfirmLine {}" },
    { path: "index.js.map", bytes: '{"sources":["/home/runner/work/a"]}' },
    { path: "README.md", bytes: "generated at 2026-10-16T20:48:31.401Z" },
  ],
};

const hashOf = (over: Partial<BundleInput>) => objectBundleHash({ ...BASE, ...over });
const base = objectBundleHash(BASE);

// --- the hash: what it covers, and what it deliberately leaves out -------------------
{
  assert(base !== null && /^[0-9a-f]{64}$/.test(base), `the hash is a sha256 in hex (got ${base})`);
  eq(objectBundleHash(BASE), base, "the same inputs hash the same, so an unchanged Worker can be recognised");
  eq(hashOf({ files: [...BASE.files].reverse() }), base, "the order the output files are listed in does not matter");
  // Measured 2026-10-16 with wrangler 4.147.0: two dry runs of each object Worker into two
  // directories gave byte identical index.js, and a different index.js.map and README.md
  // every time (the map names the output directory, the README carries a timestamp).
  eq(
    hashOf({ files: [BASE.files[0], { path: "index.js.map", bytes: "different" }, { path: "README.md", bytes: "another time" }] }),
    base,
    "a source map or README that differs between two builds of the same code does not move the hash",
  );
  assert(hashOf({ files: [{ path: "index.js", bytes: "export class ConfirmLine { x }" }] }) !== base, "a changed bundle moves the hash");
  assert(
    hashOf({ files: [...BASE.files, { path: "chunk.wasm", bytes: "\u0000asm" }] }) !== base,
    "an extra module in the output moves the hash (only maps and the README are left out)",
  );
  assert(
    hashOf({ configText: BASE.configText.replace("}", ', "compatibility_date": "2026-01-01" }') }) !== base,
    "a changed wrangler config moves the hash, so the skip never applies to a Worker whose config changed",
  );
  assert(hashOf({ env: "loadtest" }) !== base, "the load test environment hashes apart from production");
  assert(hashOf({ wranglerVersion: "4.148.0" }) !== base, "a different wrangler hashes apart, since it is what uploads the bundle");
  assert(hashOf({ config: "wrangler.burst-limiter.jsonc" }) !== base, "two Workers never share a hash");
  eq(hashOf({ files: [] }), null, "an output holding no module is not a bundle, so it has no hash");
  eq(
    hashOf({ files: [{ path: "index.js.map", bytes: "x" }, { path: "README.md", bytes: "y" }] }),
    null,
    "nor does one holding only a map and a README",
  );
  eq(hashOf({ wranglerVersion: "" }), null, "an unknown wrangler version gives no hash rather than a hash of nothing");
  eq(hashOf({ configText: "" }), null, "an unreadable config gives no hash");
}

// --- the stamp written on the deployed version, and read back ----------------------
{
  const stamp = objectBundleStamp(base!);
  assert(stamp.startsWith(OBJECT_BUNDLE_MESSAGE_PREFIX), "the stamp is a prefixed message");
  assert(stamp.length <= 100, `the stamp fits a version message (${stamp.length} characters; Cloudflare keeps 100)`);
  eq(stampFromMessage(stamp), base, "a stamp reads back as its hash");
  eq(stampFromMessage(null), null, "no message, no stamp");
  eq(stampFromMessage("deployed by hand"), null, "a message that is not a stamp is no stamp");
  eq(stampFromMessage(`${OBJECT_BUNDLE_MESSAGE_PREFIX}abc`), null, "a truncated stamp is no stamp");
  eq(stampFromMessage(`${OBJECT_BUNDLE_MESSAGE_PREFIX}${base!.toUpperCase()}`), null, "nor is one in the wrong case");
}

// --- the decision: skip only on a proved identical bundle --------------------------
const view = (message: string | null, id = SERVING) => ({ id, tag: null, message });
const same: ObjectWorkerFacts = {
  localHash: base,
  deployed: [{ versionId: SERVING, percentage: 100 }],
  view: view(objectBundleStamp(base!)),
};
{
  const d = decideObjectWorker(same);
  eq(d.action, "skip", "the serving version carries this exact bundle's stamp: skipped");
  assert(d.reason.includes(SERVING) && d.reason.includes(base!.slice(0, 12)), `and the reason names the version and the hash (${d.reason})`);
}
const deploys: [string, ObjectWorkerFacts][] = [
  ["the local bundle could not be built or hashed", { ...same, localHash: null }],
  ["what is deployed could not be read", { ...same, deployed: null }],
  ["nothing is deployed yet", { ...same, deployed: [] }],
  ["the Worker is split across two versions", { ...same, deployed: [{ versionId: SERVING, percentage: 50 }, { versionId: OTHER, percentage: 50 }] }],
  ["the one version is not at 100%", { ...same, deployed: [{ versionId: SERVING, percentage: 90 }] }],
  ["the serving version could not be read", { ...same, view: null }],
  ["the version read is not the one serving", { ...same, view: view(objectBundleStamp(base!), OTHER) }],
  ["the serving version carries no stamp (deployed by hand, by a secret change, or before #3561)", { ...same, view: view(null) }],
  ["the serving version's message is not a stamp", { ...same, view: view("deployed by hand") }],
  ["the bundle differs from the one serving", { ...same, view: view(objectBundleStamp(hashOf({ configText: "{}" })!)) }],
];
for (const [why, facts] of deploys) {
  const d = decideObjectWorker(facts);
  eq(d.action, "deploy", `deployed when ${why}`);
  assert(d.reason.length > 0, `with a reason (${d.reason})`);
}

// --- the run over every object Worker ---------------------------------------------
interface Fake {
  facts: Record<string, ObjectWorkerFacts | "throw">;
  failDeploy?: string;
  deployThrows?: string;
  /** What reading the stamp back after a deploy gives: by default what was written. */
  readBack?: Record<string, "lost" | "throw">;
}

async function drive(f: Fake, configs: readonly string[]) {
  const deployed: { config: string; message: string | null }[] = [];
  const logs: string[] = [];
  const readBacks: string[] = [];
  const ops: ObjectWorkerOps = {
    facts: async (config) => {
      const x = f.facts[config];
      if (x === "throw" || x === undefined) throw new Error(`planted facts throw for ${config}`);
      return x;
    },
    deploy: async (config, message) => {
      deployed.push({ config, message });
      if (f.deployThrows === config) throw new Error("planted deploy throw");
      return f.failDeploy !== config;
    },
    servingStamp: async (config) => {
      readBacks.push(config);
      const mode = f.readBack?.[config];
      if (mode === "throw") throw new Error("planted read back throw");
      if (mode === "lost") return null;
      return stampFromMessage([...deployed].reverse().find((d) => d.config === config)?.message ?? null);
    },
    log: (line) => logs.push(line),
  };
  const result = await deployObjectWorkers(ops, configs);
  return { result, deployed, logs, readBacks };
}

const A = "wrangler.confirm-line.jsonc";
const B = "wrangler.burst-limiter.jsonc";
const C = "wrangler.token-holder.jsonc";
const hashB = hashOf({ config: B })!;
const changedB: ObjectWorkerFacts = { localHash: hashB, deployed: [{ versionId: OTHER, percentage: 100 }], view: view(objectBundleStamp(base!), OTHER) };

{
  const r = await drive({ facts: { [A]: same, [B]: same, [C]: same } }, [A, B, C]);
  eq(r.result.ok, true, "every Worker unchanged: the run is fine");
  eq(r.deployed.length, 0, "and nothing was deployed, so no object was restarted");
  for (const c of [A, B, C]) {
    assert(r.logs.some((l) => l.includes(c) && /skipped/.test(l)), `the log says ${c} was skipped, and why`);
  }
  eq(r.result.ok && r.result.skipped, [A, B, C], "and the result lists the skipped Workers");
}
{
  const r = await drive({ facts: { [A]: same, [B]: changedB, [C]: same } }, [A, B, C]);
  eq(r.result.ok, true, "one Worker changed: the run is fine");
  eq(r.deployed.map((d) => d.config), [B], "only the changed Worker was deployed");
  eq(r.deployed[0].message, objectBundleStamp(hashB), "and it was deployed carrying its own bundle's stamp, so the next run can recognise it");
  assert(r.logs.some((l) => l.includes(B) && /deploying/.test(l) && /differs/.test(l)), "the log says why it was deployed");
}
{
  const r = await drive({ facts: { [A]: "throw", [B]: same, [C]: same } }, [A, B, C]);
  eq(r.result.ok, true, "a Worker whose facts could not be read still deploys, and the run goes on");
  eq(r.deployed.map((d) => d.config), [A], "it is the one deployed");
  eq(r.deployed[0].message, null, "with no stamp, since the bundle's hash is not known (so the next run deploys it too)");
  assert(r.logs.some((l) => l.includes(A) && l.includes("planted facts throw")), "and the log names what could not be read");
}
{
  const unstamped: ObjectWorkerFacts = { ...same, localHash: null };
  const r = await drive({ facts: { [A]: unstamped, [B]: same, [C]: same } }, [A, B, C]);
  eq(r.deployed.map((d) => d), [{ config: A, message: null }], "a bundle that could not be hashed deploys unstamped");
}
{
  const r = await drive({ facts: { [A]: changedB, [B]: changedB, [C]: changedB }, failDeploy: B }, [A, B, C]);
  eq(r.result.ok, false, "a needed deploy that fails fails the run");
  eq(!r.result.ok && r.result.config, B, "naming the Worker that failed");
  eq(r.deployed.map((d) => d.config), [A, B], "and nothing after it is attempted, the order Slate's bindings need");
}
{
  const r = await drive({ facts: { [A]: changedB, [B]: same, [C]: same }, deployThrows: A }, [A, B, C]);
  eq(r.result.ok, false, "a needed deploy that throws fails the run too, rather than escaping");
  eq(!r.result.ok && r.result.config, A, "naming it");
  assert(!r.result.ok && r.result.reason.includes("planted deploy throw"), "with what was thrown");
}
{
  // The config is part of the hash, so a Worker whose config changed and whose code did
  // not is still deployed: the stamp on the serving version was made from the old text.
  const oldText = objectBundleHash(BASE)!;
  const newText = objectBundleHash({ ...BASE, configText: `${BASE.configText}\n// a new binding` })!;
  const facts: ObjectWorkerFacts = { localHash: newText, deployed: [{ versionId: SERVING, percentage: 100 }], view: view(objectBundleStamp(oldText)) };
  const r = await drive({ facts: { [A]: facts } }, [A]);
  eq(r.deployed.map((d) => d.config), [A], "a Worker whose wrangler config changed is deployed even when its code did not");
}

// --- the stamp is read back after a deploy, so a stamp that never lands is said ------
//
// The skip only ever happens if the message a deploy writes is the one the next run
// reads. Nothing offline can prove Cloudflare keeps it, so every stamped deploy reads it
// back and says when it did not land: otherwise every later run would redeploy with a
// log that reads like an ordinary first deploy (L3).
{
  const r = await drive({ facts: { [B]: changedB } }, [B]);
  eq(r.readBacks, [B], "a stamped deploy reads its stamp back");
  eq(r.result.ok && r.result.unstamped, [], "and one that landed is not reported");
  assert(r.logs.some((l) => l.includes(B) && /stamp confirmed/.test(l)), "the log says the stamp was confirmed");
}
for (const mode of ["lost", "throw"] as const) {
  const r = await drive({ facts: { [B]: changedB }, readBack: { [B]: mode } }, [B]);
  eq(r.result.ok, true, `a stamp that ${mode === "lost" ? "did not land" : "could not be read back"} does not fail the deploy, which worked`);
  eq(r.result.ok && r.result.unstamped, [B], "but the Worker is reported as unstamped");
  assert(r.logs.some((l) => l.includes(B) && /next deploy will redeploy it/.test(l)), `and the log says what that costs (${mode})`);
}
{
  const r = await drive({ facts: { [A]: "throw" } }, [A]);
  eq(r.readBacks, [], "a deploy made with no stamp is not read back");
  eq(r.result.ok && r.result.unstamped, [A], "and is reported as unstamped");
}

finish();

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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OBJECT_WORKER_CONFIGS } from "./lib/gradual-deploy.ts";
import {
  CONFIRM_LINE_CONFIG,
  OBJECT_BUNDLE_MESSAGE_PREFIX,
  decideLineProtocol,
  protocolFromSource,
  readAtCommit,
  uncheckedLineWarning,
  type LiveAppProtocol,
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
  /** The live app's confirm line protocol (#3560): default protocol 1. */
  live?: LiveAppProtocol | "throw";
}

async function drive(f: Fake, configs: readonly string[]) {
  const deployed: { config: string; message: string | null }[] = [];
  const logs: string[] = [];
  const readBacks: string[] = [];
  let liveReads = 0;
  const ops: ObjectWorkerOps = {
    liveAppProtocol: async () => {
      liveReads++;
      if (f.live === "throw") throw new Error("planted live protocol throw");
      return f.live ?? { protocol: 1 };
    },
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
  return { result, deployed, logs, readBacks, liveReads: () => liveReads };
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

// --- #3560: never put a confirm line build OLDER than the live app in front of it ------
//
// An object serves clients up to its own CONFIRM_LINE_PROTOCOL and refuses a newer one, so
// a line Worker rolled back alone puts every confirm on its isolate's own line, where a
// crowd for one slot books one advisor or none (#3839). The deploy refuses that order,
// deciding from the protocol the BUILT bundle carries against the one the live app's
// commit speaks.
{
  assert((OBJECT_WORKER_CONFIGS as readonly string[]).includes(CONFIRM_LINE_CONFIG), "the confirm line config the check keys on is one of the object workers");
  eq(protocolFromSource("export const CONFIRM_LINE_PROTOCOL = 1;\n"), 1, "the constant as main declares it reads");
  eq(
    protocolFromSource("export const CONFIRM_LINE_PROTOCOL = 2;\n/** oldest */\nexport const CONFIRM_LINE_OLDEST_PROTOCOL = 1;\n"),
    2,
    "the constant as #3839 declares it reads, and the OLDEST constant beside it is not mistaken for it",
  );
  eq(protocolFromSource("// x\nvar CONFIRM_LINE_PROTOCOL = 2;\n    if (m.v !== CONFIRM_LINE_PROTOCOL) return gone();\n"), 2, "the bundled form reads (measured: wrangler keeps `var CONFIRM_LINE_PROTOCOL = 1;`)");
  eq(protocolFromSource("var CONFIRM_LINE_PROTOCOL = 1;\nvar CONFIRM_LINE_PROTOCOL = 2;\n"), null, "two declarations are unreadable, never the first one");
  eq(protocolFromSource("var CONFIRM_LINE_PROTOCOL2 = 2;\n"), null, "a renamed declaration is unreadable");
  eq(protocolFromSource("export const CONFIRM_LINE_PROTOCOL = PROTO;\n"), null, "a declaration that is not a number is unreadable");
  eq(protocolFromSource(""), null, "an empty source is unreadable");
  eq(protocolFromSource(null), null, "a source that could not be read is unreadable");
  // The real file must read, or every deploy would carry the warning below and the
  // refusal would never fire (a guard that cannot see is not a guard, L1).
  const real = protocolFromSource(readFileSync(join(import.meta.dirname, "..", "src", "lib", "booking", "confirm-line-object.ts"), "utf8"));
  assert(real !== null && real >= 1, `the protocol in this checkout's confirm-line-object.ts reads (got ${real})`);
}
{
  const refuse = decideLineProtocol(1, { protocol: 2 });
  eq(refuse.action, "refuse", "a line build speaking 1 in front of a live app speaking 2 is refused");
  assert(refuse.reason.includes("1") && refuse.reason.includes("2"), `naming both protocols (${refuse.reason})`);
  eq(refuse.checked, true, "a refusal was a measured comparison");
  eq(decideLineProtocol(2, { protocol: 2 }).action, "deploy", "the same protocol deploys");
  eq(decideLineProtocol(2, { protocol: 2 }).checked, true, "as a checked comparison");
  eq(decideLineProtocol(2, { unreadable: "x" }).checked, false, "an unreadable live side is unchecked, as a field rather than a wording");
  eq(decideLineProtocol(null, { protocol: 2 }).checked, false, "and so is an unreadable built side");
  eq(decideLineProtocol(3, { protocol: 2 }).action, "deploy", "a newer line deploys (the order every deploy makes)");
  const unreadableLive = decideLineProtocol(1, { unreadable: "the serving app version carries no commit tag" });
  eq(unreadableLive.action, "deploy", "an unreadable live protocol does NOT refuse: a secret change leaves an untagged app version on ordinary days");
  assert(/could not be checked/.test(unreadableLive.reason) && unreadableLive.reason.includes("no commit tag"), `and says so, naming why (${unreadableLive.reason})`);
  const unreadableBuilt = decideLineProtocol(null, { protocol: 2 });
  eq(unreadableBuilt.action, "deploy", "an unreadable built protocol does not refuse either");
  assert(/could not be checked/.test(unreadableBuilt.reason) && /built/.test(unreadableBuilt.reason), `and says it was the build that could not be read (${unreadableBuilt.reason})`);
}
const lineAt = (protocol: number | null): ObjectWorkerFacts => ({ ...changedB, builtProtocol: protocol });
{
  const r = await drive({ facts: { [A]: lineAt(1), [B]: changedB, [C]: changedB }, live: { protocol: 2 } }, [A, B, C]);
  eq(r.result.ok, false, "a line build older than the live app fails the run");
  eq(!r.result.ok && r.result.kind, "refused", "as a refusal, not as a failed deploy");
  eq(r.deployed.length, 0, "and NOTHING is deployed, the line nor the Workers after it");
  assert(!r.result.ok && r.result.reason.includes("older"), `the reason says the line would be older than the app (${!r.result.ok && r.result.reason})`);
}
{
  const r = await drive({ facts: { [A]: lineAt(2) }, live: { protocol: 2 } }, [A]);
  eq(r.deployed.map((d) => d.config), [A], "a line build at the live app's protocol deploys");
  assert(r.logs.some((l) => l.includes(A) && /protocol 2/.test(l)), "and the log says which protocols were compared");
}
for (const live of [{ unreadable: "the serving app version carries no commit tag" }, "throw"] as const) {
  const r = await drive({ facts: { [A]: lineAt(1) }, live }, [A]);
  eq(r.deployed.map((d) => d.config), [A], `a live protocol that ${live === "throw" ? "throws" : "is unreadable"} deploys the line anyway`);
  assert(r.logs.some((l) => l.includes(A) && /could not be checked/.test(l)), "saying the check could not be made");
  eq(r.result.ok && r.result.unchecked.map((u) => u.config), [A], "and the result names it as unchecked");
  assert(r.result.ok && /could not be checked/.test(r.result.unchecked[0]?.reason ?? ""), "with the reason, for the warning");
}
{
  const r = await drive({ facts: { [A]: same, [B]: changedB }, live: { protocol: 9 } }, [A, B]);
  eq(r.liveReads(), 0, "a line Worker that is skipped changes nothing, so the live app is not even asked");
  eq(r.deployed.map((d) => d.config), [B], "and a changed Worker that is not the line deploys without the check");
}

// --- #3854: reading the serving app's commit from a checkout that lacks it ---------
// The version's tag is `normalizeCommit`'s 12 character abbreviation, and the deploy job
// checks out ONE commit (actions/checkout, depth 1). The fake below answers the way git
// and GitHub did on the first production run (CI run 38974803936, 2026-10-16):
// `git show f911f9ef0076:...` is "invalid object name" while the checkout lacks it, and
// `git fetch origin f911f9ef0076` is "couldn't find remote ref", because a server answers
// a fetch only for a FULL object id (reproduced by hand against GitHub the same day: the
// abbreviation is refused, the full id fetches).
const HEAD_SHA = "7da0d5589d26acc422610e10679eff5474610c23";
const SERVING_SHA = "f911f9ef007618625e1441aa1a1e9e741542c3a3";
const SOURCE_PATH = "src/lib/booking/confirm-line-object.ts";
const SERVING_SOURCE = "export const CONFIRM_LINE_PROTOCOL = 2;\n";

interface FakeRepo {
  /** Commits this checkout holds. */
  local: Set<string>;
  shallow: boolean | "unreadable";
  /** Commits origin holds, every one reachable from a branch. */
  remote: Set<string>;
  /** Fetches fail outright (no network, no credentials). */
  fetchFails?: boolean;
}

function fakeGit(repo: FakeRepo) {
  const calls: string[] = [];
  const resolve = (ref: string): string | null => {
    const hits = [...repo.local].filter((c) => c.startsWith(ref));
    return hits.length === 1 ? hits[0] : null;
  };
  const git = (args: string[]): string | null => {
    calls.push(args.join(" "));
    if (args[0] === "show") {
      const [ref, path] = args[1].split(":");
      const commit = resolve(ref);
      return commit === SERVING_SHA && path === SOURCE_PATH ? SERVING_SOURCE : null;
    }
    if (args[0] === "rev-parse" && args[1] === "--is-shallow-repository") {
      return repo.shallow === "unreadable" ? null : `${repo.shallow}\n`;
    }
    if (args[0] === "fetch") {
      if (repo.fetchFails) return null;
      const rest = args.slice(1).filter((a) => !a.startsWith("--"));
      const want = rest[1];
      if (want !== undefined) {
        // A want line carries a full object id only: an abbreviation is a ref name to
        // the server, and there is no ref by that name.
        if (!/^[0-9a-f]{40}$/.test(want) || !repo.remote.has(want)) return null;
        repo.local.add(want);
        return "";
      }
      // No refspec: origin's branches. A shallow checkout gains their history only when
      // it is unshallowed; otherwise it gains only the tips it lacked, which here are
      // already the commit it checked out.
      if (repo.shallow === true && !args.includes("--unshallow")) return "";
      for (const c of repo.remote) repo.local.add(c);
      if (args.includes("--unshallow")) repo.shallow = false;
      return "";
    }
    return null;
  };
  return { git, calls };
}

{
  // The production case exactly: a depth 1 checkout of main, the serving commit one
  // deploy behind it, tagged by its abbreviation.
  const repo: FakeRepo = { local: new Set([HEAD_SHA]), shallow: true, remote: new Set([HEAD_SHA, SERVING_SHA]) };
  const { git, calls } = fakeGit(repo);
  const r = readAtCommit(git, SERVING_SHA.slice(0, 12), SOURCE_PATH);
  eq(r, { source: SERVING_SOURCE }, `an abbreviated serving commit is read from a depth 1 checkout (git ran: ${calls.join(" | ")})`);
  assert(!calls.some((c) => c.startsWith("fetch") && c.endsWith(` ${SERVING_SHA.slice(0, 12)}`)), "and it never asks the server for an abbreviation, which no server answers");
  eq(protocolFromSource("source" in r ? r.source : null), 2, "and the protocol is read from what it fetched");
}
{
  const repo: FakeRepo = { local: new Set([HEAD_SHA]), shallow: true, remote: new Set([HEAD_SHA, SERVING_SHA]) };
  const { git, calls } = fakeGit(repo);
  eq(readAtCommit(git, SERVING_SHA, SOURCE_PATH), { source: SERVING_SOURCE }, "a full serving commit is read from a depth 1 checkout");
  assert(calls.some((c) => c === `fetch --no-tags --depth=1 origin ${SERVING_SHA}`), `fetching just that commit, one deep (git ran: ${calls.join(" | ")})`);
  assert(!calls.some((c) => c.includes("--unshallow")), "without fetching the whole history");
}
{
  // A hand deploy runs from a full clone, which may simply be behind origin.
  const repo: FakeRepo = { local: new Set([HEAD_SHA]), shallow: false, remote: new Set([HEAD_SHA, SERVING_SHA]) };
  const { git, calls } = fakeGit(repo);
  eq(readAtCommit(git, SERVING_SHA.slice(0, 12), SOURCE_PATH), { source: SERVING_SOURCE }, "an abbreviated commit a full clone lacks is fetched from origin");
  assert(!calls.some((c) => c.includes("--unshallow") || c.includes("--depth")), `and a full clone is never made shallow, nor told to unshallow (git ran: ${calls.join(" | ")})`);
}
{
  const repo: FakeRepo = { local: new Set([HEAD_SHA, SERVING_SHA]), shallow: false, remote: new Set() };
  const { git, calls } = fakeGit(repo);
  eq(readAtCommit(git, SERVING_SHA.slice(0, 12), SOURCE_PATH), { source: SERVING_SOURCE }, "a commit the checkout holds is read");
  assert(!calls.some((c) => c.startsWith("fetch")), "with no fetch at all");
}
// Every way it still cannot be read names its own cause (L11).
{
  const repo: FakeRepo = { local: new Set([HEAD_SHA]), shallow: true, remote: new Set([HEAD_SHA, SERVING_SHA]), fetchFails: true };
  const r = readAtCommit(fakeGit(repo).git, SERVING_SHA.slice(0, 12), SOURCE_PATH);
  assert("unreadable" in r && /fetch/.test(r.unreadable) && /failed/.test(r.unreadable), `a fetch that fails says the fetch failed (${JSON.stringify(r)})`);
}
{
  // A hand deploy of a branch commit that was never pushed, or whose branch is gone.
  const repo: FakeRepo = { local: new Set([HEAD_SHA]), shallow: true, remote: new Set([HEAD_SHA]) };
  const r = readAtCommit(fakeGit(repo).git, SERVING_SHA.slice(0, 12), SOURCE_PATH);
  assert("unreadable" in r && /no branch/.test(r.unreadable), `a commit origin does not hold says so, not that the fetch failed (${JSON.stringify(r)})`);
}
{
  const repo: FakeRepo = { local: new Set([HEAD_SHA]), shallow: "unreadable", remote: new Set([HEAD_SHA, SERVING_SHA]) };
  const r = readAtCommit(fakeGit(repo).git, SERVING_SHA.slice(0, 12), SOURCE_PATH);
  assert("unreadable" in r && /shallow/.test(r.unreadable), `a checkout whose depth cannot be read says so (${JSON.stringify(r)})`);
}

// --- #3854: a check that did not run is said where the deploy job is read ----------
{
  const w = uncheckedLineWarning([{ config: A, reason: "the line's protocol could not be checked against the live app's (the serving app version carries no commit tag)" }], "production");
  assert(w.includes(A) && w.includes("production") && w.includes("no commit tag"), `the warning names the Worker, the environment and why (${w})`);
}

finish();

// The I/O behind #3561's "deploy an object Worker only when it changed": building the
// bundle wrangler would upload, reading what is serving, and deploying with the stamp.
// Every decision is in ./object-worker-skip.ts and driven offline by
// scripts/test-object-worker-skip.ts; this file only runs wrangler and reads files.
//
// Used by every path that deploys the object Workers: the gradual deploy
// (scripts/deploy-gradual.ts), the hand deploy and the load run's arm job (both through
// scripts/deploy-object-workers.ts).

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { readDeploymentStatus } from "./gradual-deploy.ts";
import { readVersionView, type VersionView } from "./rollback-plan.ts";
import {
  objectBundleHash,
  protocolFromSource,
  stampFromMessage,
  type BundleFile,
  type LiveAppProtocol,
  type ObjectWorkerFacts,
  type ObjectWorkerOps,
} from "./object-worker-skip.ts";
import { envArgs, jsonPart, ROOT, runCapture, runLoud } from "./wrangler-cli.ts";

function filesUnder(dir: string): BundleFile[] {
  const out: BundleFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    out.push({ path: relative(dir, full).split("\\").join("/"), bytes: readFileSync(full) });
  }
  return out;
}

/** The installed wrangler's version, or "" when it cannot be read (which gives no hash, so deploys). */
function wranglerVersion(): string {
  try {
    const v = (JSON.parse(readFileSync(join(ROOT, "node_modules", "wrangler", "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

/**
 * The local bundle, built with `wrangler deploy --dry-run --outdir` into a temp directory:
 * its hash, and (#3560) the confirm line protocol its modules declare. Both null when it
 * could not be built.
 */
export function localBundle(config: string, env: string): { hash: string | null; protocol: number | null } {
  const out = mkdtempSync(join(tmpdir(), "slate-object-bundle-"));
  try {
    const built = runCapture("pnpm", ["exec", "wrangler", "deploy", "-c", config, ...envArgs(env), "--dry-run", "--outdir", out]);
    if (built === null) return { hash: null, protocol: null };
    const files = filesUnder(out);
    const modules = files.filter((f) => /\.(m?js|cjs)$/.test(f.path)).map((f) => Buffer.from(f.bytes).toString("utf8"));
    return {
      hash: objectBundleHash({ config, configText: readFileSync(join(ROOT, config), "utf8"), env, wranglerVersion: wranglerVersion(), files }),
      protocol: protocolFromSource(modules.join("\n")),
    };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Where the confirm line protocol is declared, read at the serving app's commit. */
const PROTOCOL_SOURCE = "src/lib/booking/confirm-line-object.ts";

function gitShow(commit: string): string | null {
  return runCapture("git", ["show", `${commit}:${PROTOCOL_SOURCE}`]);
}

/**
 * #3560: the confirm line protocol the app serving now speaks: its version's commit tag
 * (every gradual and verified deploy tags one), then the constant at that commit, fetched
 * when the checkout does not hold it (CI checks out one commit). Every step that cannot
 * answer says which, so an unchecked deploy names its cause (L11).
 */
export function liveAppProtocol(env: string): LiveAppProtocol {
  const wrangler = (args: string[]) => jsonPart(runCapture("pnpm", ["exec", "wrangler", ...args, ...envArgs(env)]));
  const status = readDeploymentStatus(wrangler(["deployments", "status", "--json"]));
  if (status === null) return { unreadable: "the app's deployment could not be read" };
  if (status.length !== 1 || status[0].percentage !== 100) {
    return { unreadable: `the app is not one version at 100% (${status.map((v) => `${v.versionId}@${v.percentage}%`).join(", ")})` };
  }
  const id = status[0].versionId;
  const view = readVersionView(wrangler(["versions", "view", id, "--json"]));
  if (view === null) return { unreadable: `the serving app version ${id} could not be read` };
  const commit = (view.tag ?? "").trim();
  if (!/^[0-9a-f]{7,40}$/.test(commit)) {
    return { unreadable: `the serving app version ${id} carries no commit tag (a secret change or an untagged hand deploy makes one)` };
  }
  let source = gitShow(commit);
  if (source === null) {
    // A shallow clone fetches just that commit; a full one fetches normally, since a
    // depth limited fetch into a full clone would make it shallow.
    const shallow = (runCapture("git", ["rev-parse", "--is-shallow-repository"]) ?? "").trim() === "true";
    runCapture("git", ["fetch", "--no-tags", ...(shallow ? ["--depth=1"] : []), "origin", commit]);
    source = gitShow(commit);
  }
  if (source === null) return { unreadable: `the serving app's commit ${commit} could not be read from git` };
  const protocol = protocolFromSource(source);
  return protocol === null
    ? { unreadable: `${PROTOCOL_SOURCE} at the serving app's commit ${commit} does not declare CONFIRM_LINE_PROTOCOL once as a number` }
    : { protocol };
}

/** The ops for `deployObjectWorkers`, against the environment named (`loadtest`, or "" for production). */
export function objectWorkerOps(env: string | undefined, log: (line: string) => void): ObjectWorkerOps {
  const e = (env ?? "").trim();
  const wrangler = (args: string[]) => jsonPart(runCapture("pnpm", ["exec", "wrangler", ...args, ...envArgs(e)]));
  /** The deployment, and the view of its one version when exactly one serves at 100%. */
  const serving = (config: string): Pick<ObjectWorkerFacts, "deployed" | "view"> => {
    const deployed = readDeploymentStatus(wrangler(["deployments", "status", "--json", "-c", config]));
    let view: VersionView | null = null;
    if (deployed !== null && deployed.length === 1 && deployed[0].percentage === 100) {
      view = readVersionView(wrangler(["versions", "view", deployed[0].versionId, "--json", "-c", config]));
    }
    return { deployed, view };
  };
  return {
    facts: async (config): Promise<ObjectWorkerFacts> => {
      const local = localBundle(config, e);
      return { localHash: local.hash, builtProtocol: local.protocol, ...serving(config) };
    },
    liveAppProtocol: async () => liveAppProtocol(e),
    deploy: async (config, message) =>
      runLoud("pnpm", ["exec", "wrangler", "deploy", "-c", config, ...envArgs(e), ...(message ? ["--message", message] : [])]),
    servingStamp: async (config) => {
      const s = serving(config);
      return s.view !== null && s.deployed?.[0]?.versionId === s.view.id ? stampFromMessage(s.view.message) : null;
    },
    log,
  };
}

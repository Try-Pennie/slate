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
import { objectBundleHash, stampFromMessage, type BundleFile, type ObjectWorkerFacts, type ObjectWorkerOps } from "./object-worker-skip.ts";
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

/** The local bundle's hash: `wrangler deploy --dry-run --outdir` into a temp directory. Null when it could not be built. */
export function localBundleHash(config: string, env: string): string | null {
  const out = mkdtempSync(join(tmpdir(), "slate-object-bundle-"));
  try {
    const built = runCapture("pnpm", ["exec", "wrangler", "deploy", "-c", config, ...envArgs(env), "--dry-run", "--outdir", out]);
    if (built === null) return null;
    return objectBundleHash({
      config,
      configText: readFileSync(join(ROOT, config), "utf8"),
      env,
      wranglerVersion: wranglerVersion(),
      files: filesUnder(out),
    });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
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
    facts: async (config): Promise<ObjectWorkerFacts> => ({ localHash: localBundleHash(config, e), ...serving(config) }),
    deploy: async (config, message) =>
      runLoud("pnpm", ["exec", "wrangler", "deploy", "-c", config, ...envArgs(e), ...(message ? ["--message", message] : [])]),
    servingStamp: async (config) => {
      const s = serving(config);
      return s.view !== null && s.deployed?.[0]?.versionId === s.view.id ? stampFromMessage(s.view.message) : null;
    },
    log,
  };
}

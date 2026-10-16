/**
 * #3561: deploy an object Worker (the confirm line's, the burst limiter's, the token
 * holder's: `OBJECT_WORKER_CONFIGS`) only when what would be deployed differs from what is
 * serving.
 *
 * WHY: a Worker deploy restarts its Durable Objects. Every Slate deploy used to redeploy
 * all three, so it dropped whatever a line object held in memory (a crowd's waiting turns,
 * its frontier) and emptied the token holder, exactly as it did when the objects lived in
 * Slate's own Worker, and it put exit 26 in front of Slate deploys that never touched them.
 *
 * HOW IT IS MEASURED, never inferred from a list of changed paths (L96, L312): the run
 * builds the bundle wrangler would upload (`wrangler deploy --dry-run --outdir`) and
 * hashes it together with the wrangler config text, the environment and the wrangler
 * version. A deploy writes that hash onto the version it makes, as its message
 * (`objectBundleStamp`). The next run reads the serving version's message back and skips
 * the Worker only when the two hashes are equal. Measured 2026-10-16 with wrangler 4.147.0:
 * two dry runs of each Worker into different directories gave a byte identical `index.js`,
 * while `index.js.map` (it names the output directory) and `README.md` (a timestamp)
 * differed every time, so those two are left out of the hash and nothing else is.
 *
 * EVERY DOUBT DEPLOYS: a bundle that could not be built or hashed, a deployment that could
 * not be read, a split, a version with no stamp (one deployed by hand, by a secret change,
 * or before this existed), a stamp that does not match. Deploying when it was not needed
 * costs one restart, which is what every deploy did before; skipping when it was needed
 * would leave Slate bound to old object code with nothing saying so.
 *
 * Pure apart from the hash, and driven offline by `scripts/test-object-worker-skip.ts`.
 * The I/O (wrangler, the file system) is `scripts/lib/object-worker-io.ts`.
 */

import { createHash } from "node:crypto";
import type { VersionShare } from "./gradual-deploy.ts";
import type { VersionView } from "./rollback-plan.ts";

/** The message prefix a stamped object Worker version carries, followed by the hash. */
export const OBJECT_BUNDLE_MESSAGE_PREFIX = "object-bundle sha256:";
/** Bumped if what goes into the hash changes, so an old stamp can never match a new hash. */
const HASH_SCHEME = "slate-object-bundle-v1";

export interface BundleFile {
  /** Relative to the dry run's output directory. */
  path: string;
  bytes: string | Uint8Array;
}

export interface BundleInput {
  /** The wrangler config file, e.g. `wrangler.confirm-line.jsonc`. */
  config: string;
  /** That file's full text: bindings, migrations, compatibility date and flags. */
  configText: string;
  /** The wrangler environment (`loadtest`), or "" for the top level (production). */
  env: string;
  /** The wrangler that builds and uploads the bundle. */
  wranglerVersion: string;
  /** Every file the dry run wrote. */
  files: BundleFile[];
}

/** A dry run output file that differs between two builds of the same code. */
function isBuildNoise(path: string): boolean {
  return path.endsWith(".map") || path === "README.md" || path.endsWith("/README.md");
}

/**
 * The hash of what a deploy of this Worker would put in place, or null when there is
 * nothing trustworthy to hash: no module in the output, no config text, no wrangler
 * version. Null always deploys.
 */
export function objectBundleHash(input: BundleInput): string | null {
  const modules = input.files.filter((f) => !isBuildNoise(f.path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (!modules.some((f) => /\.(m?js|cjs)$/.test(f.path))) return null;
  if (!input.configText.trim() || !input.wranglerVersion.trim()) return null;
  const h = createHash("sha256");
  // Every field is length prefixed, so no two different inputs can concatenate alike.
  const field = (v: string | Uint8Array) => {
    const buf = typeof v === "string" ? Buffer.from(v, "utf8") : Buffer.from(v);
    h.update(`${buf.length}:`);
    h.update(buf);
  };
  field(HASH_SCHEME);
  field(input.config);
  field(input.env);
  field(input.wranglerVersion);
  field(input.configText);
  field(String(modules.length));
  for (const f of modules) {
    field(f.path);
    field(f.bytes);
  }
  return h.digest("hex");
}

/** The message a deploy writes on the version it makes. 85 characters; Cloudflare keeps 100. */
export function objectBundleStamp(hash: string): string {
  return `${OBJECT_BUNDLE_MESSAGE_PREFIX}${hash}`;
}

/** The hash a version's message carries, or null when it is not a whole stamp. */
export function stampFromMessage(message: string | null): string | null {
  if (message === null || !message.startsWith(OBJECT_BUNDLE_MESSAGE_PREFIX)) return null;
  const hash = message.slice(OBJECT_BUNDLE_MESSAGE_PREFIX.length);
  return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

/** What a run knows about one object Worker before deciding. */
export interface ObjectWorkerFacts {
  /** `objectBundleHash` of the local build; null when it could not be built or hashed. */
  localHash: string | null;
  /** `wrangler deployments status --json` for the Worker; null when it could not be read. */
  deployed: VersionShare[] | null;
  /** `wrangler versions view --json` of the one version serving; null when not read. */
  view: VersionView | null;
}

export interface ObjectWorkerDecision {
  action: "deploy" | "skip";
  reason: string;
}

/** Skip only on a proved identical bundle; everything else deploys, with its reason. */
export function decideObjectWorker(f: ObjectWorkerFacts): ObjectWorkerDecision {
  const deploy = (reason: string): ObjectWorkerDecision => ({ action: "deploy", reason });
  if (f.localHash === null) return deploy("the local bundle could not be built or hashed");
  if (f.deployed === null) return deploy("what is deployed could not be read");
  if (f.deployed.length === 0) return deploy("nothing is deployed yet");
  if (f.deployed.length !== 1 || f.deployed[0].percentage !== 100) {
    return deploy(`it is not one version at 100% (${f.deployed.map((v) => `${v.versionId}@${v.percentage}%`).join(", ")})`);
  }
  const serving = f.deployed[0].versionId;
  if (f.view === null) return deploy(`the serving version ${serving} could not be read`);
  if (f.view.id !== serving) return deploy(`the version read (${f.view.id}) is not the one serving (${serving})`);
  const stamp = stampFromMessage(f.view.message);
  if (stamp === null) {
    return deploy(`the serving version ${serving} carries no bundle stamp (deployed by hand, by a secret change, or before #3561)`);
  }
  if (stamp !== f.localHash) {
    return deploy(`the bundle differs from the one serving (${serving} has ${stamp.slice(0, 12)}, this build is ${f.localHash.slice(0, 12)})`);
  }
  return { action: "skip", reason: `the serving version ${serving} carries this bundle's stamp ${stamp.slice(0, 12)}` };
}

export interface ObjectWorkerOps {
  /** Build, hash and read what is serving. May throw; a throw deploys. */
  facts(config: string): Promise<ObjectWorkerFacts>;
  /** `wrangler deploy -c <config>`, with `--message <message>` when there is one. True when it succeeded. */
  deploy(config: string, message: string | null): Promise<boolean>;
  /** The bundle hash the serving version's message carries, after a deploy; null when it carries none or could not be read. */
  servingStamp(config: string): Promise<string | null>;
  log(line: string): void;
}

/** `unstamped`: deployed, and the serving version is not confirmed to carry the stamp
 *  (none was written, or it did not read back), so the next run deploys it again. */
export type ObjectWorkersResult =
  | { ok: true; deployed: string[]; skipped: string[]; unstamped: string[] }
  | { ok: false; config: string; reason: string; deployed: string[]; skipped: string[]; unstamped: string[] };

/**
 * Each config in order, deployed or skipped. Stops at the first needed deploy that fails,
 * since a later Worker deployed after a failed one buys nothing: Slate is not uploaded
 * either way. Never throws.
 */
export async function deployObjectWorkers(ops: ObjectWorkerOps, configs: readonly string[]): Promise<ObjectWorkersResult> {
  const deployed: string[] = [];
  const skipped: string[] = [];
  const unstamped: string[] = [];
  for (const config of configs) {
    let facts: ObjectWorkerFacts | null = null;
    let decision: ObjectWorkerDecision;
    try {
      facts = await ops.facts(config);
      decision = decideObjectWorker(facts);
    } catch (err) {
      decision = { action: "deploy", reason: `reading whether it changed failed (${err instanceof Error ? err.message : String(err)})` };
    }
    if (decision.action === "skip") {
      ops.log(`object worker ${config}: skipped, ${decision.reason}`);
      skipped.push(config);
      continue;
    }
    ops.log(`object worker ${config}: deploying, ${decision.reason}`);
    const message = facts?.localHash ? objectBundleStamp(facts.localHash) : null;
    let ok = false;
    let why = "the deploy failed";
    try {
      ok = await ops.deploy(config, message);
    } catch (err) {
      why = `the deploy threw (${err instanceof Error ? err.message : String(err)})`;
    }
    if (!ok) return { ok: false, config, reason: why, deployed, skipped, unstamped };
    deployed.push(config);
    if (message === null || facts?.localHash == null) {
      unstamped.push(config);
      continue;
    }
    // The skip only ever happens if the stamp written is the one the next run reads, and
    // nothing offline can prove Cloudflare keeps it, so it is read back and said (L3).
    let back: string | null = null;
    let readFailure = "";
    try {
      back = await ops.servingStamp(config);
    } catch (err) {
      readFailure = ` (reading it threw: ${err instanceof Error ? err.message : String(err)})`;
    }
    if (back === facts.localHash) {
      ops.log(`object worker ${config}: deployed, stamp confirmed on the serving version`);
    } else {
      unstamped.push(config);
      ops.log(
        `object worker ${config}: deployed, but the serving version does not read back as carrying stamp ${facts.localHash.slice(0, 12)}${readFailure}, so the next deploy will redeploy it`,
      );
    }
  }
  return { ok: true, deployed, skipped, unstamped };
}

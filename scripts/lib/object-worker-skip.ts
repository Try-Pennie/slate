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

// --- #3560: the confirm line's protocol -------------------------------------------------
//
// A line object serves clients up to its own `CONFIRM_LINE_PROTOCOL` and refuses a newer
// one (#3839), so an app newer than its line object puts every confirm on its isolate's
// own line, where a crowd for one slot books one advisor or none. Every deploy makes the
// other order (the line first, then the app at the same commit), which the object serves.
// The newer app order only arises when the line Worker is deployed from a build older
// than the app that is live: a line only rollback, or a revert that lowers the protocol.
// That is refused here, from the protocol the BUILT bundle carries against the one the
// live app's commit speaks.

/** The object worker whose protocol is checked. */
export const CONFIRM_LINE_CONFIG = "wrangler.confirm-line.jsonc";

/**
 * The confirm line protocol declared in a source file or a bundle, or null when it is
 * not declared exactly once as a number. Matches `export const CONFIRM_LINE_PROTOCOL = 2;`
 * in source and `var CONFIRM_LINE_PROTOCOL = 2;` in the bundle wrangler builds (measured
 * 2026-10-16, wrangler 4.147.0, which keeps the name).
 */
export function protocolFromSource(text: string | null): number | null {
  if (text === null) return null;
  const found = [...text.matchAll(/\bCONFIRM_LINE_PROTOCOL\s*=\s*([^;\n]*);/g)];
  if (found.length !== 1) return null;
  const value = found[0][1].trim();
  return /^[1-9][0-9]*$/.test(value) ? Number(value) : null;
}

/** The protocol the live app speaks, or why it could not be read. */
export type LiveAppProtocol = { protocol: number } | { unreadable: string };

/** One git command run in the checkout: its stdout, or null when it exited non zero. */
export type GitRun = (args: string[]) => string | null;

/**
 * #3854: a file's text at the serving app's commit, fetching what the checkout lacks.
 *
 * The commit is the serving version's tag, which is `normalizeCommit`'s 12 character
 * abbreviation, and a git server answers a fetch only for a FULL object id: `git fetch
 * origin f911f9ef0076` fails with "couldn't find remote ref". That is why the check never
 * ran on its first production deploy (CI run 38974803936), where the job checks out one
 * commit. So:
 *
 * - a full id is fetched by itself, one commit deep in a shallow checkout (a depth
 *   limited fetch into a full clone would make it shallow);
 * - an abbreviation is resolved locally, against origin's branches fetched for it: a
 *   shallow checkout is unshallowed (the serving commit is behind the one checked out,
 *   so no depth short of the history can be known to reach it), a full clone just
 *   fetches what it is missing. A commit on no branch origin still has (a hand deploy of
 *   a branch since deleted) stays unreadable, and says so.
 *
 * Every way it cannot answer says which (L11), since each sends somebody somewhere else.
 */
export function readAtCommit(git: GitRun, commit: string, path: string): { source: string } | { unreadable: string } {
  const show = () => git(["show", `${commit}:${path}`]);
  const first = show();
  if (first !== null) return { source: first };
  const depth = git(["rev-parse", "--is-shallow-repository"]);
  if (depth === null) {
    return { unreadable: `the serving app's commit ${commit} is not in this checkout, and whether the checkout is shallow could not be read` };
  }
  const shallow = depth.trim() === "true";
  const full = /^[0-9a-f]{40}$/.test(commit);
  const fetch = full
    ? ["fetch", "--no-tags", ...(shallow ? ["--depth=1"] : []), "origin", commit]
    : ["fetch", "--no-tags", ...(shallow ? ["--unshallow"] : []), "origin"];
  if (git(fetch) === null) {
    return { unreadable: `the serving app's commit ${commit} is not in this checkout, and \`git ${fetch.join(" ")}\` failed` };
  }
  const after = show();
  if (after !== null) return { source: after };
  return {
    unreadable: full
      ? `the serving app's commit ${commit} was fetched, and ${path} could not be read at it`
      : `the serving app's commit ${commit} is on no branch origin has (after \`git ${fetch.join(" ")}\`), or ${path} could not be read at it`,
  };
}

/**
 * #3854: the warning a deploy prints, as an annotation and in the job summary, when the
 * line went out without its protocol being compared with the live app's. A check that
 * fails open is otherwise visible only in the middle of the run log, and one that never
 * runs reads as checked everywhere else (L98).
 */
export function uncheckedLineWarning(unchecked: { config: string; reason: string }[], where: string): string {
  const which = unchecked.map((u) => `${u.config} (${u.reason})`).join("; ");
  return `The confirm line was deployed to ${where} WITHOUT the check that refuses a line older than the live app: ${which}. The deploy went ahead, which is the design; if the app is newer than the line, confirms fall back to their isolate's own line and page confirm_line_unreachable.`;
}

/**
 * Refuse a line build older than the live app; deploy otherwise.
 *
 * An unreadable value on EITHER side deploys, with a reason saying the check could not be
 * made. Refusing would stop ordinary deploys: a secret change leaves the app serving an
 * untagged version (no commit to read the protocol from), and the commit may not be
 * fetchable. What the unchecked order costs is bounded by #3839: the app falls back to its
 * isolate's own line, which is what production runs with the shared line off, and pages
 * `confirm_line_unreachable` naming the remedy.
 */
export function decideLineProtocol(built: number | null, live: LiveAppProtocol): { action: "deploy" | "refuse"; checked: boolean; reason: string } {
  if (built === null) {
    return { action: "deploy", checked: false, reason: "the line's protocol could not be checked: the built bundle does not declare CONFIRM_LINE_PROTOCOL once as a number" };
  }
  if ("unreadable" in live) {
    return { action: "deploy", checked: false, reason: `the line's protocol could not be checked against the live app's (${live.unreadable}); the build speaks protocol ${built}` };
  }
  if (built < live.protocol) {
    return {
      action: "refuse",
      checked: true,
      reason: `this line build speaks protocol ${built} and the live app speaks protocol ${live.protocol}, so deploying it would put a line object older than the app in front of it (#3560)`,
    };
  }
  return { action: "deploy", checked: true, reason: `the line build speaks protocol ${built}, the live app protocol ${live.protocol}` };
}

/** What a run knows about one object Worker before deciding. */
export interface ObjectWorkerFacts {
  /** `objectBundleHash` of the local build; null when it could not be built or hashed. */
  localHash: string | null;
  /** #3560: `protocolFromSource` of the built bundle, for the confirm line; absent or null when not measured. */
  builtProtocol?: number | null;
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
  /** #3560: the confirm line protocol the live app speaks. Asked only before deploying the line. May throw. */
  liveAppProtocol(): Promise<LiveAppProtocol>;
  log(line: string): void;
}

/** `unstamped`: deployed, and the serving version is not confirmed to carry the stamp
 *  (none was written, or it did not read back), so the next run deploys it again.
 *  `unchecked`: the line was deployed without its protocol being compared (#3560). */
interface Lists {
  deployed: string[];
  skipped: string[];
  unstamped: string[];
  unchecked: { config: string; reason: string }[];
}
export type ObjectWorkersResult =
  | ({ ok: true } & Lists)
  /** `failed`: a needed deploy failed or threw. `refused`: the line build is older than the live app. */
  | ({ ok: false; kind: "failed" | "refused"; config: string; reason: string } & Lists);

/**
 * Each config in order, deployed or skipped. Stops at the first needed deploy that fails,
 * since a later Worker deployed after a failed one buys nothing: Slate is not uploaded
 * either way. Never throws.
 */
export async function deployObjectWorkers(ops: ObjectWorkerOps, configs: readonly string[]): Promise<ObjectWorkersResult> {
  const lists: Lists = { deployed: [], skipped: [], unstamped: [], unchecked: [] };
  const { deployed, skipped, unstamped, unchecked } = lists;
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
    if (config === CONFIRM_LINE_CONFIG) {
      let live: LiveAppProtocol;
      try {
        live = await ops.liveAppProtocol();
      } catch (err) {
        live = { unreadable: `reading it threw: ${err instanceof Error ? err.message : String(err)}` };
      }
      const check = decideLineProtocol(facts?.builtProtocol ?? null, live);
      if (check.action === "refuse") {
        ops.log(`object worker ${config}: REFUSED, ${check.reason}`);
        return { ok: false, kind: "refused", config, reason: check.reason, ...lists };
      }
      if (!check.checked) unchecked.push({ config, reason: check.reason });
      ops.log(`object worker ${config}: ${check.reason}`);
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
    if (!ok) return { ok: false, kind: "failed", config, reason: why, ...lists };
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
  return { ok: true, ...lists };
}

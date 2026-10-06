/**
 * What a verified hand-run deploy should do, decided purely (#1190).
 *
 * The #1037 verification lives entirely in the CI deploy job: the commit stamp and
 * the post-deploy probe both run there. A hand-run `pnpm cf:deploy`, which DEPLOY.md
 * documents as a supported path, uploads straight to production with neither, so the
 * live site reports commit `dev` and nothing confirms the new version went live or
 * that the site is healthy afterwards.
 *
 * The realistic occasion for a hand deploy is an urgent fix when the pipeline is
 * unavailable or too slow, which is exactly when an unverified release is most
 * expensive. The safety net should not be conditional on which route the deploy took.
 *
 * Kept pure and separate from the runner so every refusal is driven by a test with no
 * git, no network and no deploy.
 */

export interface DeployEnvironment {
  /** `GITHUB_SHA` when present, so this behaves identically if CI ever calls it. */
  githubSha?: string;
  /** `git rev-parse HEAD`, or null when git could not answer. */
  headSha: string | null;
  /**
   * Whether the working tree has uncommitted changes to tracked files, or null when
   * git could not be asked.
   *
   * Three states, not two, and deliberately so. An empty answer from `git status`
   * means a clean tree; a FAILED `git status` means nothing at all, and scoring that
   * as clean is how the dirty-tree refusal below silently stops applying (L11). The
   * refusal exists to stop a deploy whose stamped commit would not describe what
   * shipped, and a run that cannot tell is exactly the run where that is likeliest.
   */
  dirty: boolean | null;
  /** `BOOKING_API_KEY_CANARY`, which the probe needs to read /api/smoke/version. */
  bookingApiKey?: string;
  /** `APP_URL`, defaulted by the caller to production. */
  appUrl?: string;
  /** Set to bypass the dirty-tree refusal. Deliberately narrow: see below. */
  allowDirty?: boolean;
}

/** A refusal carries its own exit code so a shell caller can branch on which one it
 *  met, matching `pnpm verify:burst-counter`. */
export type DeployPlan =
  | {
      ok: true;
      commit: string;
      appUrl: string;
      /** Handed through `pnpm run cf:deploy` to `wrangler deploy` (#3178). */
      deployArgs: string[];
      /**
       * #3363: the environment the post-deploy probe runs with, carrying the commit
       * the stamp step writes. The probe reads PROBE_COMMIT or GITHUB_SHA, and outside
       * CI neither is set, so without this a hand deploy's probe refused before it
       * read anything (the first real one, #3344 on 2026-10-05).
       */
      probeEnv: { PROBE_COMMIT: string };
    }
  | { ok: false; code: number; reason: string };

/**
 * The version message a release carries, the same prefix the gradual deploy writes
 * (#3165). The Rollback workflow refuses a version whose message marks it a canary,
 * so a hand release says plainly that it is a release.
 */
export const HAND_RELEASE_MESSAGE_PREFIX = "slate-release-";

/**
 * The annotations a hand deploy gives its Worker version (#3178).
 *
 * The Rollback workflow (#3165) reads a version's tag to know which commit it should
 * report once it serves, so an untagged hand deploy could only be confirmed by
 * somebody typing the commit into the dispatch. The tag is the commit stamped into
 * the bundle, and ONLY when the tree was seen clean: with a dirty or unreadable tree
 * the stamp does not describe what shipped, and a tag repeating it would let the
 * rollback confirm a commit the version does not hold. Untagged, the rollback says it
 * could not confirm, which is the truth.
 *
 * No value carries a space or a quote: the adapter joins wrangler's arguments into
 * one shell line, so anything that needed quoting would be split.
 */
function deployArgsFor(commit: string, cleanTree: boolean): string[] {
  return [
    ...(cleanTree ? ["--tag", commit] : []),
    "--message",
    `${HAND_RELEASE_MESSAGE_PREFIX}${commit}`,
  ];
}

/** Production, when nothing says otherwise. */
export const DEFAULT_APP_URL = "https://slate.trypennie.app";

/**
 * Decide whether this deploy can be verified, and with what.
 *
 * The dirty-tree refusal is the one worth explaining. The stamp writes a COMMIT into
 * the bundle, and the probe then confirms that commit is serving. With uncommitted
 * changes in the tree, that pair is a lie in the most convincing possible form: the
 * probe passes, the version endpoint reports a real sha, and the code actually
 * running is something that exists nowhere in git. So a dirty tree is refused, and
 * the way out is to commit (locally is fine, an emergency does not require pushing
 * first), not to override.
 *
 * `ALLOW_DIRTY_DEPLOY=1` exists because refusing outright would mean the one command
 * with a safety net is unusable in the exact emergency it was built for. It is
 * honest about what it costs: the plan it returns still carries the HEAD commit,
 * because there is nothing else to stamp, so the caller must say out loud that the
 * stamp does not describe what shipped.
 */
export function planVerifiedDeploy(env: DeployEnvironment): DeployPlan {
  const sha = (env.githubSha ?? env.headSha ?? "").trim();
  if (!sha) {
    return {
      ok: false,
      code: 1,
      reason:
        "could not resolve a commit to stamp: git rev-parse HEAD gave nothing and GITHUB_SHA is unset",
    };
  }
  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    return {
      ok: false,
      code: 1,
      reason: `refusing to stamp "${sha}" as a commit: expected a 7 to 40 character hex sha`,
    };
  }
  if (env.dirty === null && !env.allowDirty) {
    // Its own reason, not the dirty one: "commit your changes" is useless advice to
    // somebody whose git is not answering, and a message may only claim what its
    // check actually measured.
    return {
      ok: false,
      code: 4,
      reason:
        "could not read whether the working tree is clean (git status did not answer), so there is no way to tell whether the commit stamped into the bundle would describe what shipped. Fix git, or set ALLOW_DIRTY_DEPLOY=1 to proceed knowing the stamp is unverified",
    };
  }
  if (env.dirty && !env.allowDirty) {
    return {
      ok: false,
      code: 2,
      reason:
        "the working tree has uncommitted changes, so the commit stamped into the bundle would not describe what shipped. Commit first (locally is enough), or set ALLOW_DIRTY_DEPLOY=1 and say so out loud",
    };
  }
  const key = (env.bookingApiKey ?? "").trim();
  if (!key) {
    return {
      ok: false,
      code: 3,
      reason:
        "BOOKING_API_KEY_CANARY is unset, so the probe cannot read /api/smoke/version and nothing would confirm the deploy. This is the whole point of this command, so it refuses rather than deploying unverified",
    };
  }
  const appUrl = (env.appUrl ?? DEFAULT_APP_URL).replace(/\/$/, "");
  if (!/^https:\/\/[^\s/]+/.test(appUrl)) {
    return {
      ok: false,
      code: 1,
      reason: `APP_URL must be an https origin; got "${appUrl}"`,
    };
  }
  const commit = sha.slice(0, 12);
  return { ok: true, commit, appUrl, deployArgs: deployArgsFor(commit, env.dirty === false), probeEnv: { PROBE_COMMIT: commit } };
}

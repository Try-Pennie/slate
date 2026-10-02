/**
 * Whether the CI migration drift check runs, skips, or refuses (#3051).
 *
 * The drift check needs SUPABASE_ACCESS_TOKEN and SUPABASE_DB_PASSWORD, and a
 * pull request run that Dependabot triggers never receives repo secrets. Without
 * them the check cannot read the remote database, and #766 made that a loud
 * failure rather than a green pass that verified nothing.
 *
 * #1106 skipped the drift steps on every `dependabot/*` head branch, judged in the
 * workflow `if:` alone. That skip was silent (the steps just read as skipped), it
 * trusted the branch NAME (anybody can push a branch called `dependabot/x`), and it
 * skipped even a Dependabot branch that touched a migration. This module replaces
 * it with one rule a suite can drive:
 *
 *   - Secrets present: run the real check, whoever opened the branch.
 *   - Secrets absent, and the run is a pull request whose head branch is
 *     `dependabot/*` AND whose actor is `dependabot[bot]`, and the changed file
 *     list was read and names no file under `supabase/migrations/`: SKIP, and say
 *     so with the reason.
 *   - Anything else with secrets absent: REFUSE, as #766 has always done. That
 *     includes a Dependabot branch that touches a migration, and a changed file
 *     list that could not be read or came back empty (a pull request always
 *     changes something, so empty is the shape of a broken read, L98). An
 *     undeterminable diff never earns a skip.
 *
 * Pure: no environment, no git, no clock. The workflow step that calls it is
 * scripts/migration-drift-gate.ts.
 */

export const DEPENDABOT_ACTOR = "dependabot[bot]";
export const DEPENDABOT_BRANCH_PREFIX = "dependabot/";
export const MIGRATIONS_DIR = "supabase/migrations/";

export type DriftGateInput = {
  /** github.event_name */
  eventName: string;
  /** github.head_ref (empty on a push) */
  headRef: string;
  /** github.actor */
  actor: string;
  /**
   * Files the pull request changes, repo relative. null when the list could not
   * be determined at all.
   */
  changedFiles: readonly string[] | null;
  /** Both SUPABASE_ACCESS_TOKEN and SUPABASE_DB_PASSWORD are non-empty. */
  secretsPresent: boolean;
};

export type DriftGateDecision =
  | { action: "run"; reason: string }
  | { action: "skip"; reason: string }
  | { action: "refuse"; reason: string };

const MISSING_SECRETS =
  "SUPABASE_ACCESS_TOKEN and/or SUPABASE_DB_PASSWORD is not set, so the drift check cannot read the remote database. " +
  "Failing rather than passing green while checking nothing (#766).";

/** A path under supabase/migrations/, tolerating a leading "./". */
export function touchesMigrations(path: string): boolean {
  return path.trim().replace(/^\.\//, "").startsWith(MIGRATIONS_DIR);
}

/** Both halves, never one: a branch NAME alone can be chosen by anybody. */
export function isDependabotPullRequest(input: Pick<DriftGateInput, "eventName" | "headRef" | "actor">): boolean {
  return (
    input.eventName === "pull_request" &&
    input.headRef.startsWith(DEPENDABOT_BRANCH_PREFIX) &&
    input.actor === DEPENDABOT_ACTOR
  );
}

export function decideMigrationDriftGate(input: DriftGateInput): DriftGateDecision {
  if (input.secretsPresent) {
    return { action: "run", reason: "the Supabase secrets are present, so the real drift check runs" };
  }
  if (!isDependabotPullRequest(input)) {
    const why =
      input.headRef.startsWith(DEPENDABOT_BRANCH_PREFIX) && input.actor !== DEPENDABOT_ACTOR
        ? ` The branch is named ${DEPENDABOT_BRANCH_PREFIX}* but the run was triggered by ${input.actor || "an unknown actor"}, not ${DEPENDABOT_ACTOR}, so it gets no Dependabot skip.`
        : "";
    return { action: "refuse", reason: MISSING_SECRETS + why };
  }
  if (input.changedFiles === null) {
    return {
      action: "refuse",
      reason:
        "This is a Dependabot pull request without the Supabase secrets, and the list of files it changes could not be determined, " +
        "so it cannot be shown to leave supabase/migrations/ alone. Refusing rather than skipping.",
    };
  }
  const files = input.changedFiles.map((f) => f.trim()).filter((f) => f.length > 0);
  if (files.length === 0) {
    return {
      action: "refuse",
      reason:
        "This is a Dependabot pull request without the Supabase secrets, and its changed file list came back empty. " +
        "A pull request always changes something, so an empty list is a broken read, not proof that no migration changed. Refusing rather than skipping.",
    };
  }
  const migrations = files.filter(touchesMigrations);
  if (migrations.length > 0) {
    return {
      action: "refuse",
      reason:
        `This Dependabot pull request changes ${migrations.length === 1 ? "a migration" : `${migrations.length} migrations`} ` +
        `(${migrations.join(", ")}) and the run has no Supabase secrets, so the drift check cannot verify it. ` +
        "Recreate the change on a normal branch so the real check runs.",
    };
  }
  return {
    action: "skip",
    reason:
      `Skipped: Dependabot pull request (${input.headRef}, actor ${input.actor}) changing ${files.length} ` +
      `file${files.length === 1 ? "" : "s"}, none under ${MIGRATIONS_DIR}. Dependabot runs never receive the Supabase secrets, ` +
      "so the drift check cannot run here, and with no migration in the diff there is nothing for it to catch. " +
      "Main still runs the real check after merge, and the deploy needs it.",
  };
}

/**
 * The files a pull request changes, read from the merge commit `actions/checkout`
 * makes for a pull_request event: its first parent is the base it merges into, so
 * `git diff HEAD^1 HEAD` is exactly what the pull request would change on that
 * base. Needs `fetch-depth: 2` on the checkout so the first parent is present.
 *
 * Returns null, never an empty list, whenever the answer cannot be trusted: HEAD is
 * not a two parent merge (a shallow clone, or a push run), or git failed. The
 * caller refuses on null (fail closed).
 */
export function changedFilesFromMergeCommit(git: (args: string[]) => string): string[] | null {
  try {
    const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(/\s+/).filter(Boolean);
    // The commit itself plus exactly two parents.
    if (parents.length !== 3) return null;
    // --no-renames: with rename detection on, a migration MOVED out of
    // supabase/migrations/ lists only its new path and would read as untouched.
    // Without it a rename lists both the deleted old path and the added new one.
    const out = git(["diff", "--name-only", "--no-renames", "HEAD^1", "HEAD"]);
    return out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  } catch {
    return null;
  }
}

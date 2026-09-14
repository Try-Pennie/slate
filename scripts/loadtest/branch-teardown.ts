/**
 * Whether the load run's teardown may delete a Supabase branch, and which one
 * (#2322).
 *
 * The `teardown` input said "Delete the branch and the deployment when the judge is
 * done" and the job deleted only the Worker. Nothing in it touched the branch and
 * the workflow had no token to do so. On 2026-09-14 the run finished, teardown
 * reported success, and `loadtest-2284` was still ACTIVE_HEALTHY and billing until
 * it was deleted by hand twenty minutes later: a success report about work never
 * attempted (L98).
 *
 * Deleting a branch is destructive against a REAL project, so the decision is
 * separated from the request and every refusal is its own code. Two hazards this
 * exists to hold off, both measured rather than imagined:
 *
 * - **The project carries a branch literally named `main`**, `is_default: true`,
 *   whose `project_ref` is the production project itself (listed 2026-09-14). Any
 *   spelling of "delete the branch" that reached that row would be catastrophic, so
 *   the default flag, the parent ref and the name shape are three separate refusals.
 * - **`DELETE /v1/branches/{id}` deletes one branch, and
 *   `DELETE /v1/projects/{ref}/branches` DISABLES PREVIEW BRANCHING for the whole
 *   project.** An empty id interpolated into a URL is one slash from the second, so
 *   an id that is not a uuid is refused before any request is built.
 *
 * Pure, so `scripts/test-loadtest-branch-teardown.ts` drives every outcome with no
 * network and no token.
 */

/** The fields the management API's branch listing carries that this decides on. */
export interface SupabaseBranch {
  id: string;
  name: string;
  project_ref: string;
  is_default: boolean;
}

/**
 * The names a load run may ever ask to delete.
 *
 * A convention, deliberately narrow: the run creates `loadtest-<issue>`. Anything
 * else is refused by SHAPE, before the listing is even consulted, so a typo or an
 * input defaulting to a git branch name cannot reach a lookup that might match.
 */
const THROWAWAY_NAME = /^loadtest-[a-z0-9][a-z0-9-]*$/;

/** A branch id the API will accept as a branch and never as a project. */
const BRANCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every way this can refuse, each on its own code, so a caller can branch on which
 * one it met and a reader is never sent after the wrong thing (L11).
 */
export const BRANCH_TEARDOWN_EXIT = {
  /** The name is not one a load run creates. */
  notThrowaway: 2,
  /** The listing could not be read, which is not the same as an empty project. */
  unreadable: 3,
  /** No branch of that name. Matching nothing is never a success (L100). */
  notFound: 4,
  /** More than one, which is its own refusal and never "take the first" (L521). */
  ambiguous: 5,
  /** The match is the project's DEFAULT branch. */
  isDefault: 6,
  /** The match points at the parent project rather than at a branch of its own. */
  isParent: 7,
  /** The id is not a branch id, so no URL is built from it at all. */
  unusableId: 8,
} as const;

export type BranchTeardownExit =
  (typeof BRANCH_TEARDOWN_EXIT)[keyof typeof BRANCH_TEARDOWN_EXIT];

export type BranchTeardownPlan =
  | { action: "delete"; branchId: string; name: string; why: string }
  /** Nothing was asked for. Not a failure, and not a teardown either. */
  | { action: "skip"; why: string }
  | { action: "refuse"; exit: BranchTeardownExit; why: string };

export function branchTeardownPlan(input: {
  /** The branch the run was dispatched with, or empty when none was named. */
  requestedName: string;
  /** The project's branches, or null when the listing could not be read. */
  branches: SupabaseBranch[] | null;
  /** The parent project this run belongs to. */
  projectRef: string;
}): BranchTeardownPlan {
  const name = input.requestedName.trim();
  if (name === "") {
    return {
      action: "skip",
      why:
        "no branch was named for this run, so none was deleted and any branch it used is STILL " +
        "there and still billing. Delete it by hand, or dispatch with branch_name next time",
    };
  }
  if (!THROWAWAY_NAME.test(name)) {
    return {
      action: "refuse",
      exit: BRANCH_TEARDOWN_EXIT.notThrowaway,
      why:
        `${JSON.stringify(name)} is not a name a load run creates, and this only ever deletes ` +
        "throwaways (loadtest-<issue>). Nothing was looked up and nothing was deleted",
    };
  }
  if (input.branches === null) {
    return {
      action: "refuse",
      exit: BRANCH_TEARDOWN_EXIT.unreadable,
      why:
        "the project's branch listing could not be read, so whether this branch exists is " +
        "unknown and nothing was deleted. An empty listing and a failed one are different " +
        "things and this is the second",
    };
  }
  const matches = input.branches.filter((b) => b.name === name);
  if (matches.length === 0) {
    return {
      action: "refuse",
      exit: BRANCH_TEARDOWN_EXIT.notFound,
      why:
        `no branch named ${JSON.stringify(name)} is on this project, so nothing was deleted. ` +
        "That is not a clean teardown: a branch under another name may still be billing",
    };
  }
  if (matches.length > 1) {
    return {
      action: "refuse",
      exit: BRANCH_TEARDOWN_EXIT.ambiguous,
      why:
        `${matches.length} branches are named ${JSON.stringify(name)}, so which one this run ` +
        "meant is unknown and none was deleted",
    };
  }
  const branch = matches[0]!;
  if (branch.is_default) {
    return {
      action: "refuse",
      exit: BRANCH_TEARDOWN_EXIT.isDefault,
      why:
        `the branch named ${JSON.stringify(name)} is the project's DEFAULT branch, whatever it ` +
        "is called, and this will never delete that",
    };
  }
  if (branch.project_ref === input.projectRef) {
    return {
      action: "refuse",
      exit: BRANCH_TEARDOWN_EXIT.isParent,
      why:
        `the branch named ${JSON.stringify(name)} points at the parent project ` +
        `(${input.projectRef}) rather than at a project of its own, so deleting it would act on ` +
        "production",
    };
  }
  if (!BRANCH_ID.test(branch.id.trim())) {
    return {
      action: "refuse",
      exit: BRANCH_TEARDOWN_EXIT.unusableId,
      why:
        `the branch named ${JSON.stringify(name)} carries an id this cannot use ` +
        `(${JSON.stringify(branch.id)}). No request was built: an empty one is a slash away from ` +
        "the endpoint that disables preview branching for the whole project",
    };
  }
  return {
    action: "delete",
    branchId: branch.id,
    name: branch.name,
    why: `deleting branch ${name} (${branch.id}), project ${branch.project_ref}`,
  };
}

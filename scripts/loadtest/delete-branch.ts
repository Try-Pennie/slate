// Delete the Supabase branch a load run created, or say exactly why it did not
// (#2322).
//
// The `teardown` input claimed to delete the branch and the job deleted only the
// Worker. On 2026-09-14 the run finished, teardown reported success, and
// `loadtest-2284` was still ACTIVE_HEALTHY and billing until somebody deleted it by
// hand twenty minutes later: a success report about work never attempted (L98).
//
// The two dangerous decisions are separated from the requests and both are pinned
// offline, because deleting a branch acts on a real project and the guard has to be
// testable with no token: WHICH branch may be deleted (`branch-teardown.ts`) and
// whether the delete actually LANDED (below, on an injected fetch).
//
// Run:
//   SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=... LOADTEST_BRANCH=loadtest-2284 \
//   node --experimental-strip-types scripts/loadtest/delete-branch.ts
import { branchTeardownPlan, type SupabaseBranch } from "./branch-teardown.ts";

const API = "https://api.supabase.com";

/** The subset of `fetch` this needs, so the tests drive it with no network. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Exit codes this file owns, above the ones `branchTeardownPlan` already declares. */
export const DELETE_EXIT = {
  /** The delete request itself was refused. */
  refused: 9,
  /** Accepted, and the listing could not be re-read, so it is UNCONFIRMED. */
  unconfirmed: 10,
  /** Accepted, and the branch is still there. */
  stillThere: 11,
} as const;

/**
 * The project's branches, or **null** when the listing could not be READ.
 *
 * Null rather than an empty array on every failure, and that is the whole point:
 * an answer this cannot read is not an empty project, and returning `[]` would
 * report "no branch of that name" about a branch sitting there billing (L215).
 */
export async function listBranches(
  fetchLike: FetchLike,
  token: string,
  projectRef: string,
  log: (line: string) => void,
): Promise<SupabaseBranch[] | null> {
  try {
    const res = await fetchLike(`${API}/v1/projects/${encodeURIComponent(projectRef)}/branches`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      log(`note: the branch listing answered ${res.status}`);
      return null;
    }
    const body = await res.json();
    if (!Array.isArray(body)) {
      log("note: the branch listing was not an array");
      return null;
    }
    return body as SupabaseBranch[];
  } catch (err) {
    log(`note: the branch listing could not be fetched (${String(err)})`);
    return null;
  }
}

export interface TeardownOutcome {
  exit: number;
  /** What to print, in order. One of these is what a reader acts on. */
  lines: string[];
  /** Whether a DELETE was actually sent, so a test can prove the refusals sent none. */
  deleteSent: boolean;
}

/**
 * The whole flow, on an injected fetch.
 *
 * The part worth reading: the teardown is done when the branch is GONE, confirmed
 * by re-reading the listing, never when the delete command exited. That is the same
 * rule the Worker half of this job already follows (#2277), and it is why an
 * accepted delete whose listing cannot be re-read exits UNCONFIRMED rather than
 * clean: a 200 from a delete and a branch that is really gone are two different
 * facts (L98).
 */
export async function runBranchTeardown(input: {
  fetchLike: FetchLike;
  token: string;
  projectRef: string;
  requestedName: string;
}): Promise<TeardownOutcome> {
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  const branches = await listBranches(input.fetchLike, input.token, input.projectRef, log);
  const plan = branchTeardownPlan({
    requestedName: input.requestedName,
    branches,
    projectRef: input.projectRef,
  });

  if (plan.action === "skip") {
    // Not a failure, and deliberately loud: a teardown saying nothing about the
    // branch reads as one that dealt with it, which is this issue.
    log(`BRANCH NOT DELETED: ${plan.why}`);
    log(`::warning title=Branch still standing::${plan.why}`);
    return { exit: 0, lines, deleteSent: false };
  }
  if (plan.action === "refuse") {
    log(`FAILED (${plan.exit}): ${plan.why}`);
    return { exit: plan.exit, lines, deleteSent: false };
  }

  log(plan.why);
  const res = await input.fetchLike(
    `${API}/v1/branches/${encodeURIComponent(plan.branchId)}`,
    { method: "DELETE", headers: { authorization: `Bearer ${input.token}` } },
  );
  if (!res.ok) {
    log(
      `FAILED (${DELETE_EXIT.refused}): the delete answered ${res.status}, so branch ` +
        `${plan.name} may still be there. Check it by hand: it bills while it exists.`,
    );
    return { exit: DELETE_EXIT.refused, lines, deleteSent: true };
  }

  const after = await listBranches(input.fetchLike, input.token, input.projectRef, log);
  if (after === null) {
    log(
      `FAILED (${DELETE_EXIT.unconfirmed}): the delete was accepted and the branch listing could ` +
        `not be re-read, so whether ${plan.name} is really gone is unconfirmed.`,
    );
    return { exit: DELETE_EXIT.unconfirmed, lines, deleteSent: true };
  }
  if (after.some((b) => b.id === plan.branchId)) {
    log(
      `FAILED (${DELETE_EXIT.stillThere}): the delete was accepted and branch ${plan.name} is ` +
        "STILL in the listing.",
    );
    return { exit: DELETE_EXIT.stillThere, lines, deleteSent: true };
  }
  log(`branch ${plan.name} is gone (${after.length} branches left on ${input.projectRef}).`);
  return { exit: 0, lines, deleteSent: true };
}

function need(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) {
    console.error(`FAILED: ${name} is not set, so nothing was attempted.`);
    process.exit(1);
  }
  return v;
}

// Only when RUN, never when imported by its test.
if (process.argv[1]?.endsWith("delete-branch.ts")) {
  const outcome = await runBranchTeardown({
    fetchLike: fetch as unknown as FetchLike,
    token: need("SUPABASE_ACCESS_TOKEN"),
    projectRef: need("SUPABASE_PROJECT_REF"),
    // env-ok: LOADTEST_BRANCH (optional; the branch this run created. Absent means
    // the run was dispatched without one, which is reported as a branch still
    // standing rather than as a clean teardown)
    requestedName: process.env.LOADTEST_BRANCH ?? "",
  });
  for (const line of outcome.lines) {
    if (line.startsWith("FAILED") || line.startsWith("note:")) console.error(line);
    else console.log(line);
  }
  process.exit(outcome.exit);
}

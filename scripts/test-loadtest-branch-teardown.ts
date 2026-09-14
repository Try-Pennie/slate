// The load run's teardown really deletes the branch now (#2322).
//
// The `teardown` input said "Delete the branch and the deployment when the judge is
// done". The job deleted only the Worker. Nothing in it touched the Supabase branch
// and the workflow had no token to do so. On 2026-09-14 (run 34862015419) the run
// finished, teardown reported success, and `loadtest-2284` was still
// ACTIVE_HEALTHY and billing until it was deleted by hand twenty minutes later: a
// success report about work never attempted (L98).
//
// Deleting a branch is destructive against a REAL project, and the live listing
// shows why the guards below are not theoretical. Measured 2026-09-14, the project
// carries a branch literally named `main`, `is_default: true`, whose `project_ref`
// is the production project itself. Every refusal here exists because some spelling
// of "delete the branch" would otherwise reach that row.
//
// The API's own shape is the other hazard. `DELETE /v1/branches/{id}` deletes one
// branch; `DELETE /v1/projects/{ref}/branches` DISABLES PREVIEW BRANCHING for the
// whole project. An empty id interpolated into a URL is one slash away from the
// second, so an id that is not a uuid is refused before any request is built.
//
// Run: node --experimental-strip-types scripts/test-loadtest-branch-teardown.ts
import { branchTeardownPlan, BRANCH_TEARDOWN_EXIT } from "./loadtest/branch-teardown.ts";
import { runBranchTeardown, DELETE_EXIT, type FetchLike } from "./loadtest/delete-branch.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const PROJECT = "drukfvgaynzrralbzkzj";

/** The live shape, measured 2026-09-14 rather than invented (L52). */
const MAIN = {
  id: "7cca7303-a9c8-436e-8440-3e5672aa9203",
  name: "main",
  project_ref: PROJECT,
  is_default: true,
};
const THROWAWAY = {
  id: "11111111-2222-3333-4444-555555555555",
  name: "loadtest-2284",
  project_ref: "zzzzzzzzzzzzzzzzzzzz",
  is_default: false,
};

// --- the ordinary case ------------------------------------------------------------
{
  const plan = branchTeardownPlan({
    requestedName: "loadtest-2284",
    branches: [MAIN, THROWAWAY],
    projectRef: PROJECT,
  });
  eq(plan.action, "delete", "a throwaway branch named by the run is deleted");
  assert(plan.action === "delete" && plan.branchId === THROWAWAY.id, "by its own id");
}

// --- nothing was asked for ----------------------------------------------------------
{
  // The run was dispatched with no branch name. That is not a failure and it is not
  // a teardown either: the branch is still there and billing, and the job has to
  // SAY so rather than exiting zero over work nobody asked for (L98).
  const plan = branchTeardownPlan({ requestedName: "", branches: [MAIN], projectRef: PROJECT });
  eq(plan.action, "skip", "no branch named is a skip, never a silent success");
  assert(plan.action === "skip" && /still/i.test(plan.why), "and it says the branch is still there");
}

// --- the project default is never deletable -----------------------------------------
{
  // The live project really carries a branch named `main`. Somebody typing it, or a
  // workflow input defaulting to a git branch name, must hit a refusal rather than
  // the production project.
  const plan = branchTeardownPlan({
    requestedName: "main",
    branches: [MAIN],
    projectRef: PROJECT,
  });
  eq(plan.action, "refuse", "the project default is refused");
  assert(
    plan.action === "refuse" && plan.exit === BRANCH_TEARDOWN_EXIT.notThrowaway,
    "on the shape refusal, because the name is not a throwaway name in the first place",
  );
}
{
  // And a branch that IS named like a throwaway but is flagged default is refused
  // too: the name is a convention and the flag is the fact (L63).
  const plan = branchTeardownPlan({
    requestedName: "loadtest-2284",
    branches: [{ ...THROWAWAY, is_default: true }],
    projectRef: PROJECT,
  });
  eq(plan.action, "refuse", "a default branch is refused whatever it is called");
  assert(plan.action === "refuse" && plan.exit === BRANCH_TEARDOWN_EXIT.isDefault, "on its own code");
}

// --- a branch that IS the parent project ----------------------------------------------
{
  const plan = branchTeardownPlan({
    requestedName: "loadtest-2284",
    branches: [{ ...THROWAWAY, project_ref: PROJECT }],
    projectRef: PROJECT,
  });
  eq(plan.action, "refuse", "a row pointing at the parent project is refused");
  assert(plan.action === "refuse" && plan.exit === BRANCH_TEARDOWN_EXIT.isParent, "on its own code");
}

// --- a name that is not a throwaway ------------------------------------------------------
{
  for (const name of ["staging", "loadtest", "prod-2284", "../loadtest-2284", "loadtest-2284 "]) {
    const plan = branchTeardownPlan({
      requestedName: name,
      branches: [MAIN, THROWAWAY],
      projectRef: PROJECT,
    });
    // A trailing space is trimmed and then judged, so `loadtest-2284 ` is a real
    // request; everything else here is refused by shape before any lookup.
    if (name.trim() === "loadtest-2284") {
      eq(plan.action, "delete", `${JSON.stringify(name)} is trimmed and then honoured`);
      continue;
    }
    eq(plan.action, "refuse", `${JSON.stringify(name)} is refused by shape`);
    assert(
      plan.action === "refuse" && plan.exit === BRANCH_TEARDOWN_EXIT.notThrowaway,
      `${JSON.stringify(name)} is refused for its shape rather than for not being found`,
    );
  }
}

// --- matching nothing is never a success ---------------------------------------------------
{
  // An operation that finds its target by matching text reports SUCCESS when it
  // matches NOTHING, and the next step acts on a state nobody created (L100). Here
  // that would read as a torn down branch that is still billing.
  const plan = branchTeardownPlan({
    requestedName: "loadtest-9999",
    branches: [MAIN, THROWAWAY],
    projectRef: PROJECT,
  });
  eq(plan.action, "refuse", "a name matching no branch is refused");
  assert(plan.action === "refuse" && plan.exit === BRANCH_TEARDOWN_EXIT.notFound, "on its own code");
}

// --- matching more than one is its own refusal ------------------------------------------------
{
  // A lookup that requires exactly one match must treat MANY as its own refusal,
  // never as absence and never by taking the first (L521).
  const plan = branchTeardownPlan({
    requestedName: "loadtest-2284",
    branches: [THROWAWAY, { ...THROWAWAY, id: "99999999-2222-3333-4444-555555555555" }],
    projectRef: PROJECT,
  });
  eq(plan.action, "refuse", "two branches of one name is refused");
  assert(plan.action === "refuse" && plan.exit === BRANCH_TEARDOWN_EXIT.ambiguous, "on its own code");
}

// --- an unreadable listing is not an empty one -------------------------------------------------
{
  // A listing that failed and a project with no branches render the same as an
  // empty array, and the second would be reported as "not found", sending somebody
  // to look for a branch that is sitting there (L215, L11).
  const plan = branchTeardownPlan({
    requestedName: "loadtest-2284",
    branches: null,
    projectRef: PROJECT,
  });
  eq(plan.action, "refuse", "a listing that could not be read is refused");
  assert(plan.action === "refuse" && plan.exit === BRANCH_TEARDOWN_EXIT.unreadable, "on its own code");
}

// --- an id that is not a uuid never becomes a URL -------------------------------------------------
{
  // `DELETE /v1/branches/{id}` deletes one branch. `DELETE /v1/projects/{ref}/branches`
  // DISABLES PREVIEW BRANCHING for the whole project. An empty id is one slash from
  // the second, so it is refused before any request is built.
  for (const id of ["", "   ", "not-a-uuid", "../projects/x"]) {
    const plan = branchTeardownPlan({
      requestedName: "loadtest-2284",
      branches: [{ ...THROWAWAY, id }],
      projectRef: PROJECT,
    });
    eq(plan.action, "refuse", `an id of ${JSON.stringify(id)} is refused`);
    assert(
      plan.action === "refuse" && plan.exit === BRANCH_TEARDOWN_EXIT.unusableId,
      "on its own code, before anything is sent",
    );
  }
}

// --- every outcome says something different (L11) -----------------------------------------------
{
  const cases = [
    { requestedName: "loadtest-2284", branches: [MAIN, THROWAWAY], projectRef: PROJECT },
    { requestedName: "", branches: [MAIN], projectRef: PROJECT },
    { requestedName: "staging", branches: [MAIN], projectRef: PROJECT },
    { requestedName: "loadtest-9999", branches: [MAIN, THROWAWAY], projectRef: PROJECT },
    {
      requestedName: "loadtest-2284",
      branches: [THROWAWAY, { ...THROWAWAY, id: "99999999-2222-3333-4444-555555555555" }],
      projectRef: PROJECT,
    },
    { requestedName: "loadtest-2284", branches: null, projectRef: PROJECT },
    {
      requestedName: "loadtest-2284",
      branches: [{ ...THROWAWAY, is_default: true }],
      projectRef: PROJECT,
    },
    {
      requestedName: "loadtest-2284",
      branches: [{ ...THROWAWAY, project_ref: PROJECT }],
      projectRef: PROJECT,
    },
    { requestedName: "loadtest-2284", branches: [{ ...THROWAWAY, id: "" }], projectRef: PROJECT },
  ];
  const said = new Set<string>();
  const codes = new Set<number>();
  for (const c of cases) {
    const plan = branchTeardownPlan(c);
    const why = plan.action === "delete" ? `delete ${plan.branchId}` : plan.why;
    assert(!said.has(why), `each outcome has its own sentence: ${why}`);
    said.add(why);
    if (plan.action === "refuse") codes.add(plan.exit);
  }
  eq(said.size, cases.length, "no two outcomes say the same thing");
  eq(
    codes.size,
    cases.filter((c) => branchTeardownPlan(c).action === "refuse").length,
    "and no two refusals share an exit code, so a caller can branch on which it met",
  );
}

// --- every declared exit code is one some case reaches (L151) -------------------------------------
{
  const reached = new Set<number>();
  const cases = [
    { requestedName: "staging", branches: [MAIN], projectRef: PROJECT },
    { requestedName: "loadtest-9999", branches: [MAIN, THROWAWAY], projectRef: PROJECT },
    {
      requestedName: "loadtest-2284",
      branches: [THROWAWAY, { ...THROWAWAY, id: "99999999-2222-3333-4444-555555555555" }],
      projectRef: PROJECT,
    },
    { requestedName: "loadtest-2284", branches: null, projectRef: PROJECT },
    {
      requestedName: "loadtest-2284",
      branches: [{ ...THROWAWAY, is_default: true }],
      projectRef: PROJECT,
    },
    {
      requestedName: "loadtest-2284",
      branches: [{ ...THROWAWAY, project_ref: PROJECT }],
      projectRef: PROJECT,
    },
    { requestedName: "loadtest-2284", branches: [{ ...THROWAWAY, id: "" }], projectRef: PROJECT },
  ];
  for (const c of cases) {
    const plan = branchTeardownPlan(c);
    if (plan.action === "refuse") reached.add(plan.exit);
  }
  for (const declared of Object.values(BRANCH_TEARDOWN_EXIT)) {
    assert(reached.has(declared), `a declared exit code no case can produce: ${declared}`);
  }
}

// =============================================================================
// THE REQUESTS, on an injected fetch. The choosing above is half of it; the other
// half is whether the delete actually LANDED. A 200 from a delete and a branch that
// is really gone are two different facts, and the first standing in for the second
// is exactly the shape this issue is about (L98, #2277).
// =============================================================================

/**
 * A Supabase management API that records what was asked of it.
 *
 * `listings` is consumed one call at a time, so the BEFORE and AFTER reads can
 * legitimately differ, which is the only way to drive the confirm step.
 */
function api(opts: {
  listings: (SupabaseBranchRow[] | "unreadable" | "not-array")[];
  deleteStatus?: number;
}) {
  const calls: { url: string; method: string }[] = [];
  const listingsLeft = [...opts.listings];
  const fetchLike: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (method === "DELETE") {
      const status = opts.deleteStatus ?? 200;
      return { ok: status < 400, status, json: async () => ({}) };
    }
    const next = listingsLeft.shift();
    if (next === undefined || next === "unreadable") {
      return { ok: false, status: 500, json: async () => ({}) };
    }
    if (next === "not-array") return { ok: true, status: 200, json: async () => ({ branches: [] }) };
    return { ok: true, status: 200, json: async () => next };
  };
  return { fetchLike, calls };
}

type SupabaseBranchRow = typeof MAIN;

// --- the ordinary case: deleted, and CONFIRMED gone -------------------------------
{
  const { fetchLike, calls } = api({ listings: [[MAIN, THROWAWAY], [MAIN]] });
  const out = await runBranchTeardown({
    fetchLike,
    token: "t",
    projectRef: PROJECT,
    requestedName: "loadtest-2284",
  });
  eq(out.exit, 0, "a branch deleted and confirmed gone is a clean teardown");
  assert(out.deleteSent, "and a DELETE really went");
  const del = calls.find((c) => c.method === "DELETE");
  assert(del !== undefined && del.url.endsWith(`/v1/branches/${THROWAWAY.id}`), "addressed by id");
  assert(
    calls.filter((c) => c.method === "GET").length === 2,
    "with the listing read again afterwards, because a 200 is not a branch being gone",
  );
}

// --- accepted, and still there -----------------------------------------------------
{
  // The API said yes and the branch is in the listing. Reporting this as clean is
  // the failure this whole issue is about, one layer down.
  const { fetchLike } = api({ listings: [[MAIN, THROWAWAY], [MAIN, THROWAWAY]] });
  const out = await runBranchTeardown({
    fetchLike,
    token: "t",
    projectRef: PROJECT,
    requestedName: "loadtest-2284",
  });
  eq(out.exit, DELETE_EXIT.stillThere, "an accepted delete that changed nothing is a failure");
}

// --- accepted, and the listing could not be re-read ----------------------------------
{
  const { fetchLike } = api({ listings: [[MAIN, THROWAWAY], "unreadable"] });
  const out = await runBranchTeardown({
    fetchLike,
    token: "t",
    projectRef: PROJECT,
    requestedName: "loadtest-2284",
  });
  eq(out.exit, DELETE_EXIT.unconfirmed, "an unconfirmed delete is not a clean teardown");
  assert(
    out.exit !== DELETE_EXIT.stillThere,
    "and it is kept apart from a delete that demonstrably did nothing (L11)",
  );
}

// --- the delete itself refused --------------------------------------------------------
{
  const { fetchLike } = api({ listings: [[MAIN, THROWAWAY]], deleteStatus: 403 });
  const out = await runBranchTeardown({
    fetchLike,
    token: "t",
    projectRef: PROJECT,
    requestedName: "loadtest-2284",
  });
  eq(out.exit, DELETE_EXIT.refused, "a refused delete says so");
  assert(
    out.lines.some((l) => /bills while it exists/.test(l)),
    "and says why somebody has to go and look",
  );
}

// --- an unreadable listing never becomes an empty project ------------------------------
{
  // The reason this matters: `[]` would make the plan report "no branch of that
  // name", which reads as a tidy project while a branch sits there billing (L215).
  for (const first of ["unreadable", "not-array"] as const) {
    const { fetchLike, calls } = api({ listings: [first] });
    const out = await runBranchTeardown({
      fetchLike,
      token: "t",
      projectRef: PROJECT,
      requestedName: "loadtest-2284",
    });
    eq(
      out.exit,
      BRANCH_TEARDOWN_EXIT.unreadable,
      `a ${first} listing is refused as unreadable, never as an empty project`,
    );
    assert(!calls.some((c) => c.method === "DELETE"), "and nothing was deleted");
  }
}

// --- every refusal sends NO delete at all -------------------------------------------------
{
  // The guards are only worth anything if they stop the request rather than
  // reporting on it afterwards.
  const refusals: { name: string; branches: SupabaseBranchRow[] }[] = [
    { name: "staging", branches: [MAIN] },
    { name: "loadtest-9999", branches: [MAIN, THROWAWAY] },
    { name: "loadtest-2284", branches: [{ ...THROWAWAY, is_default: true }] },
    { name: "loadtest-2284", branches: [{ ...THROWAWAY, project_ref: PROJECT }] },
    { name: "loadtest-2284", branches: [{ ...THROWAWAY, id: "" }] },
  ];
  for (const r of refusals) {
    const { fetchLike, calls } = api({ listings: [r.branches] });
    const out = await runBranchTeardown({
      fetchLike,
      token: "t",
      projectRef: PROJECT,
      requestedName: r.name,
    });
    assert(out.exit !== 0, `${r.name} is refused`);
    assert(!out.deleteSent, `and ${r.name} sent no DELETE at all`);
    assert(!calls.some((c) => c.method === "DELETE"), `and nothing reached the API for ${r.name}`);
  }
}

// --- no branch named: a warning and a zero, never a silent clean teardown --------------------
{
  const { fetchLike, calls } = api({ listings: [[MAIN, THROWAWAY]] });
  const out = await runBranchTeardown({
    fetchLike,
    token: "t",
    projectRef: PROJECT,
    requestedName: "",
  });
  eq(out.exit, 0, "a run dispatched with no branch name is not a failure");
  assert(!calls.some((c) => c.method === "DELETE"), "and deletes nothing");
  assert(
    out.lines.some((l) => l.startsWith("::warning")),
    "but says out loud that a branch may still be standing, which is the point of #2322",
  );
}

finish();

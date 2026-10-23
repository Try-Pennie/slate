// The load run due nag (#3103) names EVERY qualifying push to main, on ONE issue
// (#3553, L1020).
//
// GitHub keeps one running and ONE pending run per concurrency group, and a third
// arrival cancels the pending one even with cancel-in-progress false. The nag used to
// sit under one constant group, so in a burst of merges the middle push was never
// named. This pins, offline:
//
//   - the nag's group is keyed on the push itself, so no run of it is ever dropped;
//   - every workflow fired by `push` or `workflow_run` keys any concurrency group on
//     the event, or is listed below with the reason dropping a superseded run loses
//     nothing (and a listed one that no longer needs it fails, so the list cannot rot);
//   - with every push running, two runs racing to open the issue settle on one, which
//     is driven through a fake GitHub that interleaves them;
//   - the lookup refuses a listing it cannot trust instead of opening a duplicate.
//
// Run: node --experimental-strip-types scripts/test-loadtest-due-nag.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { parseWorkflowTriggers } from "./lib/scan-workflow-jobs.ts";
import {
  LOADTEST_DUE_TITLE,
  anotherPushComment,
  issueNumberFromUrl,
  issuesTitledFromListing,
  runNag,
  type NagClient,
  type Push,
} from "./lib/loadtest-due-nag.ts";

const ROOT = join(import.meta.dirname, "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");

// --- the workflows ---------------------------------------------------------------

/** Every concurrency group a workflow declares, top level or per job. */
function concurrencyGroups(source: string): string[] {
  const lines = source.split("\n");
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    const inline = /^\s*concurrency:\s*(\S.*)$/.exec(line);
    if (inline && !inline[1].startsWith("#")) {
      out.push(inline[1].trim());
      return;
    }
    if (!/^\s*concurrency:\s*(#.*)?$/.test(line)) return;
    for (const next of lines.slice(i + 1)) {
      if (/^\s*#/.test(next) || next.trim() === "") continue;
      const g = /^\s+group:\s*(.+)$/.exec(next);
      if (g) out.push(g[1].trim());
      if (!/^\s+(group|cancel-in-progress):/.test(next)) break;
    }
  });
  return out;
}

/** Expressions that differ for every event, so a group carrying one never drops a run. */
const EVENT_IDENTITY = /\$\{\{\s*github\.(sha|run_id|event\.after|event\.workflow_run\.(id|head_sha))\s*\}\}/;

/**
 * Workflows fired by every push or every finished run whose group is deliberately one
 * per ref, with why a superseded pending run loses nothing. Named here so the guard
 * reads them, and checked below to still need it.
 */
const DROPS_SUPERSEDED_RUNS: Record<string, string> = {
  "ci.yml":
    "a run on main IS the deploy, and a pending one a newer merge supersedes drops nothing: main is linear, so the newer commit contains it and deploys it, the last of a burst is never the one cancelled, and main_not_deployed pages if the tip is not live (docs/workflows.md)",
};

const workflowFiles = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
assert(workflowFiles.length > 0, "found the workflows");
// Control: the parser sees the groups it must, or every check below passes vacuously.
eq(
  concurrencyGroups(readFileSync(join(WORKFLOWS, "ci.yml"), "utf8")),
  ["${{ github.workflow }}-${{ github.ref }}"],
  "control: the group parser reads ci.yml's group",
);
eq(concurrencyGroups("jobs:\n  a:\n    concurrency: one-name\n"), ["one-name"], "control: the parser reads an inline job group");
assert(!EVENT_IDENTITY.test("loadtest-due"), "control: a constant name is not keyed on the event");
assert(EVENT_IDENTITY.test("x-${{ github.sha }}"), "control: a group carrying the sha is keyed on the event");

let eventDriven = 0;
for (const file of workflowFiles) {
  const source = readFileSync(join(WORKFLOWS, file), "utf8");
  const { events } = parseWorkflowTriggers(source);
  if (!events.includes("push") && !events.includes("workflow_run")) continue;
  eventDriven++;
  const constant = concurrencyGroups(source).filter((g) => !EVENT_IDENTITY.test(g));
  const reason = DROPS_SUPERSEDED_RUNS[file];
  if (reason) {
    assert(constant.length > 0, `${file} is listed as dropping superseded runs and still has a group that does`);
    continue;
  }
  assert(
    constant.length === 0,
    `${file} runs on every ${events.includes("push") ? "push" : "finished run"}, so its concurrency group is keyed on the event, not ${JSON.stringify(constant)} (L1020)`,
  );
}
assert(eventDriven >= 4, `found the push and workflow_run workflows (${eventDriven})`);
for (const file of Object.keys(DROPS_SUPERSEDED_RUNS)) {
  assert(workflowFiles.includes(file), `${file}, listed as dropping superseded runs, exists`);
}

const nagWorkflow = readFileSync(join(WORKFLOWS, "loadtest-due.yml"), "utf8");
assert(
  /node --experimental-strip-types scripts\/loadtest-due-nag\.ts/.test(nagWorkflow),
  "the nag workflow runs the tested decision rather than its own copy of it",
);
assert(!/issue list[^\n]*--search/.test(nagWorkflow), "the nag never finds its issue through the search index");

// --- the decision, through a fake GitHub -------------------------------------------

type Issue = { number: number; title: string; open: boolean; body: string; comments: string[] };

function fakeGitHub(seed: Issue[] = []) {
  const issues = seed.map((i) => ({ ...i, comments: [...i.comments] }));
  let next = Math.max(100, ...issues.map((i) => i.number)) + 1;
  const hooks: { beforeList?: () => void; beforeCreate?: () => void } = {};
  const client: NagClient = {
    openIssuesTitled(title) {
      const h = hooks.beforeList;
      hooks.beforeList = undefined;
      const snapshot = issues.filter((i) => i.open && i.title === title).map((i) => i.number);
      h?.();
      return snapshot;
    },
    create(title, body) {
      const h = hooks.beforeCreate;
      hooks.beforeCreate = undefined;
      h?.();
      const number = next++;
      issues.push({ number, title, body, open: true, comments: [] });
      return number;
    },
    comment(n, body) {
      const i = issues.find((x) => x.number === n);
      if (!i) throw new Error(`no issue #${n}`);
      i.comments.push(body);
    },
    close(n) {
      const i = issues.find((x) => x.number === n);
      if (!i) throw new Error(`no issue #${n}`);
      i.open = false;
    },
  };
  return { client, issues, hooks };
}

const push = (sha: string): Push => ({ repo: "Try-Pennie/slate", sha, before: `${sha}-before` });
const openOnes = (issues: Issue[]) => issues.filter((i) => i.open && i.title === LOADTEST_DUE_TITLE);
/** Where a push is named: an issue body or a comment that carries its sha. */
const namedIn = (issues: Issue[], sha: string) =>
  issues.filter((i) => i.body.includes(sha) || i.comments.some((c) => c.includes(sha))).map((i) => i.number);

{
  // Nothing open: it opens one, naming the push in the body and nowhere else.
  const gh = fakeGitHub();
  const out = runNag(gh.client, push("aaa111"));
  eq(openOnes(gh.issues).length, 1, "with nothing open, one issue is opened");
  eq(out.opened, out.kept, "the opened issue is the one kept");
  assert(gh.issues[0].body.includes("aaa111"), "the opening body names the push");
  eq(gh.issues[0].comments.length, 0, "and no comment repeats it");
}
{
  // One open: it comments there and opens nothing.
  const gh = fakeGitHub([{ number: 3213, title: LOADTEST_DUE_TITLE, open: true, body: "x", comments: [] }]);
  const out = runNag(gh.client, push("bbb222"));
  eq(out, { kept: 3213, opened: null, closed: [] }, "an open issue is commented on, nothing opened");
  eq(gh.issues[0].comments, [anotherPushComment(push("bbb222"))], "the comment names the push");
}
{
  // An issue with another title is not the one.
  const gh = fakeGitHub([{ number: 50, title: `${LOADTEST_DUE_TITLE} (old)`, open: true, body: "", comments: [] }]);
  const out = runNag(gh.client, push("ccc333"));
  assert(out.opened !== null && out.kept !== 50, "only the exact title counts as the open issue");
}
{
  // The state on 2026-10-22: #3213 open and #4089 opened beside it. The next push
  // names itself on #3213 and closes #4089, saying so on both.
  const gh = fakeGitHub([
    { number: 3213, title: LOADTEST_DUE_TITLE, open: true, body: "first", comments: [] },
    { number: 4089, title: LOADTEST_DUE_TITLE, open: true, body: "57fae5e0", comments: [] },
  ]);
  const out = runNag(gh.client, push("ddd444"));
  eq(out, { kept: 3213, opened: null, closed: [4089] }, "the lowest is kept and the duplicate closed");
  eq(openOnes(gh.issues).map((i) => i.number), [3213], "one issue is left open");
  assert(gh.issues[1].comments.some((c) => c.includes("#3213")), "the duplicate says where the rule went");
  assert(gh.issues[0].comments.some((c) => c.includes("#4089")), "the kept issue points at the closed duplicate");
  assert(namedIn(gh.issues, "ddd444").includes(3213), "the push is named on the kept issue");
}
{
  // Two runs racing, now that the group no longer serialises them. Run B lists in the
  // same instant as run A, so both see nothing open and both open an issue.
  const gh = fakeGitHub();
  gh.hooks.beforeList = () => runNag(gh.client, push("bbbbbb"));
  runNag(gh.client, push("aaaaaa"));
  eq(openOnes(gh.issues).length, 1, "two racing runs leave one issue open");
  const kept = openOnes(gh.issues)[0].number;
  for (const sha of ["aaaaaa", "bbbbbb"]) {
    const where = namedIn(gh.issues, sha);
    assert(
      where.includes(kept) || gh.issues.some((i) => where.includes(i.number) && gh.issues.find((k) => k.number === kept)!.comments.some((c) => c.includes(`#${i.number}`))),
      `push ${sha} is reachable from the kept issue`,
    );
  }
}
{
  // The other interleaving: run B opens its issue between run A's listing and run A's
  // opening, so A's re-read sees both.
  const gh = fakeGitHub();
  gh.hooks.beforeCreate = () => runNag(gh.client, push("dddddd"));
  runNag(gh.client, push("cccccc"));
  eq(openOnes(gh.issues).length, 1, "the other interleaving also leaves one issue open");
}
{
  // A listing that fails is not "nothing open": it throws and opens nothing.
  const gh = fakeGitHub();
  const broken: NagClient = {
    ...gh.client,
    openIssuesTitled() {
      throw new Error("gh: HTTP 502");
    },
  };
  let threw = false;
  try {
    runNag(broken, push("eee555"));
  } catch {
    threw = true;
  }
  assert(threw, "a failed listing fails the run");
  eq(gh.issues.length, 0, "and opens nothing");
}

// --- reading what gh prints --------------------------------------------------------
eq(
  issuesTitledFromListing(
    JSON.stringify([
      { number: 7, title: LOADTEST_DUE_TITLE },
      { number: 8, title: "something else" },
    ]),
    LOADTEST_DUE_TITLE,
    1000,
  ),
  [7],
  "the listing is filtered to the exact title",
);
let truncated = false;
try {
  issuesTitledFromListing(JSON.stringify([{ number: 1, title: "a" }, { number: 2, title: "b" }]), LOADTEST_DUE_TITLE, 2);
} catch {
  truncated = true;
}
assert(truncated, "a listing as long as its limit may be cut short and is refused");
let notList = false;
try {
  issuesTitledFromListing('{"message":"Bad credentials"}', LOADTEST_DUE_TITLE, 1000);
} catch {
  notList = true;
}
assert(notList, "an error body is refused rather than read as no issues");
eq(issueNumberFromUrl("https://github.com/Try-Pennie/slate/issues/4089\n"), 4089, "the opened number is read from the URL");
eq(issueNumberFromUrl("could not create issue"), null, "and nothing is read from anything else");

finish();

// The load run due nag (#3103) lists EVERY qualifying push to main on ONE issue, and
// notifies only when that issue opens (#4286).
//
// Each push used to post a comment, so #3213 collected 227 of them and every one
// notified everyone subscribed. Now a push is recorded silently in the issue
// DESCRIPTION. Runs writing one description at the same time would overwrite each
// other, so the workflow runs one at a time under a constant concurrency group, and
// GitHub cancels the pending middle run of a burst (L1020). What makes that lose
// nothing is that every run REBUILDS the whole list from main as it stands when the run
// starts, rather than appending its own push. This pins, offline:
//
//   - the nag runs one at a time, fetches all of main's history, and is the second
//     listed exception to the rule that a push workflow keys its group on the event;
//   - a burst whose middle run is cancelled still ends with every push listed;
//   - opening the issue is the one notification, and an ordinary push posts no comment;
//   - #3213's real backlog fits the description, and near GitHub's 65536 character
//     limit the list says how many pushes it leaves out rather than cutting silently;
//   - duplicates still settle on the lowest numbered issue, carrying their pushes;
//   - the decision cannot reach GitHub or git: it is driven through a fake.
//
// Run: node --experimental-strip-types scripts/test-loadtest-due-nag.ts
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { parseWorkflowTriggers } from "./lib/scan-workflow-jobs.ts";
import { LOADTEST_DUE_PATHS, isLoadtestDuePath } from "./lib/loadtest-due-paths.ts";
import {
  ISSUE_BODY_LIMIT,
  LIST_MARKER,
  LOADTEST_DUE_TITLE,
  anchorOf,
  bodyWithList,
  gitPathspecs,
  issueNumberFromUrl,
  issuesTitledFromListing,
  openingBody,
  openingTextOf,
  runNag,
  shasNamedIn,
  type NagClient,
  type Push,
} from "./lib/loadtest-due-nag.ts";

const ROOT = join(import.meta.dirname, "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");
const REPO = "Try-Pennie/slate";

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
  "loadtest-due.yml":
    "runs one at a time so two runs never write the issue description over each other (#4286), and a pending run a newer push cancels loses nothing: every run rebuilds the whole list from main as it stands when the run starts, and the last push of a burst is never the one cancelled",
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
eq(concurrencyGroups(nagWorkflow), ["loadtest-due"], "the nag runs under one constant group, so its body writes are serialised");
assert(/cancel-in-progress:\s*false/.test(nagWorkflow), "and a running nag is never cancelled mid write");
assert(/fetch-depth:\s*0/.test(nagWorkflow), "the nag's checkout carries main's whole history, which the list is derived from");

// The decision is pure, so no test of it can reach GitHub or git (a test once posted
// to the live repository, #4142).
const nagLib = readFileSync(join(ROOT, "scripts", "lib", "loadtest-due-nag.ts"), "utf8");
assert(!/node:child_process/.test(nagLib), "the decision imports no way to run gh or git");
assert(!/\bimport\s*\(/.test(nagLib), "and loads nothing at run time");
const nagCli = readFileSync(join(ROOT, "scripts", "loadtest-due-nag.ts"), "utf8");
assert(/"fetch"/.test(nagCli) && /origin\/main/.test(nagCli), "the command reads main as it stands when the run starts, not only its own push");
assert(/gitPathspecs\(LOADTEST_DUE_PATHS\)/.test(nagCli), "the command lists pushes by the one path list, not a copy");

// --- the decision, through a fake GitHub and a fake main ---------------------------

/** A 40 character sha, stable per name. */
const sha = (name: string) => createHash("sha1").update(name).digest("hex");

type Issue = { number: number; title: string; open: boolean; body: string; comments: string[] };
type Commit = { sha: string; touches: boolean };

function fakeGitHub(seed: Issue[] = [], history: Commit[] = []) {
  const issues = seed.map((i) => ({ ...i, comments: [...i.comments] }));
  const main = [...history];
  let next = Math.max(100, ...issues.map((i) => i.number)) + 1;
  const hooks: { beforeList?: () => void; beforeCreate?: () => void } = {};
  const calls = { create: 0, comment: 0, setBody: 0 };
  const find = (n: number) => {
    const i = issues.find((x) => x.number === n);
    if (!i) throw new Error(`no issue #${n}`);
    return i;
  };
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
      calls.create++;
      const number = next++;
      issues.push({ number, title, body, open: true, comments: [] });
      return number;
    },
    comment(n, body) {
      calls.comment++;
      find(n).comments.push(body);
    },
    close(n) {
      find(n).open = false;
    },
    bodyOf(n) {
      return find(n).body;
    },
    setBody(n, body) {
      calls.setBody++;
      find(n).body = body;
    },
    textOf(n) {
      const i = find(n);
      return [i.body, ...i.comments];
    },
    pushesSince(anchor) {
      const at = main.findIndex((c) => c.sha === anchor);
      if (at < 0) throw new Error(`${anchor} is not on main`);
      return main.slice(at + 1).filter((c) => c.touches).map((c) => c.sha);
    },
  };
  /** A push landing on main; its nag run is a separate step, which a burst may drop. */
  const land = (s: string, touches = true) => main.push({ sha: s, touches });
  return { client, issues, hooks, calls, land };
}

const push = (s: string, before = sha(`${s}-before`)): Push => ({ repo: REPO, sha: s, before });
const openOnes = (issues: Issue[]) => issues.filter((i) => i.open && i.title === LOADTEST_DUE_TITLE);
/** Where a push is named: an issue body or a comment that carries its sha. */
const namedIn = (issues: Issue[], s: string) =>
  issues.filter((i) => i.body.includes(s) || i.comments.some((c) => c.includes(s))).map((i) => i.number);

{
  // Nothing open: it opens one, the one notification the rule makes, and comments
  // nowhere.
  const A = sha("a");
  const gh = fakeGitHub([], [{ sha: A, touches: true }]);
  const out = runNag(gh.client, push(A));
  eq(openOnes(gh.issues).length, 1, "with nothing open, one issue is opened");
  eq(gh.calls.create, 1, "opening it is the notification");
  eq(out.opened, out.kept, "the opened issue is the one kept");
  assert(gh.issues[0].body.includes(`Push: ${A}`), "the opening body names the push");
  eq(anchorOf(gh.issues[0].body), A, "and anchors the list on it");
  eq(gh.calls.comment, 0, "and no comment repeats it");
}
{
  // Open with an ordinary push: the push goes into the description and nothing is
  // posted, so nobody is notified.
  const anchor = sha("anchor");
  const B = sha("b");
  const gh = fakeGitHub(
    [{ number: 3213, title: LOADTEST_DUE_TITLE, open: true, body: openingBody(push(anchor)), comments: [] }],
    [{ sha: anchor, touches: true }],
  );
  gh.land(B);
  const out = runNag(gh.client, push(B));
  eq(out, { kept: 3213, opened: null, closed: [] }, "an open issue is kept, nothing opened");
  eq(gh.calls.comment, 0, "an ordinary push posts no comment");
  eq(gh.calls.create, 0, "and opens nothing");
  eq(shasNamedIn([gh.issues[0].body]), [anchor, B], "the push is listed in the description after the opening push");
  assert(gh.issues[0].body.startsWith(openingBody(push(anchor)).trimEnd()), "the opening text is kept as it was");
}
{
  // A burst of three merges. GitHub keeps one running and one pending run per group,
  // so the third arrival cancels the second's pending run and push B's run never
  // happens. The last run reads main as it stands and lists B anyway.
  const anchor = sha("burst-anchor");
  const [A, B, C] = [sha("burst-a"), sha("burst-b"), sha("burst-c")];
  const gh = fakeGitHub(
    [{ number: 3213, title: LOADTEST_DUE_TITLE, open: true, body: openingBody(push(anchor)), comments: [] }],
    [{ sha: anchor, touches: true }],
  );
  gh.land(A);
  runNag(gh.client, push(A));
  eq(shasNamedIn([gh.issues[0].body]), [anchor, A], "the running run lists the push it was started by");
  gh.land(B);
  gh.land(C);
  // B's pending run is cancelled by C's arrival: nothing runs for B.
  runNag(gh.client, push(C));
  eq(shasNamedIn([gh.issues[0].body]), [anchor, A, B, C], "after the burst all three pushes are listed, the dropped middle one included");
  eq(gh.calls.comment, 0, "and the burst posted no comment");
}
{
  // A run that starts after newer pushes have already landed lists them too, and the
  // newer runs then find nothing to change.
  const anchor = sha("late-anchor");
  const [A, B] = [sha("late-a"), sha("late-b")];
  const gh = fakeGitHub(
    [{ number: 3213, title: LOADTEST_DUE_TITLE, open: true, body: openingBody(push(anchor)), comments: [] }],
    [{ sha: anchor, touches: true }],
  );
  gh.land(A);
  gh.land(B);
  runNag(gh.client, push(A));
  eq(shasNamedIn([gh.issues[0].body]), [anchor, A, B], "a run lists every push on main when it starts, not only its own");
  runNag(gh.client, push(B));
  eq(gh.calls.setBody, 1, "and an unchanged list is not written again");
}
{
  // A commit on main outside the paths is not listed: the paths filter decides what
  // starts a run, and the same list decides what the run records.
  const anchor = sha("p-anchor");
  const gh = fakeGitHub(
    [{ number: 3213, title: LOADTEST_DUE_TITLE, open: true, body: openingBody(push(anchor)), comments: [] }],
    [{ sha: anchor, touches: true }],
  );
  gh.land(sha("docs-only"), false);
  gh.land(sha("p-b"));
  runNag(gh.client, push(sha("p-b")));
  eq(shasNamedIn([gh.issues[0].body]), [anchor, sha("p-b")], "only pushes touching the paths are listed");
}
{
  // An issue with another title is not the one.
  const C = sha("c");
  const gh = fakeGitHub([{ number: 50, title: `${LOADTEST_DUE_TITLE} (old)`, open: true, body: "", comments: [] }], [{ sha: C, touches: true }]);
  const out = runNag(gh.client, push(C));
  assert(out.opened !== null && out.kept !== 50, "only the exact title counts as the open issue");
}
{
  // An open issue whose body names no opening push cannot be rebuilt: the run fails
  // rather than guessing where the list starts, and writes nothing.
  const gh = fakeGitHub([{ number: 3213, title: LOADTEST_DUE_TITLE, open: true, body: "opened by hand", comments: [] }], [{ sha: sha("h"), touches: true }]);
  let threw = false;
  try {
    runNag(gh.client, push(sha("h")));
  } catch {
    threw = true;
  }
  assert(threw, "an issue with no opening push fails the run");
  eq(gh.issues[0].body, "opened by hand", "and its description is left alone");
  eq(gh.calls.comment, 0, "and nothing is posted");
}
{
  // An opening push that is no longer on main (history rewritten) fails loudly rather
  // than writing a shorter list.
  const anchor = sha("gone");
  const body = bodyWithList(openingBody(push(anchor)), [sha("x1")], REPO);
  const gh = fakeGitHub([{ number: 3213, title: LOADTEST_DUE_TITLE, open: true, body, comments: [] }], [{ sha: sha("x1"), touches: true }]);
  let threw = false;
  try {
    runNag(gh.client, push(sha("x1")));
  } catch {
    threw = true;
  }
  assert(threw, "an opening push missing from main fails the run");
  eq(gh.issues[0].body, body, "and the list already recorded is left as it was");
}

// --- #3213 as it stands, and the limit on a description ----------------------------

// #3213's description on 2026-10-27, written by the old nag with no list under it.
const ISSUE_3213_BODY =
  "A push to main changed the booking confirm path or a cron lane, so the booking path load run's last recorded figures no longer describe what is deployed.\n\nPush: d17f6524d4afc306b8ece8097308e77e851b1493 (https://github.com/Try-Pennie/slate/compare/071c6e4a88b9d7e62f783c23e456e576f09fb73d...d17f6524d4afc306b8ece8097308e77e851b1493)\n\nDispatch `loadtest.yml` on main against a fresh throwaway branch, following scripts/loadtest/RUNBOOK.md, and record the run id and its figures in the runbook's run record. Close this issue from that PR.\n\nOpened by .github/workflows/loadtest-due.yml (#3103).\n";
eq(anchorOf(ISSUE_3213_BODY), "d17f6524d4afc306b8ece8097308e77e851b1493", "the opening push is read from #3213's real description");
eq(openingTextOf(ISSUE_3213_BODY), ISSUE_3213_BODY.trimEnd(), "a description with no list yet is all opening text");
{
  // The backlog on 2026-10-27: 234 pushes after the opening one (227 commented on
  // #3213, 5 on the closed #4089, 2 whose runs were cancelled in a burst).
  const backlog = Array.from({ length: 234 }, (_, i) => sha(`backlog-${i}`));
  const body = bodyWithList(ISSUE_3213_BODY, backlog, REPO);
  assert(body.length <= ISSUE_BODY_LIMIT, `#3213's backlog fits the description (${body.length} of ${ISSUE_BODY_LIMIT} characters)`);
  eq(shasNamedIn([body]), ["d17f6524d4afc306b8ece8097308e77e851b1493", ...backlog], "every push is listed, in order");
  assert(!/left out/.test(body), "and none is summarised");
  eq(openingTextOf(body), ISSUE_3213_BODY.trimEnd(), "the opening text reads back unchanged once a list is under it");
  assert(body.includes(LIST_MARKER), "the list sits under a marker saying it is rebuilt");
  const list = body.slice(body.indexOf(LIST_MARKER));
  assert(!/(^|\s)#\d+/.test(list), "the list names no issue or pull request, so writing it notifies nobody");
  assert(!/@\w/.test(list), "and mentions nobody");
  eq(bodyWithList(openingTextOf(body), backlog, REPO), body, "rebuilding from its own output gives the same description");
}
{
  // Near the limit: the list keeps the newest pushes and says, in the list, how many
  // older ones it leaves out and how to list them. It never cuts silently.
  const many = Array.from({ length: 3000 }, (_, i) => sha(`many-${i}`));
  const body = bodyWithList(ISSUE_3213_BODY, many, REPO);
  assert(body.length <= ISSUE_BODY_LIMIT, `a 3000 push list stays within the limit (${body.length} characters)`);
  const listed = shasNamedIn([body.slice(body.indexOf(LIST_MARKER))]);
  assert(listed.includes(many[many.length - 1]), "the newest push is listed");
  const m = /(\d+) older pushes, from ([0-9a-f]{40}) to ([0-9a-f]{40}), are left out/.exec(body);
  assert(m !== null, "the list says how many pushes it leaves out");
  if (m) {
    const left = Number(m[1]);
    eq(left + listed.length, many.length, "the pushes listed and the pushes left out add up to every push");
    eq([m[2], m[3]], [many[0], many[left - 1]], "and it names the first and last left out");
    eq(listed, many.slice(left), "the listed ones are the newest, in order");
  }
  assert(/git log --oneline [0-9a-f]{40}\^\.\.[0-9a-f]{40} -- /.test(body), "and gives the command that lists the ones left out");
  assert(body.includes(`(${many.length}, oldest first)`), "the heading counts every push, not only the listed ones");
}
{
  // An opening text that alone overflows the description cannot be fixed by
  // summarising, so it fails rather than writing a body GitHub refuses.
  let threw = false;
  try {
    bodyWithList("x".repeat(ISSUE_BODY_LIMIT), [sha("one")], REPO);
  } catch {
    threw = true;
  }
  assert(threw, "an opening text over the limit fails loudly");
}
eq(bodyWithList("opening", [], REPO), `opening\n\n${LIST_MARKER}`, "with no pushes yet, the description is the opening text and the marker");

// --- duplicates still settle on one issue ---------------------------------------

{
  // The state on 2026-10-22: #3213 open and #4089 opened beside it. The next push
  // records itself on #3213 and closes #4089, saying so on both.
  const anchor = sha("dup-anchor");
  const [d1, d2, onlyThere] = [sha("57fae5e0"), sha("c0464eda"), sha("off-main")];
  const oldComment = (s: string) =>
    `Another push changed the confirm path or a cron lane: ${s} (https://github.com/${REPO}/compare/${d1}...${s}). The next run covers it too.`;
  const gh = fakeGitHub(
    [
      { number: 3213, title: LOADTEST_DUE_TITLE, open: true, body: openingBody(push(anchor)), comments: [] },
      { number: 4089, title: LOADTEST_DUE_TITLE, open: true, body: openingBody(push(d1)), comments: [oldComment(d2), oldComment(onlyThere)] },
    ],
    [{ sha: anchor, touches: true }],
  );
  gh.land(d1);
  gh.land(d2);
  gh.land(sha("ddd444"));
  const out = runNag(gh.client, push(sha("ddd444")));
  eq(out, { kept: 3213, opened: null, closed: [4089] }, "the lowest is kept and the duplicate closed");
  eq(openOnes(gh.issues).map((i) => i.number), [3213], "one issue is left open");
  assert(gh.issues[1].comments.some((c) => c.includes("#3213")), "the duplicate says where the rule went");
  assert(gh.issues[0].comments.some((c) => c.includes("#4089")), "the kept issue points at the closed duplicate");
  for (const s of [d1, d2, sha("ddd444")]) {
    assert(gh.issues[0].body.includes(s), `push ${s.slice(0, 8)} is in the kept issue's list`);
  }
  // A push the duplicate named that main's history cannot show is carried in the note,
  // because the runbook closes the kept issue only once a run covers every push on it.
  const note = gh.issues[0].comments.find((c) => c.includes("#4089")) ?? "";
  eq(shasNamedIn([note]), [onlyThere], "only the push the list lacks is carried in the note");
}
{
  // Two runs racing (a duplicate can still be opened by hand or by a reopen). Run B
  // lists in the same instant as run A, so both see nothing open and both open one.
  const [A, B] = [sha("race-a"), sha("race-b")];
  const gh = fakeGitHub([], [{ sha: A, touches: true }, { sha: B, touches: true }]);
  gh.hooks.beforeList = () => runNag(gh.client, push(B));
  runNag(gh.client, push(A));
  eq(openOnes(gh.issues).length, 1, "two racing runs leave one issue open");
  const kept = openOnes(gh.issues)[0].number;
  for (const s of [A, B]) {
    assert(namedIn(gh.issues, s).includes(kept), `push ${s.slice(0, 8)} is listed on the kept issue`);
  }
}
{
  // The other interleaving: run D opens its issue between run C's listing and run C's
  // opening, so C's re-read sees both.
  const [C, D] = [sha("race-c"), sha("race-d")];
  const gh = fakeGitHub([], [{ sha: C, touches: true }, { sha: D, touches: true }]);
  gh.hooks.beforeCreate = () => runNag(gh.client, push(D));
  runNag(gh.client, push(C));
  eq(openOnes(gh.issues).length, 1, "the other interleaving also leaves one issue open");
  const kept = openOnes(gh.issues)[0].number;
  for (const s of [C, D]) {
    assert(namedIn(gh.issues, s).includes(kept), `push ${s.slice(0, 8)} is listed on the kept issue`);
  }
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
    runNag(broken, push(sha("e")));
  } catch {
    threw = true;
  }
  assert(threw, "a failed listing fails the run");
  eq(gh.issues.length, 0, "and opens nothing");
}

// --- reading what gh and git are given and print ---------------------------------
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
eq(
  shasNamedIn([
    openingBody(push(sha("57fae5e0"))),
    `Another push changed the confirm path or a cron lane: ${sha("c0464eda")} (https://github.com/${REPO}/compare/a...${sha("c0464eda")}). The next run covers it too.`,
    `a person's note mentioning ${sha("someone")}`,
  ]),
  [sha("57fae5e0"), sha("c0464eda")],
  "pushes are read back from what the nag wrote, the old comments included, and from nothing else",
);
eq(issueNumberFromUrl("https://github.com/Try-Pennie/slate/issues/4089\n"), 4089, "the opened number is read from the URL");
eq(issueNumberFromUrl("could not create issue"), null, "and nothing is read from anything else");
{
  // git reads a pathspec as a prefix for a directory and exactly for a file, which is
  // what `isLoadtestDuePath` means by `dir/**` and a bare file.
  const specs = gitPathspecs(LOADTEST_DUE_PATHS);
  eq(specs.length, LOADTEST_DUE_PATHS.length, "one pathspec per entry");
  for (const [i, p] of LOADTEST_DUE_PATHS.entries()) {
    const s = specs[i];
    assert(!s.includes("*"), `"${s}" carries no glob for git to read differently`);
    const probe = p.endsWith("/**") ? `${s}x/y.ts` : s;
    assert(isLoadtestDuePath(probe) && probe.startsWith(s), `"${s}" covers what "${p}" covers`);
  }
}

finish();

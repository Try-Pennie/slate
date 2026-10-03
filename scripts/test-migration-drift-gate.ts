// #3051: whether the CI migration drift check runs, skips, or refuses.
// Run: node --experimental-strip-types scripts/test-migration-drift-gate.ts
import {
  changedFilesFromMergeCommit,
  decideMigrationDriftGate,
  type DriftGateInput,
} from "./lib/migration-drift-gate.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const DEPENDABOT: DriftGateInput = {
  eventName: "pull_request",
  headRef: "dependabot/npm_and_yarn/minor-and-patch-8a958f80f9",
  actor: "dependabot[bot]",
  changedFiles: ["package.json", "pnpm-lock.yaml"],
  secretsPresent: false,
};

// --- the skip, and only with every half present -----------------------------
{
  const d = decideMigrationDriftGate(DEPENDABOT);
  eq(d.action, "skip", "a Dependabot PR touching no migration, with no secrets, skips");
  assert(/none under supabase\/migrations\//.test(d.reason), "the skip says WHY (no migration in the diff)");
  assert(/2 files/.test(d.reason), "the skip says how many files it looked at, so a zero cannot hide");
}

// --- a Dependabot PR that touches a migration still fails --------------------
{
  const d = decideMigrationDriftGate({
    ...DEPENDABOT,
    changedFiles: ["package.json", "supabase/migrations/0200_x.sql"],
  });
  eq(d.action, "refuse", "a Dependabot PR that changes a migration refuses, as without #3051");
  assert(/0200_x\.sql/.test(d.reason), "the refusal names the migration");
  eq(
    decideMigrationDriftGate({ ...DEPENDABOT, changedFiles: ["./supabase/migrations/0200_x.sql"] }).action,
    "refuse",
    "a ./ prefixed migration path is still a migration",
  );
}
// A neighbour that only LOOKS like the directory is not a migration.
eq(
  decideMigrationDriftGate({ ...DEPENDABOT, changedFiles: ["supabase/migrations.md", "docs/supabase/migrations/x"] }).action,
  "skip",
  "a path that merely mentions supabase/migrations is not one",
);

// --- fail closed when the diff is unknown ------------------------------------
eq(decideMigrationDriftGate({ ...DEPENDABOT, changedFiles: null }).action, "refuse", "an unreadable diff refuses, never skips");
eq(decideMigrationDriftGate({ ...DEPENDABOT, changedFiles: [] }).action, "refuse", "an EMPTY diff refuses (a PR always changes something)");
eq(decideMigrationDriftGate({ ...DEPENDABOT, changedFiles: ["", "  "] }).action, "refuse", "a diff of blank lines is an empty diff");

// --- the branch NAME alone earns nothing -------------------------------------
{
  const d = decideMigrationDriftGate({ ...DEPENDABOT, actor: "some-human" });
  eq(d.action, "refuse", "a human pushing a branch named dependabot/* with no secrets still refuses");
  assert(/some-human/.test(d.reason) && /#766/.test(d.reason), "the refusal says the actor is not Dependabot, and keeps the #766 reason");
}
eq(
  decideMigrationDriftGate({ ...DEPENDABOT, headRef: "fix/thing" }).action,
  "refuse",
  "the Dependabot actor on a non dependabot/* branch does not skip",
);
eq(
  decideMigrationDriftGate({ ...DEPENDABOT, eventName: "push", headRef: "" }).action,
  "refuse",
  "a push run (head ref empty) never skips",
);
eq(
  decideMigrationDriftGate({ ...DEPENDABOT, eventName: "push" }).action,
  "refuse",
  "only a pull_request event can skip",
);

// --- #766 unchanged on every other branch ------------------------------------
{
  const d = decideMigrationDriftGate({
    eventName: "pull_request",
    headRef: "fix/3051-something",
    actor: "dwright-pennie",
    changedFiles: ["src/a.ts"],
    secretsPresent: false,
  });
  eq(d.action, "refuse", "#766: a normal branch with missing secrets still fails loud");
  assert(/SUPABASE_ACCESS_TOKEN/.test(d.reason), "the #766 refusal names the missing secrets");
}
eq(
  decideMigrationDriftGate({ eventName: "push", headRef: "", actor: "dwright-pennie", changedFiles: null, secretsPresent: false }).action,
  "refuse",
  "#766: a push to main with missing secrets still fails loud",
);

// --- secrets present always runs the real check ------------------------------
eq(decideMigrationDriftGate({ ...DEPENDABOT, secretsPresent: true }).action, "run", "a Dependabot PR that HAS the secrets runs the real check");
eq(
  decideMigrationDriftGate({ ...DEPENDABOT, secretsPresent: true, changedFiles: ["supabase/migrations/0200_x.sql"] }).action,
  "run",
  "with secrets, a migration change runs the real check",
);
eq(
  decideMigrationDriftGate({ eventName: "push", headRef: "", actor: "dwright-pennie", changedFiles: null, secretsPresent: true }).action,
  "run",
  "a push to main with secrets runs the real check",
);

// --- reading the changed files from the merge commit -------------------------
function fakeGit(parents: string, diff: string, calls: string[][] = []): (args: string[]) => string {
  return (args) => {
    calls.push(args);
    if (args[0] === "rev-list") return parents;
    if (args[0] === "diff") return diff;
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}
{
  const calls: string[][] = [];
  const files = changedFilesFromMergeCommit(fakeGit("m p1 p2\n", "package.json\0pnpm-lock.yaml\0", calls));
  eq(files, ["package.json", "pnpm-lock.yaml"], "a two parent merge yields the diff against its first parent");
  eq(calls[1], ["diff", "--name-only", "--no-renames", "-z", "HEAD^1", "HEAD"], "the diff is taken against the merge's first parent (the base), renames off, NUL separated");
}
// git quotes a path holding a non ASCII character (core.quotePath) unless -z is
// given, and a quoted path no longer starts with supabase/migrations/. With -z the
// name arrives raw, so it is still seen as a migration.
{
  const out = changedFilesFromMergeCommit((args) =>
    args[0] === "rev-list"
      ? "m p1 p2\n"
      : args.includes("-z")
        ? "supabase/migrations/0200_caf\u00e9.sql\0"
        : '"supabase/migrations/0200_caf\\303\\251.sql"\n',
  );
  eq(
    decideMigrationDriftGate({ ...DEPENDABOT, changedFiles: out }).action,
    "refuse",
    "a migration whose name holds a non ASCII character is still seen (the diff is read NUL separated, never quoted)",
  );
}
// A rename, modelled the way git reports it: with rename detection on only the
// NEW path is listed; with --no-renames both the deleted and the added path are.
function renamingGit(from: string, to: string): (args: string[]) => string {
  return (args) => {
    if (args[0] === "rev-list") return "m p1 p2\n";
    if (args[0] === "diff") return args.includes("--no-renames") ? `${from}\0${to}\0` : `${to}\0`;
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}
{
  const out = changedFilesFromMergeCommit(renamingGit("supabase/migrations/0200_x.sql", "archive/0200_x.sql"));
  eq(
    decideMigrationDriftGate({ ...DEPENDABOT, changedFiles: out }).action,
    "refuse",
    "a Dependabot PR that MOVES a migration out of supabase/migrations/ refuses (the old path is listed)",
  );
}
{
  const out = changedFilesFromMergeCommit(renamingGit("archive/0200_x.sql", "supabase/migrations/0200_x.sql"));
  eq(
    decideMigrationDriftGate({ ...DEPENDABOT, changedFiles: out }).action,
    "refuse",
    "a Dependabot PR that moves a file INTO supabase/migrations/ refuses",
  );
}
eq(changedFilesFromMergeCommit(fakeGit("m p1\n", "package.json\n")), null, "a single parent HEAD (not the PR merge commit) is unknown, not a diff");
eq(changedFilesFromMergeCommit(fakeGit("m\n", "")), null, "a shallow clone with no parent is unknown");
eq(
  changedFilesFromMergeCommit(() => {
    throw new Error("fatal: bad revision 'HEAD^1'");
  }),
  null,
  "a git failure is unknown, never an empty list",
);
// End to end through both halves: an unreadable merge never skips.
eq(
  decideMigrationDriftGate({ ...DEPENDABOT, changedFiles: changedFilesFromMergeCommit(fakeGit("m p1\n", "package.json\n")) }).action,
  "refuse",
  "a Dependabot PR whose merge commit cannot be read refuses",
);

finish();

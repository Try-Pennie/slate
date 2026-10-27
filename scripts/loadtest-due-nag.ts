// Run by `.github/workflows/loadtest-due.yml` on bare node: records this push on the
// one open "load run due" issue by rebuilding the list in its description, opening the
// issue if there is none (#3103, #3553, #4286). The decision is `runNag` in
// scripts/lib/loadtest-due-nag.ts, driven offline by scripts/test-loadtest-due-nag.ts;
// this file only connects it to `gh` and `git`.
//
// Imports nothing outside scripts/ (scripts/test-dependency-free-scripts.ts).
//
// Env: REPO, SHA, BEFORE (the push), GH_TOKEN (issues: write). Needs a checkout holding
// main's whole history (the workflow checks out with fetch-depth 0).
// Run: node --experimental-strip-types scripts/loadtest-due-nag.ts
import { execFileSync } from "node:child_process";
import { LOADTEST_DUE_PATHS } from "./lib/loadtest-due-paths.ts";
import {
  gitPathspecs,
  issueNumberFromUrl,
  issuesTitledFromListing,
  runNag,
  type NagClient,
} from "./lib/loadtest-due-nag.ts";

// Open issues numbered about 530 on 2026-10-23; the listing refuses to answer once it
// reaches this many rows, rather than miss the issue and open a second.
const LISTING_LIMIT = 5000;

const repo = process.env.REPO ?? "";
const sha = process.env.SHA ?? "";
const before = process.env.BEFORE ?? "";
if (!repo || !sha || !before) {
  console.error(`loadtest-due-nag: REPO, SHA and BEFORE must all be set (REPO="${repo}", SHA="${sha}", BEFORE="${before}")`);
  process.exit(2);
}

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

const client: NagClient = {
  openIssuesTitled(title) {
    // A LISTING, never `--search`: the search index missed the open #3213 on
    // 2026-10-22 and a duplicate was opened beside it.
    const out = gh(["issue", "list", "-R", repo, "--state", "open", "--limit", String(LISTING_LIMIT), "--json", "number,title"]);
    return issuesTitledFromListing(out, title, LISTING_LIMIT);
  },
  create(title, body) {
    const out = gh([
      "issue", "create", "-R", repo, "--title", title, "--body", body,
      "--label", "load-chaos", "--label", "priority-p2", "--milestone", "Ungrouped",
    ]);
    const n = issueNumberFromUrl(out);
    if (n === null) throw new Error(`gh issue create printed no issue URL: ${out.trim()}`);
    return n;
  },
  bodyOf(issue) {
    // `--jq` prints a string followed by exactly one newline of its own; drop that one,
    // keeping any the description ends with.
    const out = gh(["api", `repos/${repo}/issues/${issue}`, "--jq", ".body // \"\""]);
    return out.endsWith("\n") ? out.slice(0, -1) : out;
  },
  setBody(issue, body) {
    // A PATCH to the description, which notifies nobody. The body goes in a field read
    // from stdin, so a long list never meets the limit on a command line.
    execFileSync("gh", ["api", "-X", "PATCH", `repos/${repo}/issues/${issue}`, "-F", "body=@-", "--silent"], {
      input: body,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "inherit"],
    });
  },
  // Only a closed duplicate is ever commented on (scripts/lib/loadtest-due-nag.ts).
  comment(issue, body) {
    gh(["issue", "comment", String(issue), "-R", repo, "--body", body]);
  },
  close(issue) {
    // A PATCH to closed is idempotent, so closing one already closed succeeds.
    gh(["api", "-X", "PATCH", `repos/${repo}/issues/${issue}`, "-f", "state=closed", "-f", "state_reason=not_planned", "--silent"]);
  },
  textOf(issue) {
    // Every comment, paginated: #3213 carried 228 comments on 2026-10-27, and a first
    // page alone would miss pushes listed after it.
    const body = gh(["api", `repos/${repo}/issues/${issue}`, "--jq", ".body // \"\""]);
    const comments = gh(["api", "--paginate", `repos/${repo}/issues/${issue}/comments?per_page=100`, "--jq", ".[].body"]);
    return [body, comments];
  },
  pushesSince(anchor) {
    // Main as it stands NOW, not as of this run's push: a burst's middle run is
    // cancelled while it waits, and this is how the run after it lists that push.
    git(["fetch", "--no-tags", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
    try {
      git(["merge-base", "--is-ancestor", anchor, "origin/main"]);
    } catch {
      throw new Error(`the opening push ${anchor} is not on main, so the list cannot be rebuilt from it`);
    }
    const out = git(["log", "--reverse", "--format=%H", `${anchor}..origin/main`, "--", ...gitPathspecs(LOADTEST_DUE_PATHS)]);
    return out.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  },
};

const out = runNag(client, { repo, sha, before });
console.log(
  `loadtest-due-nag: ${out.opened === out.kept ? "opened" : "rebuilt the list on"} #${out.kept}` +
    (out.closed.length > 0 ? `; closed duplicates ${out.closed.map((n) => `#${n}`).join(", ")}` : ""),
);

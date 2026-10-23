// Run by `.github/workflows/loadtest-due.yml` on bare node: names this push on the
// one open "load run due" issue, opening it if there is none (#3103, #3553). The
// decision is `runNag` in scripts/lib/loadtest-due-nag.ts, driven offline by
// scripts/test-loadtest-due-nag.ts; this file only connects it to `gh`.
//
// Imports nothing outside scripts/ (scripts/test-dependency-free-scripts.ts).
//
// Env: REPO, SHA, BEFORE (the push), GH_TOKEN (issues: write).
// Run: node --experimental-strip-types scripts/loadtest-due-nag.ts
import { execFileSync } from "node:child_process";
import {
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
  comment(issue, body) {
    gh(["issue", "comment", String(issue), "-R", repo, "--body", body]);
  },
  close(issue) {
    // A PATCH to closed is idempotent, so two racing runs closing the same duplicate
    // both succeed.
    gh(["api", "-X", "PATCH", `repos/${repo}/issues/${issue}`, "-f", "state=closed", "-f", "state_reason=not_planned", "--silent"]);
  },
};

const out = runNag(client, { repo, sha, before });
console.log(
  `loadtest-due-nag: ${out.opened === out.kept ? "opened" : "named the push on"} #${out.kept}` +
    (out.closed.length > 0 ? `; closed duplicates ${out.closed.map((n) => `#${n}`).join(", ")}` : ""),
);

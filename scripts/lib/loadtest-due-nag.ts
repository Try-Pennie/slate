// The decision behind `.github/workflows/loadtest-due.yml` (#3103, #3553, #4286): a
// push to main that changes the confirm path or a cron lane is recorded on ONE open
// "load run due" issue, which is opened if there is none.
//
// Pure over an injected client, so `scripts/test-loadtest-due-nag.ts` drives every
// path with no network and no git. Imports nothing outside scripts/lib: the workflow
// runs it on bare node.
//
// Opening the issue is the only notification (#4286). After that, each push is recorded
// in the issue DESCRIPTION, which notifies nobody; it used to be a comment per push, and
// #3213 collected 227 of them. Two runs editing one description at once would each
// overwrite the other's push, so the workflow runs one at a time under a constant
// concurrency group. GitHub keeps one running and ONE pending run per group and a third
// arrival cancels the pending one (L1020), so a run never appends just its own push:
// it REBUILDS the whole list from every commit on main since the issue's opening push
// that touches `LOADTEST_DUE_PATHS`, reading main as it stands when the run starts. The
// last push of a burst is the one GitHub keeps, so its run lists the middle push whose
// run was cancelled.
//
// Two open issues can still happen (one reopened, or opened by hand with this title),
// so the lowest numbered one is kept and the others are closed onto it, carrying any
// push they named that the kept list does not show. Before #4286 that also settled two
// runs racing to open the issue, and before #3553 a lookup through GitHub's SEARCH
// index, which missed the open #3213 and opened #4089 beside it; the lookup lists open
// issues instead of searching.
import { LOADTEST_DUE_PATHS } from "./loadtest-due-paths.ts";

export const LOADTEST_DUE_TITLE = "Load run due: the confirm path or a cron lane changed";

/** GitHub refuses an issue body longer than this many characters. */
export const ISSUE_BODY_LIMIT = 65536;
/**
 * What the description is held to: the limit, less room for an opening text a person
 * edited with characters GitHub may count differently from a JavaScript string.
 */
const BODY_BUDGET = ISSUE_BODY_LIMIT - 1024;

/** Separates the opening text, which is kept as written, from the list rebuilt under it. */
export const LIST_MARKER =
  "<!-- loadtest-due: everything below this line is rebuilt from main by .github/workflows/loadtest-due.yml on every qualifying push. Edit above it. -->";

export type Push = { repo: string; sha: string; before: string };

export interface NagClient {
  /** Every OPEN issue whose title is exactly `title`. Throws when it cannot say. */
  openIssuesTitled(title: string): number[];
  /** Opens an issue and returns its number. */
  create(title: string, body: string): number;
  /** An issue's description. Throws when it cannot say. */
  bodyOf(issue: number): string;
  /** Replaces an issue's description, which notifies nobody. */
  setBody(issue: number, body: string): void;
  comment(issue: number, body: string): void;
  /** Closes an issue; closing one already closed is not an error. */
  close(issue: number): void;
  /** An issue's body and then EVERY comment on it. Throws when it cannot say. */
  textOf(issue: number): string[];
  /**
   * Every commit on main after `anchor` that touches `LOADTEST_DUE_PATHS`, oldest first,
   * read from main as it stands now rather than as of this run's push. Throws when
   * `anchor` is not on main.
   */
  pushesSince(anchor: string): string[];
}

export type NagOutcome = {
  /** The one issue left open for the rule. */
  kept: number;
  /** The issue this run opened, if it opened one. */
  opened: number | null;
  /** Duplicates this run closed. */
  closed: number[];
};

export function pushLink(p: Push): string {
  return `https://github.com/${p.repo}/compare/${p.before}...${p.sha}`;
}

export function openingBody(p: Push): string {
  return [
    "A push to main changed the booking confirm path or a cron lane, so the booking path load run's last recorded figures no longer describe what is deployed.",
    "",
    `Push: ${p.sha} (${pushLink(p)})`,
    "",
    "Dispatch `loadtest.yml` on main against a fresh throwaway branch, following scripts/loadtest/RUNBOOK.md, and record the run id and its figures in the runbook's run record. Close this issue from that PR.",
    "",
    "Opened by .github/workflows/loadtest-due.yml (#3103).",
  ].join("\n");
}

/** One push in the list: the short sha, linked to the commit. */
function pushLine(repo: string, sha: string): string {
  return `- [${sha.slice(0, 8)}](https://github.com/${repo}/commit/${sha})`;
}

/** `LOADTEST_DUE_PATHS` as git pathspecs: a `dir/**` entry becomes the `dir/` prefix. */
export function gitPathspecs(paths: readonly string[]): string[] {
  return paths.map((p) => (p.endsWith("/**") ? p.slice(0, -2) : p));
}

/** The text above the list: the whole description when it carries no list yet. */
export function openingTextOf(body: string): string {
  const at = body.indexOf(LIST_MARKER);
  return (at < 0 ? body : body.slice(0, at)).trimEnd();
}

/** The opening push an issue's list starts after, from its `Push:` line, or null. */
export function anchorOf(body: string): string | null {
  return /^Push: ([0-9a-f]{40})\b/m.exec(openingTextOf(body))?.[1] ?? null;
}

/**
 * The description: `opening`, then every push in `since`, oldest first. Past the
 * budget the OLDEST pushes are left out, and the list says how many, which ones and the
 * command that lists them, so nothing is ever cut silently. The newest are the ones a
 * load run is least likely to cover yet. Throws when even the opening text does not fit.
 */
export function bodyWithList(opening: string, since: string[], repo: string): string {
  const head = `${opening.trimEnd()}\n\n${LIST_MARKER}`;
  if (since.length === 0) return head;
  const heading = `Pushes since the opening push that changed the confirm path or a cron lane (${since.length}, oldest first):`;
  const lines = since.map((s) => pushLine(repo, s));
  const compose = (summary: string | null, kept: string[]) =>
    [head, heading, "", ...(summary === null ? [] : [summary]), ...kept].join("\n");

  const whole = compose(null, lines);
  if (whole.length <= BODY_BUDGET) return whole;

  const summaryFor = (left: number) => {
    const first = since[0];
    const last = since[left - 1];
    return (
      `- ${left} older pushes, from ${first} to ${last}, are left out to keep this description under GitHub's ${ISSUE_BODY_LIMIT} character limit. ` +
      `\`git log --oneline ${first}^..${last} -- ${gitPathspecs(LOADTEST_DUE_PATHS).join(" ")}\` lists them.`
    );
  };
  // The summary is longest when it counts every push, so size the kept lines against
  // that, then write the real count.
  let room = BODY_BUDGET - compose(summaryFor(since.length), []).length;
  let keep = 0;
  while (keep < lines.length && room >= lines[lines.length - 1 - keep].length + 1) {
    room -= lines[lines.length - 1 - keep].length + 1;
    keep++;
  }
  const left = since.length - keep;
  const body = compose(summaryFor(left), lines.slice(left));
  if (body.length > BODY_BUDGET) {
    throw new Error(`the issue description would be ${body.length} characters, over the ${BODY_BUDGET} it is held to, even with ${left} pushes left out`);
  }
  return body;
}

/**
 * Every push the nag has recorded in these texts, as full shas, in order and once
 * each: the opening `Push:` line, a line of the list, and the comment the nag posted
 * per push before #4286. Reads only those shapes, so a sha in a person's note, or in
 * the line counting pushes left out, is never mistaken for a listed push.
 */
export function shasNamedIn(texts: string[]): string[] {
  const out: string[] = [];
  const shape =
    /^Push: ([0-9a-f]{40})\b|^- \[[0-9a-f]{7,12}\]\(https:\/\/github\.com\/[^\s)]+\/commit\/([0-9a-f]{40})\)|Another push changed the confirm path or a cron lane: ([0-9a-f]{40}) \(https:\/\/github\.com\/[^\s)]+\/compare\/[^\s)]+\)/gm;
  for (const text of texts) {
    for (const m of text.matchAll(shape)) {
      const sha = m[1] ?? m[2] ?? m[3];
      if (!out.includes(sha)) out.push(sha);
    }
  }
  return out;
}

export function duplicateClosingComment(kept: number): string {
  return `Closed as a duplicate of #${kept}, which tracks the same load run. The pushes named here are listed there too.`;
}

/**
 * The note on the kept issue for one closed duplicate. The runbook closes the kept
 * issue only once a run covers every push LISTED ON IT, so a push the duplicate named
 * that the kept list cannot show is listed here rather than left on a closed issue.
 */
export function duplicateNote(dup: number, carried: string[], repo: string): string {
  const head = `#${dup} tracked the same load run and is closed as a duplicate of this one.`;
  if (carried.length === 0) return `${head} Every push it named is already in the list above.`;
  return `${head} The pushes it named that the list above does not show, which the next run covers too:\n${carried.map((s) => pushLine(repo, s)).join("\n")}`;
}

/** Rewrites the kept issue's list from main; returns every push on it, opening one first. */
function rebuild(client: NagClient, issue: number, repo: string): string[] {
  const body = client.bodyOf(issue);
  const anchor = anchorOf(body);
  if (anchor === null) {
    throw new Error(`#${issue} has no "Push: <sha>" line naming its opening push, so its list cannot be rebuilt`);
  }
  const since = client.pushesSince(anchor);
  const next = bodyWithList(openingTextOf(body), since, repo);
  if (next !== body) client.setBody(issue, next);
  return [anchor, ...since];
}

export function runNag(client: NagClient, push: Push): NagOutcome {
  let open = client.openIssuesTitled(LOADTEST_DUE_TITLE);
  let opened: number | null = null;
  let openedListed: string[] = [];
  if (open.length === 0) {
    const since = client.pushesSince(push.sha);
    opened = client.create(LOADTEST_DUE_TITLE, bodyWithList(openingBody(push), since, push.repo));
    openedListed = [push.sha, ...since];
    // Read again AFTER opening: an issue opened in the same moment by anything else is
    // seen here, and both settle on the same lowest number. This run's own issue counts
    // even if the listing has not caught up with it yet.
    open = [...new Set([...client.openIssuesTitled(LOADTEST_DUE_TITLE), opened])];
  }
  const sorted = [...open].sort((a, b) => a - b);
  const kept = sorted[0];
  // The issue this run opened already lists everything; any other is rebuilt.
  const listed = kept === opened ? openedListed : rebuild(client, kept, push.repo);
  const closed = sorted.slice(1);
  for (const dup of closed) {
    // Each duplicate is read before it is touched, so a failed read leaves it open with
    // its pushes still listed on it.
    const carried = shasNamedIn(client.textOf(dup)).filter((s) => !listed.includes(s));
    client.comment(kept, duplicateNote(dup, carried, push.repo));
    listed.push(...carried);
    client.comment(dup, duplicateClosingComment(kept));
    client.close(dup);
  }
  return { kept, opened, closed };
}

/**
 * The open issues titled exactly `title`, from `gh issue list --json number,title`
 * output read with `limit`. Throws rather than answering from a listing that may be
 * cut short, because a missed issue is a duplicate opened beside it.
 */
export function issuesTitledFromListing(output: string, title: string, limit: number): number[] {
  const rows: unknown = JSON.parse(output);
  if (!Array.isArray(rows)) throw new Error("the issue listing was not a list");
  if (rows.length >= limit) {
    throw new Error(`the issue listing returned ${rows.length} rows, the limit it asked for, so it may be cut short`);
  }
  return rows
    .filter((r): r is { number: number; title: string } =>
      typeof r === "object" && r !== null && typeof (r as { number?: unknown }).number === "number",
    )
    .filter((r) => r.title === title)
    .map((r) => r.number);
}

/** The issue number at the end of the URL `gh issue create` prints, or null. */
export function issueNumberFromUrl(output: string): number | null {
  const m = /\/issues\/(\d+)\s*$/.exec(output.trim());
  return m ? Number(m[1]) : null;
}

// The decision behind `.github/workflows/loadtest-due.yml` (#3103, #3553): a push to
// main that changes the confirm path or a cron lane names itself on ONE open "load
// run due" issue, opening it if there is none.
//
// Pure over an injected client, so `scripts/test-loadtest-due-nag.ts` drives every
// path with no network. Imports nothing: the workflow runs it on bare node.
//
// Why it converges rather than relying on running one at a time (#3553, L1020): the
// workflow used to serialise every run under ONE constant concurrency group so two
// pushes could not each find no issue and open two. GitHub keeps one running and ONE
// pending run per group, and a third arrival cancels the pending one even with
// cancel-in-progress false, so in a burst of merges the middle push was never named.
// The group is now keyed on the push, every push runs, and two runs that race to open
// the issue settle on the lowest numbered one afterwards. Settling also repairs a
// duplicate the old lookup made on its own: it went through GitHub's SEARCH index,
// which on 2026-10-22 did not return the open #3213 for one run, and #4089 was
// opened beside it. The lookup now lists open issues instead of searching.

export const LOADTEST_DUE_TITLE = "Load run due: the confirm path or a cron lane changed";

export type Push = { repo: string; sha: string; before: string };

export interface NagClient {
  /** Every OPEN issue whose title is exactly `title`. Throws when it cannot say. */
  openIssuesTitled(title: string): number[];
  /** Opens an issue and returns its number. */
  create(title: string, body: string): number;
  comment(issue: number, body: string): void;
  /** Closes an issue; closing one already closed is not an error. */
  close(issue: number): void;
  /** An issue's body and then EVERY comment on it. Throws when it cannot say. */
  textOf(issue: number): string[];
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

export function anotherPushComment(p: Push): string {
  return `Another push changed the confirm path or a cron lane: ${p.sha} (${pushLink(p)}). The next run covers it too.`;
}

export function duplicateClosingComment(kept: number): string {
  return `Closed as a duplicate of #${kept}, which tracks the same load run. The pushes named here are listed there too.`;
}

/**
 * Every push the nag has named in these texts, as `<sha> (<compare link>)`, in order
 * and once each. Reads only the shape `openingBody` and `anotherPushComment` write, so
 * a person's note on the issue is never mistaken for a push.
 */
export function pushesNamedIn(texts: string[]): string[] {
  const out: string[] = [];
  const shape = /(?:^Push: |Another push changed the confirm path or a cron lane: )(\S+) \((https:\/\/github\.com\/[^\s)]+\/compare\/[^\s)]+)\)/gm;
  for (const text of texts) {
    for (const m of text.matchAll(shape)) {
      const entry = `${m[1]} (${m[2]})`;
      if (!out.includes(entry)) out.push(entry);
    }
  }
  return out;
}

/**
 * The note on the kept issue for one closed duplicate. The runbook closes the kept
 * issue only once a run covers every push LISTED ON IT, so the duplicate's pushes are
 * listed here rather than left on an issue nobody reads again.
 */
export function duplicateNote(dup: number, carried: string[]): string {
  const head = `#${dup} tracked the same load run and is closed as a duplicate of this one.`;
  if (carried.length === 0) return `${head} Every push it named is already listed here.`;
  return `${head} The pushes it named, which the next run covers too:\n${carried.map((c) => `- ${c}`).join("\n")}`;
}

export function runNag(client: NagClient, push: Push): NagOutcome {
  let open = client.openIssuesTitled(LOADTEST_DUE_TITLE);
  let opened: number | null = null;
  if (open.length === 0) {
    opened = client.create(LOADTEST_DUE_TITLE, openingBody(push));
    // Read again AFTER opening: a run racing this one may have opened its own in the
    // same moment. Whichever of the two reads second sees both, and both runs settle
    // on the same lowest number. This run's own issue counts even if the listing has
    // not caught up with it yet.
    open = [...new Set([...client.openIssuesTitled(LOADTEST_DUE_TITLE), opened])];
  }
  const sorted = [...open].sort((a, b) => a - b);
  const kept = sorted[0];
  // The issue this run opened names its push in the body; anywhere else, say it.
  if (kept !== opened) client.comment(kept, anotherPushComment(push));
  const closed = sorted.slice(1);
  if (closed.length > 0) {
    // Each duplicate is read before it is touched, so a failed read leaves it open
    // with its pushes still listed on it.
    const alreadyListed = pushesNamedIn(client.textOf(kept));
    for (const dup of closed) {
      const carried = pushesNamedIn(client.textOf(dup)).filter((p) => !alreadyListed.includes(p));
      client.comment(kept, duplicateNote(dup, carried));
      alreadyListed.push(...carried);
      client.comment(dup, duplicateClosingComment(kept));
      client.close(dup);
    }
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

// Scan logic for the salesforce_user_id consumer contract (#1587).
//
// Kept beside the guard rather than inside it so it can be driven against
// synthetic fixtures, including the bad shapes, without those fixtures living in
// the real tree.

export interface UserIdFinding {
  file: string;
  line: number;
  kind: "fallback" | "unguarded";
  text: string;
}

/**
 * Files allowed to touch the column WITHOUT going through
 * `requireSalesforceUserId`, because they are the ones that WRITE it or DECLARE
 * it rather than consume it.
 */
export const WRITER_FILES = [
  "src/lib/salesforce/user-id-link.ts",
  "src/lib/salesforce/sync.ts",
  "src/lib/db/types.ts",
];

const COLUMN = "salesforce_user_id";
const CAMEL = "salesforceUserId";
const GUARD = "requireSalesforceUserId";

/**
 * The column named as ITSELF, not as a prefix of something else.
 *
 * Both boundaries matter and both were found by running the guard. `_` is a word
 * character, so `\bsalesforce_user_id\b` already declines to match the alert key
 * `salesforce_user_id_conflicts`; the camelCase form needs the same treatment so
 * the copy builder `salesforceUserIdConflictAlert` is not read as a consumer of a
 * column it never touches. A plain substring search flagged five files that only
 * ever name the ALERT, which is a guard that fires on its own neighbours.
 */
const NAMES_COLUMN = new RegExp(`\\b(?:${COLUMN}|${CAMEL})\\b`);

/**
 * A fallback from the id to an email or a name: the exact substitution the key
 * exists to remove (L75). Matches the id (either spelling) followed by `??` or
 * `||` and then something email- or name-shaped, on one line.
 */
const FALLBACK = new RegExp(
  `\\b(?:${COLUMN}|${CAMEL})\\b\\s*(?:\\?\\?|\\|\\|)\\s*[^;\\n]*\\b(?:email|name|Email|Name)\\b`,
);

/** The reverse order: an email or name preferred, with the id as the fallback. */
const FALLBACK_REVERSED = new RegExp(
  `\\b(?:email|name|Email|Name)\\b[^;\\n]*(?:\\?\\?|\\|\\|)\\s*[^;\\n]*\\b(?:${COLUMN}|${CAMEL})\\b`,
);

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/**
 * Findings for one file.
 *
 * Two shapes, and each is blind where the other looks:
 *
 *   - `fallback`: a line that ORs the id together with an email or a name. This is
 *     flagged even inside a writer file, because no file has a reason to do it.
 *   - `unguarded`: a consumer file that reads the column and never mentions
 *     `requireSalesforceUserId`. A consumer that hand-rolls its own null check
 *     ships a second definition of what a missing key means, and the next one to
 *     be written copies whichever it found (L263).
 */
export function scanSalesforceUserId(
  src: string,
  file: string,
): UserIdFinding[] {
  const findings: UserIdFinding[] = [];
  const lines = src.split("\n");

  lines.forEach((line, i) => {
    if (isComment(line)) return;
    if (FALLBACK.test(line) || FALLBACK_REVERSED.test(line)) {
      findings.push({
        file,
        line: i + 1,
        kind: "fallback",
        text: line.trim().slice(0, 160),
      });
    }
  });

  if (WRITER_FILES.includes(file)) return findings;
  // A test names the column to build a fixture, which is not consuming it. Tests
  // stay in scope for `fallback` above, deliberately: a test that ASSERTS a
  // fallback works would be defending the behaviour this guard removes (L252).
  if (/\.test\.tsx?$/.test(file)) return findings;

  // Does this file read the column at all, outside a comment?
  const readsColumn = lines.some(
    (line) => !isComment(line) && NAMES_COLUMN.test(line),
  );
  if (readsColumn && !src.includes(GUARD)) {
    const first =
      lines.findIndex((line) => !isComment(line) && NAMES_COLUMN.test(line)) + 1;
    findings.push({
      file,
      line: first,
      kind: "unguarded",
      text: (lines[first - 1] ?? "").trim().slice(0, 160),
    });
  }

  return findings;
}

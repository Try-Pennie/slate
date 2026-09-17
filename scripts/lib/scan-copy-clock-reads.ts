/**
 * A copy builder may not read the clock (#2497, L713).
 *
 * WHY. A sentence that names a day ("today", "tomorrow", "Thursday") is a
 * relationship between the appointment and the reader's present, so a builder
 * that pins one end and reads the other for itself renders a different sentence
 * every day from the same input. Three things follow, and all three happened:
 * it cannot be previewed honestly, it cannot be tested deterministically, and it
 * changes at midnight with nobody touching the code.
 *
 * `dayWord` in `src/lib/booking/reminder.ts` decided "today" against "tomorrow"
 * from `DateTime.now()`. Its test pinned the other end to a constant, so the
 * suite passed on the day it merged (2026-09-16) and went red at midnight on the
 * 17th with no code change, which skipped main's deploy and left a monitoring
 * floor merged and not live.
 *
 * WHY STATICALLY. The preview guard already rendered twice and compared. That
 * cannot see this, and never could: the clock does not move between two renders
 * a millisecond apart, so the check reads clean over exactly the defect it is
 * named for. Reading the SOURCE is the half that works. The same blind repeat
 * passes a snapshot test, a cache key check and an idempotency key that secretly
 * read the date.
 *
 * WHAT IT CANNOT SEE, said here so a green run is never read as more than it is
 * (L400). It matches the four spellings below as TEXT. A builder that reaches
 * the clock through a helper it imports, or through `Temporal`, or through a
 * collaborator passed in, is NOT flagged: nothing in a single file scan can
 * follow that. The defect so far, and the shape anybody writing a day word would
 * produce, is a direct read in the builder itself.
 *
 * ESCAPE HATCH: `// clock-ok: <why>` on, or in the `//` block directly above,
 * the line. It is refused when it carries no reason, so the hatch cannot be
 * taken by writing the token alone (L675), and a refused one is reported as an
 * unreasoned hatch rather than as a plain clock read, because the two send a
 * reader to do different things (L11).
 *
 * It is deliberately its OWN token rather than one of the siblings
 * (`error-ok`, `parse-ok`, `write-ok`, `cap-safe`): putting a second rule behind
 * an existing suppression silently widens every existing use of it (L448), and
 * those are all written about a database read or write, so one sitting above a
 * builder would exempt a clock read nobody meant to exempt.
 */

export interface CopyClockFinding {
  file: string;
  /** 1 indexed, so it can be read straight off an editor's gutter. */
  line: number;
  /** The spelling that was found, so the message names what to change. */
  read: string;
  /**
   * True when a `// clock-ok:` was present but carried no reason. The read is
   * still a finding; this says WHICH finding, so a reader is not sent hunting
   * for a clock read they have already annotated.
   */
  unreasonedOptOut: boolean;
}

/**
 * The spellings a builder actually uses. `new Date()` is listed with its empty
 * parentheses on purpose: `new Date(someMs)` is a caller supplied instant and
 * exactly what this rule asks for.
 */
export const CLOCK_READS = ["Date.now(", "new Date()", "DateTime.now(", "DateTime.local("] as const;

export const CLOCK_OPT_OUT_TOKEN = "clock-ok";

/**
 * The reason must begin with a LETTER, so the surrounding syntax cannot satisfy
 * it and a hatch taken with a bare token or a stray brace reads as unreasoned
 * (L675). Anchored to this token alone, so another convention's opt-out on the
 * line above can never suppress this rule (L448).
 */
const OPT_OUT_WITH_REASON = new RegExp(`//\\s*${CLOCK_OPT_OUT_TOKEN}:\\s*[A-Za-z]`);
const OPT_OUT_ANY = new RegExp(`//\\s*${CLOCK_OPT_OUT_TOKEN}:`);

/** A `//` comment line, whatever its indentation. */
const isCommentLine = (line: string) => line.trim().startsWith("//");

/**
 * Whether the line itself, or the unbroken `//` block directly above it, carries
 * the hatch, and whether that hatch gave a reason. The block walks upwards and
 * stops at the first line that is neither a comment nor blank, so a hatch three
 * functions above cannot reach down and suppress an unrelated read.
 */
function optOutAt(lines: string[], index: number): { present: boolean; reasoned: boolean } {
  const consider = (line: string) =>
    OPT_OUT_ANY.test(line) ? { present: true, reasoned: OPT_OUT_WITH_REASON.test(line) } : null;

  const own = consider(lines[index]!);
  if (own) return own;

  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (!isCommentLine(line)) break;
    const found = consider(line);
    if (found) return found;
  }
  return { present: false, reasoned: false };
}

/**
 * Blank out `/* *\/` blocks and the body of `//` lines, keeping the line COUNT
 * and the hatch tokens intact. A comment that merely NAMES the clock (this
 * file's own header does it repeatedly) is not a finding; only real code is.
 */
function blankComments(source: string): string[] {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return withoutBlocks.split("\n").map((line) => {
    const at = line.indexOf("//");
    if (at === -1) return line;
    // Keep the comment text only when it carries this rule's token, so the
    // opt-out is still readable while the prose around it cannot match.
    const comment = line.slice(at);
    return line.slice(0, at) + (OPT_OUT_ANY.test(comment) ? comment : "");
  });
}

/**
 * Every clock read in `source` that is not covered by a reasoned hatch, plus
 * every hatch taken without a reason. An empty array means the module takes its
 * clock as an argument.
 */
export function scanCopyClockReads(source: string, file = "<source>"): CopyClockFinding[] {
  const rawLines = source.split("\n");
  const codeLines = blankComments(source);
  const findings: CopyClockFinding[] = [];

  for (let i = 0; i < codeLines.length; i++) {
    const code = codeLines[i]!;
    const read = CLOCK_READS.find((c) => code.includes(c));
    if (!read) continue;

    const { present, reasoned } = optOutAt(rawLines, i);
    if (present && reasoned) continue;

    findings.push({ file, line: i + 1, read, unreasonedOptOut: present });
  }
  return findings;
}

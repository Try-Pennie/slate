// Scan logic for scripts/test-runbook-commands.ts (#1200), kept here so it is
// unit-testable and so the runner's `scripts/test-*.ts` glob does not pick it up
// as a suite of its own.
//
// It finds every fenced code block in an operator runbook and reads the
// verification marker sitting directly above it.
import { createHash } from "node:crypto";

/** How a runbook block's verification status was declared. */
export type MarkerStatus = "verified" | "unverified" | "reference";

export type Marker = {
  status: MarkerStatus;
  /** ISO date the command was last executed. Only ever set for `verified`. */
  date: string | null;
  /** Short hash of the block content AS VERIFIED. Only ever set for `verified`. */
  hash: string | null;
  /** The operator-facing justification or evidence text. */
  note: string;
  /** 1-indexed line the marker sits on, for an actionable failure message. */
  line: number;
};

export type RunbookBlock = {
  /** Repo-relative path of the doc this block came from. */
  doc: string;
  /** 1-indexed line of the block's opening fence. */
  line: number;
  /** The fence's language tag, or "" when it carries none. */
  lang: string;
  /** Raw text between the fences. */
  content: string;
  /** The marker above the block, or null when it carries none. */
  marker: Marker | null;
};

/**
 * Canonical form of a block's content for hashing. Trailing whitespace and
 * surrounding blank lines are noise that would otherwise force a pointless
 * re-verification, so they are dropped; everything else, comments included, is
 * part of what the operator reads and pastes.
 */
export function normalizeBlock(content: string): string {
  return content
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

/**
 * The short content hash a `runbook-verified` marker has to carry. Truncated to
 * 8 hex characters: this is a change detector, not a security control, and a
 * full digest would dominate the line an operator is trying to read.
 */
export function blockHash(content: string): string {
  return createHash("sha256").update(normalizeBlock(content)).digest("hex").slice(0, 8);
}

const MARKER_RE =
  /^<!--\s*runbook-(verified|unverified|reference)\s*:\s*([\s\S]*?)\s*-->$/;

/** Parse one `<!-- runbook-… -->` comment line. Returns null when it is not one. */
export function parseMarker(rawLine: string, line: number): Marker | null {
  const m = MARKER_RE.exec(rawLine.trim());
  if (!m) return null;
  const status = m[1] as MarkerStatus;
  const body = m[2];
  if (status !== "verified") return { status, date: null, hash: null, note: body, line };

  // "2026-08-03 (a1b2c3d4) probed live against production; all four returned 200"
  const head = /^(\d{4}-\d{2}-\d{2})\s+\(([0-9a-f]{8})\)\s*([\s\S]*)$/.exec(body);
  if (!head) return { status, date: null, hash: null, note: body, line };
  return { status, date: head[1], hash: head[2], note: head[3], line };
}

/**
 * Every fenced block in `doc`, each paired with the marker directly above it.
 *
 * "Directly above" tolerates blank lines and OTHER HTML comments between the
 * marker and the fence, but nothing else: a marker further up, with prose in
 * between, belongs to a different block and is not credited to this one.
 *
 * Other comments are skipped because a block can legitimately carry more than
 * one (the erasure runbook's purge SQL carries a `canonical-sql` anchor that
 * another guard reads). Requiring strict adjacency would mean whichever comment
 * came last won, and adding an unrelated one would silently detach a marker that
 * is plainly still there.
 */
export function scanRunbookBlocks(docPath: string, text: string): RunbookBlock[] {
  const lines = text.split("\n");
  const blocks: RunbookBlock[] = [];

  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)```([a-zA-Z0-9_-]*)\s*$/.exec(lines[i]);
    if (!open) continue;

    const indent = open[1];
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === "```") {
        close = j;
        break;
      }
    }
    if (close === -1) break; // unterminated fence; nothing sane to report per-block

    let marker: Marker | null = null;
    for (let k = i - 1; k >= 0; ) {
      const above = lines[k].trim();
      if (above === "") {
        k--;
        continue;
      }
      // A marker's justification is usually too long for one line, so a comment
      // is gathered from its closing `-->` back up to its opening `<!--` and
      // parsed as a single string.
      if (!above.endsWith("-->")) break; // prose: ends the search
      let open = k;
      while (open >= 0 && !lines[open].includes("<!--")) open--;
      if (open < 0) break; // unterminated comment; treat as prose
      const comment = lines
        .slice(open, k + 1)
        .map((l) => l.trim())
        .join(" ");
      const parsed = parseMarker(comment, open + 1);
      if (parsed) {
        marker = parsed;
        break;
      }
      // Some other comment (the erasure runbook's `canonical-sql` anchor): keep
      // looking above it.
      k = open - 1;
    }

    blocks.push({
      doc: docPath,
      line: i + 1,
      lang: open[2],
      content: lines.slice(i + 1, close).map((l) => l.slice(indent.length)).join("\n"),
      marker,
    });

    i = close;
  }

  return blocks;
}

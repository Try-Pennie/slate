import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every word the EMBED says, read out of the shipping `widget.js` (#1421).
 *
 * Most real leads meet Slate through the embedded modal rather than the
 * standalone page, so its chrome is read more than any other copy in the product,
 * and until now it was the one lead-facing surface with no way to be looked at
 * before it shipped.
 *
 * `booker-copy.ts` solved that for the booker by moving the wording into pure
 * builders the preview calls, which is what makes the preview trustworthy: it
 * holds no copy of its own, so it cannot show text that no longer ships (L41).
 * `widget.js` cannot be given the same treatment. It is a dependency-free static
 * asset served to third-party pages with no build step between it and the browser,
 * so it can import nothing.
 *
 * This gets the same guarantee by the other route: rather than the preview calling
 * the artifact, it READS it. The strings come out of the `slate-embed-copy` block
 * in the shipping file, so what prints is literally what a lead sees.
 *
 * That holds only while the block is the ONLY place the embed's wording lives, and
 * that is not something to assume: `scripts/test-embed-invite-preview.ts` checks it
 * in both directions, so a seventh string added straight into the DOM code fails
 * the build rather than quietly becoming copy nobody can read (L96).
 *
 * Node only (it reads a file), so this is deliberately NOT imported by
 * `copy-preview.ts`, which the jsdom parity test loads.
 */

/** One entry from the embed's copy block. */
export interface EmbedCopyEntry {
  /** The key as `widget.js` names it. */
  key: string;
  text: string;
}

const WIDGET = join(process.cwd(), "public", "widget.js");
const START = "// slate-embed-copy: start";
const END = "// slate-embed-copy: end";

/**
 * The declared block's source, or a throw naming what was missing.
 *
 * A missing marker must NEVER read as "no copy": a scan that matches nothing and
 * reports success is how the next step ends up acting on a state nobody created
 * (L100). Every caller here is a preview or a guard, and both would happily print
 * or check an empty list.
 */
function copyBlock(source: string): string {
  const from = source.indexOf(START);
  const to = source.indexOf(END);
  if (from < 0) throw new Error(`widget.js has no "${START}" marker`);
  if (to < 0) throw new Error(`widget.js has no "${END}" marker`);
  if (to <= from) throw new Error("widget.js's embed-copy markers are the wrong way round");
  return source.slice(from + START.length, to);
}

/** `key: "text"` pairs, with `\uXXXX` escapes resolved the way the browser resolves
 *  them, so the preview shows the character a lead actually sees. */
function parseEntries(block: string): EmbedCopyEntry[] {
  const out: EmbedCopyEntry[] = [];
  for (const m of block.matchAll(/^\s*(\w+):\s*"((?:[^"\\]|\\.)*)"\s*,\s*$/gm)) {
    out.push({ key: m[1]!, text: JSON.parse(`"${m[2]!}"`) as string });
  }
  return out;
}

/** Read the embed's copy from the shipping file. */
export function embedCopyEntries(source = readFileSync(WIDGET, "utf8")): EmbedCopyEntry[] {
  const entries = parseEntries(copyBlock(source));
  if (entries.length === 0) {
    // Same reasoning as the missing marker: an empty result here is a parse that
    // failed, never an embed that says nothing.
    throw new Error("widget.js's embed-copy block parsed to no entries");
  }
  return entries;
}

/** How each entry reaches a lead, so the preview says more than the key name. */
const STATES: Record<string, string> = {
  modalLabel: "the dialog itself, heard on opening the modal",
  close: "the X in the corner",
  loading: "announced while the booker loads",
  loadingText: "and SHOWN, for a lead who asked for reduced motion and sees no spinner",
  loadFailed: "the booker did not load",
  retry: "and the way out of that",
  frameTitle: "the frame, in a screen reader's frame list",
};

export function embedCopyState(key: string): string {
  // Named rather than defaulted: a key with no state would print as a bare
  // identifier, which is the row a reader skips.
  return STATES[key] ?? `(no state described for "${key}")`;
}

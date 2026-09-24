// Scanner for `scripts/test-partner-keys.ts` (#2659): finds a partner join key
// spelled by hand, so every reader goes through `partnerKeysFrom`.
//
// What counts as a hand spelling is a lookup INTO THE PREFILL BAG by name:
//
//   - either key as a quoted string anywhere (`prefill["submissionId"]`,
//     `first(sp, "submissionId")`, `searchParams.get("regalProfileId")`);
//   - a dot read off a receiver called `prefill` (`prefill.submissionId`,
//     `b.prefill.regalProfileId`), the one name this codebase gives the bag.
//
// What deliberately does NOT count: `PARTNER_KEYS.submissionId` (the sanctioned
// spelling), a typed read off the reader's result (`partner.submissionId`) or an
// API view (`view.submissionId`), and a field in a type. Those are identifiers
// tsc checks against a declared shape, not lookups by string into a bag that
// accepts any key. Comments are stripped first, because a comment ABOUT the
// key is not a spelling of it and a guard that fails on one gets deleted
// (L103).
//
// What it cannot see, named so nobody reads it as broader than it is (L400): a
// dot read through a bag bound to some other name than `prefill`. That shape
// does not exist in the tree today, and the quoted form, which is how every
// query helper here takes a key, is caught regardless of the receiver.
//
// The pattern is DERIVED from `PARTNER_KEYS` rather than written here, so this
// file holds no spelling of its own and a renamed key re-aims the guard.
import { PARTNER_KEYS } from "../../src/lib/booking/partner-keys.ts";

export const PARTNER_KEYS_MODULE = "src/lib/booking/partner-keys.ts";

export interface HandSpelledKey {
  line: number;
  text: string;
}

const KEYS = Object.values(PARTNER_KEYS).join("|");
const QUOTED = new RegExp(`(["'\`])(?:${KEYS})\\1`);
const DOT_OFF_PREFILL = new RegExp(`\\bprefill\\s*\\.\\s*(?:${KEYS})\\b`);

/** Every line of `source` that spells a partner key by hand, comments stripped. */
export function handSpelledPartnerKeys(source: string): HandSpelledKey[] {
  const out: HandSpelledKey[] = [];
  const lines = stripComments(source).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (QUOTED.test(line) || DOT_OFF_PREFILL.test(line)) out.push({ line: i + 1, text: line });
  }
  return out;
}

/**
 * Block comments are blanked line by line (so line numbers hold), and a line
 * comment is one whose `//` follows the start of the line or whitespace, which
 * keeps the `//` inside a URL string from eating the rest of its line.
 */
function stripComments(source: string): string {
  const noBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlocks
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

/**
 * The shipped tree: source under src/, public/, worker/ and scripts/, minus the
 * tests (which spell the key on purpose, once, to pin it) and the owning module.
 */
export function isScannedPartnerKeyFile(path: string): boolean {
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (p === PARTNER_KEYS_MODULE) return false;
  if (!/^(src|public|worker|scripts)\//.test(p)) return false;
  if (!/\.(ts|tsx|js|mjs)$/.test(p)) return false;
  if (/\.test\.tsx?$/.test(p)) return false;
  if (/^scripts\/test-[^/]+\.ts$/.test(p)) return false;
  return true;
}

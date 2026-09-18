// Scan logic for #2235: an assertion that cannot fail.
//
// The issue starts from three found by accident while changing something else,
// two of which had been green for months. None of them would ever have failed on
// its own, and a test reporting coverage it does not have is worse than no test,
// because the gap is invisible to everybody reading the suite list.
//
// THE SHAPES HERE ARE THE ONES A SCAN CAN DECIDE, and each was narrowed until it
// named zero legitimate sites on the real tree. The first draft of this file was
// looser and named 72 of them across 1,619 files, almost all correct code, which
// is a rule nobody reads by the second week (L36). What the looseness cost is
// recorded per shape, because the next person to widen one will reach for exactly
// the version that was tried:
//
//   iterated-string  `for (const key of RETIRED_CRITERIA_KEYS)` where the subject
//     is one STRING, not a list. TypeScript allows it silently and iterates the
//     CHARACTERS, so `scripts/test-xbc.ts` spent months asking whether `"l"` was a
//     criteria key while reporting green over a bucket builder that could have
//     carried the retired criterion on every code (L684).
//
//     The string test is ANCHORED to the end of the expression. Matching a string
//     method anywhere in it read `attrs.teams.map((t) => String(t).trim())` and
//     `LAYOUTS.map((l) => [l.replace(...), l])` as strings: five of the first
//     draft's five hits were that, and every one of them is an array.
//
//   unsorted-sorted-claim  an assertion whose message claims SORTED order while
//     its expectation is a string array literal that is not in sorted order.
//     `scripts/test-catalog.ts` asserted the keys equalled
//     `["backend_service", "debt_team", "trades_access", "role"]` under the
//     message "keys are sorted". That order is not sorted: the literal was right
//     when it was written, a rename made it wrong, and nothing re-checked the
//     value against its own claim (L63).
//
//     The rule is NOT "a property word in the message beside a literal", which is
//     what the issue suggests and what the first draft did: 56 hits, and the ones
//     worth having were buried. "Every entry is named by a live site" beside `[]`
//     is a property assertion done RIGHT, and "never sorted as epoch 0" is prose.
//     So this decides the only part of the claim a scan can actually check: the
//     literal is compared against its own sorted self. A claim it cannot judge
//     (numbers, calls, a named constant) is left alone rather than guessed at.
//
//   empty-filter-zero  a FILTERED collection's length read against zero with
//     nothing asserting the filter matched anything. Nothing matched and
//     everything passed are the same number, which is how a
//     `gh run list --commit <sha>` that returned an empty list reported a deploy
//     as finished while it was still running (L98).
//
// WHAT THIS IS BLIND TO, said out loud so a green run is never read as more than
// it is (L400): a string reached through a function call, a typed parameter or a
// multi line declaration (no type checker runs here); a sortedness claim whose
// expectation is not a string array literal; and a filtered count whose filter
// lives in another file or another statement.
//
// THE FOURTH SHAPE THE ISSUE NAMES IS NOT HERE, deliberately: a count compared
// against "how many of these exist in the code" is a judgement about what the
// number MEANS, and no scan can tell `eq(rows.length, 3, ...)` over a fixture of
// three from one hard coding how many fields a row happens to have today. That
// half was swept by hand; the sweep and its verdicts are in
// `scripts/test-unfailable-assertions.ts`.

export interface UnfailableFinding {
  file: string;
  /** 1 indexed. */
  line: number;
  shape: "iterated-string" | "unsorted-sorted-claim" | "empty-filter-zero";
  snippet: string;
  why: string;
}

/**
 * An expression whose value is a STRING, whatever its declared type says.
 *
 * Anchored to the END, so the LAST operation is what decides. Anything looser
 * reads an array built by a `.map` whose callback trims a string as a string.
 */
const STRING_VALUED = [
  /^"[^"]*"$/,
  /^'[^']*'$/,
  /^`[^`]*`$/,
  /^String\(.*\)$/,
  /\.join\([^()]*\)$/,
  /\.(?:trim|toLowerCase|toUpperCase)\(\)$/,
];

const isStringValued = (expr: string) => STRING_VALUED.some((re) => re.test(expr.trim()));

/** `const NAME = <expr>;`, one line, which is how every real instance was written. */
const CONST_DECL = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(.+?);?\s*$/;

/** `for (const x of SUBJECT)`, capturing the subject expression. */
const FOR_OF = /\bfor\s*\(\s*(?:const|let|var)\s+[\w$[\]{},\s]+\s+of\s+([^)]+?)\s*\)/;

/** A message CLAIMING sorted order, which is the part a scan can check. */
const SORTED_CLAIM = /\b(?:sorted|alphabetical(?:ly)?)\b/i;

/** `eq(actual, ["a", "b"], "message")`, bounded to ONE statement. */
const EQ_STRING_ARRAY =
  /\beq\(\s*([^;]*?),\s*\[\s*((?:"[^"]*"|'[^']*')(?:\s*,\s*(?:"[^"]*"|'[^']*'))*)\s*,?\s*\]\s*,\s*(["'`])([^"'`]*?)\3\s*[,)]/g;

/** A filtered collection's length compared against zero. */
const FILTERED_COUNT_ZERO =
  /(?:select\([^)]*\)[^\n]*\|\s*length|\.filter\([^\n]*\)\.length)[^\n]*(?:\]\s*=\s*"0"|===?\s*0|<\s*1|!=\s*"0")/;

/** Something in the neighbourhood proving the filter had anything to match. */
const MATCHED_SOMETHING =
  /\bmatched\b|\.length\s*(?:>|>=)\s*(?:0|1)|-gt\s+0|\btoHaveLength\b|\bat least\b|\bnon[- ]empty\b/;

/** A comment line, so prose ABOUT a shape is never an instance of it (L673). */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("#");
}

export function scanUnfailableAssertions(file: string, source: string): UnfailableFinding[] {
  const out: UnfailableFinding[] = [];
  const lines = source.split("\n");

  // --- iterated-string -------------------------------------------------------
  // Only a declaration that FINISHES on its own line is judged: a multi line one
  // continues into operations this cannot see, and `String(x ?? "")` followed by
  // `.split(",")` on the next line is an array. And a name declared TWICE in one
  // file is dropped rather than judged by whichever declaration came last, which
  // is a scope this has no way to resolve.
  const stringConsts = new Map<string, number>();
  const declaredNames = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (isComment(raw)) continue;
    if (!raw.trimEnd().endsWith(";")) continue;
    const decl = CONST_DECL.exec(raw);
    if (!decl) continue;
    const name = decl[1]!;
    if (declaredNames.has(name)) {
      stringConsts.delete(name);
      continue;
    }
    declaredNames.add(name);
    if (isStringValued(decl[2]!)) stringConsts.set(name, i + 1);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isComment(line)) continue;
    const m = FOR_OF.exec(line);
    if (!m) continue;
    const subject = m[1]!.trim();
    // An INLINE string literal is a deliberate character walk (`for (const d of
    // "0123")` builds the three digit codes in two scripts here), so only a NAMED
    // value counts: the defect is a name that reads as a list and is not one.
    const declaredAt = stringConsts.get(subject);
    if (declaredAt === undefined) continue;
    out.push({
      file,
      line: i + 1,
      shape: "iterated-string",
      snippet: line.trim().slice(0, 120),
      why:
        `\`${subject}\` is a STRING, so this loop runs once per CHARACTER and every check ` +
        `inside it asks about a single letter. TypeScript allows it silently` +
        ` (declared on line ${declaredAt})` +
        `. Build the list as an array, or iterate what you meant.`,
    });
  }

  // --- unsorted-sorted-claim -------------------------------------------------
  for (const m of source.matchAll(EQ_STRING_ARRAY)) {
    const message = m[4]!;
    if (!SORTED_CLAIM.test(message)) continue;
    const items = m[2]!.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    const sorted = [...items].sort();
    if (items.join(" ") === sorted.join(" ")) continue;
    out.push({
      file,
      line: source.slice(0, m.index).split("\n").length,
      shape: "unsorted-sorted-claim",
      snippet: `eq(..., ${JSON.stringify(items).slice(0, 70)}, "${message.slice(0, 50)}")`,
      why:
        `the message claims sorted order and the literal it compares is NOT sorted ` +
        `(sorted would be ${JSON.stringify(sorted).slice(0, 70)}). The literal was right the ` +
        `day it was written and nothing re-checks it against its own claim (L63). Assert the ` +
        `property: compare the value against its own sorted copy.`,
    });
  }

  // --- empty-filter-zero -----------------------------------------------------
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isComment(line)) continue;
    if (!FILTERED_COUNT_ZERO.test(line)) continue;
    // COMMENTS ARE STRIPPED from the window: prose about matching is not a
    // check, and this file's own explanation of the shape sits beside the one
    // real instance, which is how a guard comes to excuse itself (L673).
    const around = lines
      .slice(Math.max(0, i - 6), i + 7)
      .filter((l) => !isComment(l))
      .join("\n");
    if (MATCHED_SOMETHING.test(around)) continue;
    out.push({
      file,
      line: i + 1,
      shape: "empty-filter-zero",
      snippet: line.trim().slice(0, 120),
      why:
        `a FILTERED collection is compared against zero with nothing nearby asserting the ` +
        `filter had anything to match. Nothing matched and everything passed are the same ` +
        `number (L98). Read how many it saw at all, in the same breath, and refuse on none.`,
    });
  }

  return out;
}

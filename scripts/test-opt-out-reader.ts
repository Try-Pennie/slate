// Repo invariant (#2200): every convention guard reads its opt out through ONE
// reader, and that reader is tested once against every comment form the tree uses.
//
// Two halves, and each is blind where the other looks:
//
//   - the READER. Fixtures for a `//` run, a trailing comment on the line itself,
//     a `/* */` block, a `{/* */}` JSX block, an opt out inside a ternary, a blank
//     line in the way, a bracket in the way, a reason that wraps, and a case per
//     hole already found in a hand rolled copy. Each carries both directions: the
//     marker present AND the marker absent, because a reader hard wired to one
//     answer satisfies a one sided fixture (L1).
//   - the CONSOLIDATION. A scan over `scripts/` for a hand rolled matcher: a
//     regex or an `indexOf` naming a `-ok:` / `cap-safe:` marker outside this
//     reader. Converting the thirty odd sites in front of you and leaving the
//     rule to memory is how the next one arrives (L613), so the guard is what
//     makes the consolidation stick.
//
// Run: node --experimental-strip-types scripts/test-opt-out-reader.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hasOptOut, readOptOut, hasOptOutAtOffset } from "./lib/opt-out.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const HERE = import.meta.dirname; // scripts/
const ROOT = join(HERE, "..");

// --- the reader ---------------------------------------------------------------

interface Case {
  name: string;
  /** Source whose LAST line is the subject. */
  src: string;
  token: string;
  exempt: boolean;
  /** The reason the reader should read off, when one is expected. */
  reason?: string;
  sql?: boolean;
  /** 0-indexed subject line, when it is not the last one. */
  at?: number;
}

const CASES: Case[] = [
  {
    name: "a trailing comment on the subject's own line",
    src: `const rows = await pgGet("x"); // cap-safe: unique key, at most one row`,
    token: "cap-safe:",
    exempt: true,
    reason: "unique key, at most one row",
  },
  {
    name: "a `//` run directly above",
    src: [
      "// error-ok: best effort worklist; the lane retries next tick",
      "// and nothing downstream reads the empty list as an answer",
      `const { data } = await db.from("t").select("id");`,
    ].join("\n"),
    token: "error-ok:",
    exempt: true,
  },
  {
    name: "a blank line between the comment and the subject",
    src: [
      "// parse-ok: the column is NOT NULL timestamptz",
      "",
      "const at = Date.parse(row.created_at);",
    ].join("\n"),
    token: "parse-ok:",
    exempt: true,
  },
  {
    name: "a `/* */` block directly above",
    src: [
      "/*",
      " * write-ok: a best effort touch; the next tick rewrites the row",
      " */",
      `await db.from("t").update({ seen: true }).eq("id", id);`,
    ].join("\n"),
    token: "write-ok:",
    exempt: true,
  },
  {
    name: "a `{/* */}` JSX block directly above",
    src: [
      "{/* mark-ok: an oval centres the pair, so the label moves instead */}",
      `<span className="h-2 w-2 rounded-full" />`,
    ].join("\n"),
    token: "mark-ok:",
    exempt: true,
  },
  {
    name: "inside a ternary, with a bracket line in the way (AppHeader.tsx:123)",
    src: [
      "const calendarRows = wantsCalendar",
      "  ? // error-ok: a failed read leaves `checked: false`, the state the",
      "    // banner already models, so it stays silent rather than claiming",
      "    ((",
      "      await supabaseAdmin().from(\"agent_calendars\").select(\"watch_expiration\")",
      "    ).data)",
      "  : null;",
    ].join("\n"),
    token: "error-ok:",
    exempt: true,
    at: 4,
  },
  {
    name: "a reason that wraps onto the next comment line",
    src: [
      "// in-chunk-ok:",
      "// the id set is the roster, which the design target caps at 200",
      `await db.from("t").select("id").in("id", ids);`,
    ].join("\n"),
    token: "in-chunk-ok:",
    exempt: true,
    reason: "the id set is the roster, which the design target caps at 200",
  },
  {
    name: "a `-- ` SQL comment above a migration statement",
    src: [
      "-- export-cursor-ok: this file rewinds the cursor at the bottom",
      "update ooo_audit set updated_at = now();",
    ].join("\n"),
    token: "export-cursor-ok:",
    exempt: true,
    sql: true,
  },

  // --- the holes already found, each of which read as exempt ------------------
  {
    name: "HOLE #2112: a JSX marker whose only reason is the block terminator",
    src: ["{/* unsaved-ok: */}", "<form onSubmit={save}>"].join("\n"),
    token: "unsaved-ok:",
    exempt: false,
  },
  {
    name: "HOLE: a bare `// cap-safe:` with nothing after it",
    src: [`// cap-safe:`, `const rows = await pgGet("x");`].join("\n"),
    token: "cap-safe:",
    exempt: false,
  },
  {
    name: "HOLE: the marker word with no colon at all",
    src: [`// cap-safe`, `const rows = await pgGet("x");`].join("\n"),
    token: "cap-safe:",
    exempt: false,
  },
  {
    name: "HOLE: a reason that is only punctuation",
    src: [`// write-ok: ???`, `await db.from("t").update({}).eq("id", id);`].join("\n"),
    token: "write-ok:",
    exempt: false,
  },

  // --- the marker is genuinely absent ----------------------------------------
  {
    name: "no marker anywhere",
    src: [`// an ordinary comment about the read below`, `const { data } = await db.from("t").select("id");`].join("\n"),
    token: "error-ok:",
    exempt: false,
  },
  {
    name: "a marker for a DIFFERENT token never exempts this one (L448)",
    src: [`// error-ok: a failed read skips this tick`, `await db.from("t").update({}).eq("id", id);`].join("\n"),
    token: "write-ok:",
    exempt: false,
  },
  {
    name: "a marker separated from the subject by a statement",
    src: [
      "// error-ok: this reason belongs to the read below it",
      `const { data, error } = await db.from("a").select("id");`,
      `const { data: b } = await db.from("b").select("id");`,
    ].join("\n"),
    token: "error-ok:",
    exempt: false,
  },
  {
    name: "a marker above a CLOSED block does not reach past the `;`",
    src: [
      "// error-ok: about something inside the call that just ended",
      "});",
      `const { data } = await db.from("t").select("id");`,
    ].join("\n"),
    token: "error-ok:",
    exempt: false,
  },
];

for (const c of CASES) {
  const lines = c.src.split("\n");
  const at = c.at ?? lines.length - 1;
  const opts = c.sql ? { syntax: ["sql"] as const } : undefined;
  const found = hasOptOut(lines, at, c.token, opts);
  assert(found === c.exempt, `${c.exempt ? "exempts" : "refuses"}: ${c.name}`);
  if (c.reason !== undefined) {
    eq(readOptOut(lines, at, c.token, opts).reason, c.reason, `reads the reason: ${c.name}`);
  }
}

// The byte-offset entry point is the same reader, so one case pins that it agrees.
{
  const src = `// cap-safe: bounded by the roster\nconst rows = await pgGet("users?select=id");`;
  assert(
    hasOptOutAtOffset(src, src.indexOf("pgGet"), "cap-safe:"),
    "the byte-offset entry point agrees with the line entry point",
  );
  assert(
    !hasOptOutAtOffset(src.replace("bounded by the roster", ""), src.indexOf("pgGet"), "cap-safe:"),
    "the byte-offset entry point refuses a bare marker too",
  );
}

// --- the consolidation guard ---------------------------------------------------
//
// A hand rolled matcher is a literal naming a marker (`foo-ok:` or `cap-safe`)
// that is not this reader and is not a MESSAGE telling somebody to write one.
// Prose is excluded by looking only at code lines: a comment explaining the
// convention is not a second implementation of it.

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      out.push(...tsFiles(join(dir, e.name)));
      continue;
    }
    if (/\.(ts|mjs)$/.test(e.name)) out.push(join(dir, e.name));
  }
  return out;
}

/** The reader itself, and the test you are reading, both name markers on purpose. */
const MATCHER_EXEMPT = new Set(["scripts/lib/opt-out.ts", "scripts/test-opt-out-reader.ts"]);

/**
 * Markers that are NOT one-line opt outs and so are not this reader's business.
 * Each says why, because an entry with no reason is one nobody reasoned about.
 */
const NOT_AN_OPT_OUT: Readonly<Record<string, string>> = {
  // `env-ok: NAME (why)` is a file-level DECLARATION naming a variable, matched
  // anywhere in the script rather than attached to a line, so "the line or the
  // block above it" is not the question it answers.
  "env-ok:": "a file level declaration naming a variable, not a line opt out",
  // `alert-key: <key>` declares what an opaque send site's key IS. It adds
  // information the scanner cannot read rather than removing a finding.
  "alert-key:": "declares a value the scanner cannot read, not an exemption",
  // `all-clear-proof:` points at the suite that proves the silent path, which is
  // a POINTER to coverage rather than a waiver of it.
  "all-clear-proof:": "points at covering proof rather than waiving the rule",
};

/** The marker shape: `<something>-ok` or the one legacy spelling, `cap-safe`. */
const MARKER = String.raw`(?:[a-z][a-z-]*-ok|cap-safe)`;

/** Blanks out every string and template literal, so a FIXTURE is not a matcher. */
function withoutLiterals(line: string): string {
  return line.replace(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g, '""');
}

/**
 * Is this line a hand rolled reading of a marker, rather than prose about one?
 *
 * Three shapes, and each is a decision rather than a description:
 *   - a REGEX literal holding the marker (the marker survives literal-stripping
 *     and a `/` closes it later on the line),
 *   - a named constant (`OPT_OUT`, `EXEMPT`, `HATCH`, `MARKER`) holding it,
 *   - `.includes(...)` / `.indexOf(...)` / `.startsWith(...)` over it.
 *
 * A failure message telling somebody what to write, a fixture containing one, and
 * the marker handed TO the shared reader as an argument are all left alone.
 */
function handRolledMarkerOn(line: string): string | null {
  // A named constant holding a PATTERN, or a string carrying a comment opener,
  // is a matcher. One holding the bare token is the ARGUMENT the shared reader
  // takes and decides nothing on its own, so it is left alone: whatever consumes
  // it is what this has to catch, and the two rules below are what catch it.
  const named = new RegExp(
    String.raw`(?:const|let|var)\s+\w*(?:OPT_OUT|OPTOUT|EXEMPT|HATCH|MARKER)\w*\s*(?::[^=]*)?=\s*(?:/[^\n]*?|["'\`][^\n]*?(?://|--|#|\\s)[^\n]*?)\b(${MARKER})\b`,
  ).exec(line);
  if (named) return `${named[1]}:`;

  const called = new RegExp(
    String.raw`\.(?:includes|indexOf|startsWith|endsWith)\(\s*["'\`][^"'\`\n]*\b(${MARKER})\b`,
  ).exec(line);
  if (called) return `${called[1]}:`;

  const residue = withoutLiterals(line);
  const inRegex = new RegExp(String.raw`\b(${MARKER})\b[^\n]*/`).exec(residue);
  if (inRegex) return `${inRegex[1]}:`;

  return null;
}

const handRolled: string[] = [];
for (const file of tsFiles(join(ROOT, "scripts"))) {
  const rel = file.slice(ROOT.length + 1).replaceAll("\\", "/");
  if (MATCHER_EXEMPT.has(rel)) continue;
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    // Prose: a comment describing the convention is not an implementation of it.
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    const token = handRolledMarkerOn(line);
    if (token === null || token in NOT_AN_OPT_OUT) continue;
    // A line that STRIPS markers out of a real file to plant the defect back is
    // not a reading of one, and there is nothing for the shared reader to do
    // there. It is waived by name, through the shared reader, with a reason.
    if (hasOptOut(lines, i, "opt-out-matcher-ok:")) continue;
    handRolled.push(`${rel}:${i + 1} ${trimmed.slice(0, 110)} (marker ${token})`);
  }
}

for (const site of handRolled) {
  assert(false, `hand rolled opt out matcher; read it through scripts/lib/opt-out.ts: ${site}`);
}

// A scan that reaches nothing reports clean, so prove it reaches the tree it
// claims to (L98): the reader's own siblings must be there to be exempted.
const scanned = tsFiles(join(ROOT, "scripts")).length;
assert(scanned > 100, `the consolidation scan reached the scripts tree (${scanned} files)`);
assert(
  readFileSync(join(ROOT, "scripts", "lib", "opt-out.ts"), "utf8").includes("export function hasOptOut"),
  "the shared reader exists and exports hasOptOut",
);

// Positive controls, both directions: the matcher scan must CATCH each planted
// shape and must LEAVE ALONE the prose it would be useless if it flagged (L1).
{
  const caught = [
    String.raw`const OPT_OUT = /\/\/\s*planted-ok:/;`,
    `const EXEMPT = "// planted-ok:";`,
    `if (line.includes("planted-ok:")) return true;`,
    String.raw`if (/\/\/\s*planted-ok/i.test(trimmed)) return true;`,
  ];
  for (const line of caught) {
    assert(handRolledMarkerOn(line) !== null, `positive control: caught a hand rolled matcher [${line}]`);
  }
  const allowed = [
    `src: "// planted-ok: a fixture, not a matcher\\nconst x = 1;",`,
    "`annotate with // planted-ok: <why> if it is deliberate`,",
    `if (hasOptOut(lines, i, "planted-ok:")) continue;`,
  ];
  for (const line of allowed) {
    assert(handRolledMarkerOn(line) === null, `positive control: left alone [${line}]`);
  }
  assert(
    handRolledMarkerOn(`export const OPT_OUT = "planted-ok:";`) === null,
    "positive control: a bare token constant is the reader's argument, not a matcher",
  );
}

if (handRolled.length === 0) {
  console.log(`ok: no hand rolled opt out matchers across ${scanned} files under scripts/`);
}

finish();

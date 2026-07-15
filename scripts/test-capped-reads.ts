// Repo invariant (#730): guard against reintroducing a capped single-page list
// read used for a count/aggregate in the loadtest + smoke scripts.
//
// The bug class: a plain `fetch(...select=...)` (or a wrapper like pgGet/getJson)
// returns at most PostgREST's 1000-row page, and code then does `.filter(...)` or
// `.length` on it as if it were the whole set. With a large table the read
// silently truncates and the invariant FALSE-PASSES. It shipped in the #440 soak
// and was fixed twice: #723 (soak invariants) and #725 (freshness in run.ts).
// Nothing stopped it recurring, so this scans scripts/loadtest/** and
// scripts/smoke-*.ts and fails if any single-page read feeds a count/aggregate
// without being made cap-safe.
//
// Cap-safe means ONE of:
//   - the read goes through the paginating `listAll` or server-side `count` helper
//     (scripts/loadtest/invariants.ts), or
//   - the query carries `limit=` (an explicit, bounded page), or
//   - the read is only a single-row grab (rows[0]), not an aggregate, or
//   - it carries an inline `// cap-safe: <reason>` opt-out documenting why the set
//     can never exceed one page.
//
// The scan logic lives in scripts/lib/scan-capped-reads.ts so it is unit-testable.
// This file exercises it against fixtures (a positive control that proves the
// detector actually flags the bad pattern, so it can't rot into a no-op), against
// the real invariants.ts (clean now; a mutated copy MUST be caught), and finally
// over the whole scan surface (must be clean).
// Run: node --experimental-strip-types scripts/test-capped-reads.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scanCappedReads } from "./lib/scan-capped-reads.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

const HERE = import.meta.dirname; // scripts/
const ROOT = join(HERE, "..");

// --- positive control: the detector must flag bad and allow good --------------

interface Fixture {
  name: string;
  flagged: boolean;
  src: string;
}

const FIXTURES: Fixture[] = [
  {
    name: "unbounded read consumed by .filter().length",
    flagged: true,
    src: `const bb = await pgGet("busy_blocks?source=eq.slate&select=id");\nif (bb.filter((x) => x.cancelled).length) fail();`,
  },
  {
    name: "inline unbounded read consumed by .length",
    flagged: true,
    src: `const n = (await getJson("webhook_deliveries?select=id")).length;`,
  },
  {
    name: "narrow-looking eq read used as a count without an opt-out",
    flagged: true,
    src: `const rows = await pgGet("webhook_deliveries?select=id&dedupe_key=eq.abc");\ncheck(rows.length === 1, "one");`,
  },
  {
    name: "bounded by limit=",
    flagged: false,
    src: `const a = await getJson("users?select=id&limit=200");\nif (a.length === 0) fail();`,
  },
  {
    name: "server-side count() helper",
    flagged: false,
    src: `const stuck = await count("busy_blocks?source=eq.slate&select=id");\nif (stuck !== 0) fail();`,
  },
  {
    name: "paginated listAll() helper",
    flagged: false,
    src: `const d = await listAll("webhook_deliveries?select=id");\nconst dupes = d.filter((x) => x).length;`,
  },
  {
    name: "cap-safe opt-out comment on the line above",
    flagged: false,
    src: `// cap-safe: filtered to one booking's dedupe_key, <= a few rows\nconst rows = await pgGet("webhook_deliveries?select=id&dedupe_key=eq.abc");\ncheck(rows.length === 1, "one");`,
  },
  {
    name: "cap-safe opt-out inside a multi-line comment block",
    flagged: false,
    src: `// cap-safe: idempotency_key is unique, so this\n// returns at most one row.\nconst rows = await pgGet("booking_reservations?select=id&idempotency_key=eq.abc");\ncheck(rows.length === 0, "gone");`,
  },
  {
    name: "single-row [0] grab is not a count/aggregate",
    flagged: false,
    src: `const rows = await pgGet("bookings?select=x&id=eq.abc");\nconst row = rows[0];`,
  },
];

for (const f of FIXTURES) {
  const found = scanCappedReads(f.src, "fixture").length > 0;
  assert(found === f.flagged, `${f.flagged ? "flags" : "allows"}: ${f.name}`);
}

// --- real-file positive control: a regression in invariants.ts is caught ------

const invPath = join(HERE, "loadtest", "invariants.ts");
const invSrc = readFileSync(invPath, "utf8");
assert(scanCappedReads(invSrc, invPath).length === 0, "the real invariants.ts is clean");

// Swap the cap-safe helpers for a raw reader: the paginated reads become capped
// single-page reads and the guard MUST notice. Proves it verifies something.
const mutated = invSrc.replace(/\blistAll\(/g, "pgGet(").replace(/\bcount\(/g, "pgGet(");
assert(
  scanCappedReads(mutated, invPath).length > 0,
  "positive control: mutating listAll/count -> pgGet is caught",
);

// --- repo invariant: the whole scan surface is clean --------------------------

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (/\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const surface = [
  ...tsFiles(join(HERE, "loadtest")),
  ...readdirSync(HERE)
    .filter((f) => /^smoke-.*\.ts$/.test(f))
    .map((f) => join(HERE, f)),
];

assert(surface.length > 0, `found scan-surface files to check (got ${surface.length})`);

let siteCount = 0;
for (const file of surface) {
  const src = readFileSync(file, "utf8");
  const findings = scanCappedReads(src, file.slice(ROOT.length + 1));
  siteCount += findings.length;
  for (const fnd of findings) {
    assert(
      false,
      `${fnd.file}:${fnd.line} single-page read via ${fnd.reader}(...) feeds a count/aggregate; ` +
        `use listAll()/count() (scripts/loadtest/invariants.ts), add limit=, or annotate // cap-safe: <reason> [${fnd.query}]`,
    );
  }
}
if (siteCount === 0) console.log("ok: no capped single-page reads across the loadtest + smoke scripts");

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

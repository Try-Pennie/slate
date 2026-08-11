// Repo invariant (#1269): no batched PostgREST `in(...)` filter is sized by a
// bare literal. Run: node --experimental-strip-types scripts/test-batch-sizes.ts
//
// The bug class, three instances in ONE day: `.in("id", ids)` puts every id in
// the query string, so an oversized batch is REFUSED at the transport rather than
// merely slow, and a COUNT only bounds the URL while every id is the same length.
// PR#1251 shipped a 500-row stride that failed on every request, carried over
// from a call site whose Google event ids were 27 characters (#1259); #1267 found
// an unchunked delete; #1268 found a 500-id delete against ids measured at 43
// characters average, reaching 181.
//
// #1321 removed the pattern from the codebase, which is the stronger half of the
// fix: there is nothing left to copy. This is the half that stops it coming back,
// and it exists because eliminating an instance does not stop the next author
// writing a fresh one.
//
// The check reasons about the VALUE, not the count, by requiring the chunking to
// go through `chunkIdsByUrlBudget`, which measures the ids it is given. That is
// what makes one safe number unnecessary rather than merely documented.
//
// The scan logic lives in scripts/lib/scan-batch-sizes.ts so it is unit-testable.
// This file is the positive control (proving the detector still catches the bad
// pattern rather than rotting into a no-op), a real-file mutation control, and
// the whole-`src/` invariant.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { scanBatchSizes } from "./lib/scan-batch-sizes.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");

// --- positive control: the detector catches the shipped defect ---------------

interface Fixture {
  name: string;
  flagged: boolean;
  code: string;
}

const FIXTURES: Fixture[] = [
  {
    name: "the exact shape PR#1251 shipped: a 500 stride feeding a delete filter",
    flagged: true,
    code: `
      for (let i = 0; i < stale.length; i += 500) {
        await db.from("busy_blocks").delete().in("id", stale.slice(i, i + 500));
      }
    `,
  },
  {
    name: "a 200 stride is flagged too: the number being safe TODAY is not the point",
    flagged: true,
    code: `
      for (let i = 0; i < ids.length; i += 200) {
        await db.from("bookings").select("id").in("id", ids.slice(i, i + 200));
      }
    `,
  },
  {
    name: "a slice-only stride, for a loop written some other way",
    flagged: true,
    code: `
      let cursor = 0;
      while (cursor < keys.length) {
        await db.from("alert_state").delete().in("key", keys.slice(cursor, cursor + 300));
        cursor += 300;
      }
    `,
  },
  {
    name: "chunkIdsByUrlBudget: measured from the ids, so nothing to calibrate",
    flagged: false,
    code: `
      for (const chunk of chunkIdsByUrlBudget(stale)) {
        await db.from("busy_blocks").delete().in("id", chunk);
      }
    `,
  },
  {
    name: "a NAMED stride, which has one definition to reason about",
    flagged: false,
    code: `
      for (let i = 0; i < ids.length; i += UPSERT_CHUNK) {
        await db.from("busy_blocks").select("id").in("id", ids.slice(i, i + UPSERT_CHUNK));
      }
    `,
  },
  {
    name: "a literal stride feeding NO url filter: a concurrency wave has no URL to overflow",
    flagged: false,
    code: `
      for (let i = 0; i < due.length; i += 8) {
        const wave = due.slice(i, i + 8);
        await Promise.all(wave.map((code) => recompute(code)));
      }
    `,
  },
  {
    name: "a Google items cap, which is a per-request ITEM limit and not a URL budget",
    flagged: false,
    code: `
      for (let i = 0; i < agents.length; i += 20) {
        const calIds = agents.slice(i, i + 20).flatMap((a) => a.calendarIds);
        await freeBusyMany(subject, from, to, calIds);
      }
    `,
  },
  {
    name: "an upsert BODY chunk: rows travel in the POST body, not the query string",
    flagged: false,
    code: `
      for (let i = 0; i < upserts.length; i += 500) {
        await db.from("busy_blocks").upsert(upserts.slice(i, i + 500), { onConflict: "id" });
      }
    `,
  },
  {
    name: "the opt-out, for a genuinely bounded set",
    flagged: false,
    code: `
      // batch-ok: exactly the two smoke bucket codes, a fixed set of 2
      for (let i = 0; i < codes.length; i += 2) {
        await db.from("buckets").select("code").in("code", codes.slice(i, i + 2));
      }
    `,
  },
  {
    name: "a comment mentioning a stride cannot satisfy the guard, nor trip it",
    flagged: false,
    code: `
      // We used to do: for (let i = 0; i < ids.length; i += 500) { .in("id", ...) }
      for (const chunk of chunkIdsByUrlBudget(ids)) {
        await db.from("bookings").delete().in("id", chunk);
      }
    `,
  },
];

for (const f of FIXTURES) {
  const found = scanBatchSizes(f.code, f.name).length > 0;
  eq(found, f.flagged, `${f.flagged ? "FLAGS" : "allows"}: ${f.name}`);
}

// --- the whole-src invariant --------------------------------------------------

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const files = tsFiles(join(ROOT, "src"));
assert(files.length > 100, `the sweep actually found source files (${files.length})`);

const offenders = files.flatMap((file) =>
  scanBatchSizes(readFileSync(file, "utf8"), relative(ROOT, file)),
);
eq(
  offenders.map((o) => `${o.file}:${o.line} (stride ${o.stride}) ${o.snippet}`),
  [],
  "no batched `in(...)` filter in src/ is sized by a bare literal",
);

// --- real-file mutation control: the sweep above must not be vacuous ---------
{
  // If the detector stopped matching (a renamed helper, a reworded loop), the
  // empty result above would read exactly like a clean codebase (L1). So take a
  // real converted file and put the defect back.
  const real = readFileSync(join(ROOT, "src/lib/google/sync.ts"), "utf8");
  assert(
    real.includes("chunkIdsByUrlBudget"),
    "sanity: the file this control mutates really does use the chunker",
  );
  const sabotaged = real.replace(
    /for \(const chunk of chunkIdsByUrlBudget\(stale\)\) \{/,
    "for (let i = 0; i < stale.length; i += 500) {\n    const chunk = stale.slice(i, i + 500);",
  );
  assert(sabotaged !== real, "sanity: the mutation applied");
  assert(
    scanBatchSizes(sabotaged, "sync.ts").length > 0,
    "reverting a real file to a literal stride IS caught, so the clean sweep means something",
  );
}

finish();

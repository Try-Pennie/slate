// Repo invariant (#315): guard against reintroducing a swallowed-error Supabase
// read in the availability / booking paths.
//
// The bug class (#277): `const { data } = await db.from("t").select(...)` that
// ignores `error`. On a query failure `data` is null, the availability pool
// collapses to empty, and the booker silently shows NO times. #277 routed the
// availability-critical reads through `unwrap` (which throws on a real error);
// nothing stopped a NEW ignore-the-error read from creeping back in. This scans
// src/lib/availability/*, src/lib/booking/*, src/lib/google/*, src/lib/routing/*
// and src/lib/salesforce/* (#865 widened it to the sync + routing paths where
// #315 and #834 found risky reads; #963 added salesforce, where the roster sync
// treated a read error as an empty roster) and fails if any awaited select is
// destructured for `data` without also consulting `error` (and without the
// documented `// error-ok:` opt-out for a deliberately null-tolerant read).
//
// The scan logic lives in scripts/lib/scan-swallowed-error-reads.ts so it is
// unit-testable. This file exercises it against fixtures (a positive control that
// proves the detector actually flags the bad pattern, so it can't rot into a
// no-op), against the real source tree (must be clean), and against a mutation of
// the real booking/service.ts with its `// error-ok:` opt-outs stripped (which
// MUST be caught, proving the guard verifies something against real reads).
// Run: node --experimental-strip-types scripts/test-swallowed-error-reads.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scanSwallowedErrorReads } from "./lib/scan-swallowed-error-reads.ts";
import { assert, finish } from "./lib/harness.ts";

const HERE = import.meta.dirname; // scripts/
const ROOT = join(HERE, "..");

// --- positive control: flag the bad shape, allow the safe ones ----------------

interface Fixture {
  name: string;
  flagged: boolean;
  src: string;
}

const FIXTURES: Fixture[] = [
  // FLAGGED: awaited select destructured for data, error ignored ---------------
  {
    name: "inline select, data only, consumed as list",
    flagged: true,
    src: `const { data } = await supabaseAdmin().from("bookings").select("id").eq("bucket_id", b);\nreturn (data ?? []).length;`,
  },
  {
    name: "aliased data binding (data: booking)",
    flagged: true,
    src: `const { data: booking } = await db.from("bookings").select("*").eq("manage_token", t).maybeSingle();\nif (!booking) return null;`,
  },
  {
    name: "single() row, data only",
    flagged: true,
    src: `const { data } = await supabaseAdmin().from("users").select("*").eq("id", id).single();\nreturn data as User;`,
  },
  {
    name: "builder terminal await, select is on the earlier let q line",
    flagged: true,
    src: `let q = supabaseAdmin().from("booking_events").select("id").eq("booking_id", b);\nq = q.eq("action", a);\nconst { data } = await q.limit(1).maybeSingle();\nreturn data != null;`,
  },
  {
    name: "precompute-style bucket_slots blob read",
    flagged: true,
    src: `const { data } = await supabaseAdmin().from("bucket_slots").select("payload").eq("bucket_code", code).maybeSingle();\nreturn data ?? null;`,
  },

  // NOT FLAGGED: error is consulted -------------------------------------------
  {
    name: "data AND error destructured",
    flagged: false,
    src: `const { data, error } = await db.from("bookings").select("*").eq("id", id).single();\nif (error) throw error;`,
  },
  {
    name: "error only (a checked write)",
    flagged: false,
    src: `const { error } = await db.from("reschedule_locks").insert({ booking_id: b });\nif (error && error.code !== "23505") throw error;`,
  },
  {
    name: "routed through unwrap (no { data } destructure)",
    flagged: false,
    src: `const rows = (unwrap(await db.from("users").select("id").in("id", ids), "pool") ?? []);\nif (rows.length === 0) return;`,
  },
  {
    name: "routed through selectAllPages (paginating helper)",
    flagged: false,
    src: `const rows = await selectAllPages(db.from("availability_schedules").select("id, user_id"));\nreturn rows;`,
  },

  // NOT FLAGGED: writes (a mutator reached before the select) ------------------
  {
    name: "update ... returning (mutator before select)",
    flagged: false,
    src: `const { data } = await supabaseAdmin().from("bookings").update({ status: "cancelled" }).eq("id", id).select("id");\nreturn ((data ?? []) as unknown[]).length > 0;`,
  },
  {
    name: "insert ... returning without error is a write, not a read",
    flagged: false,
    src: `const { data } = await db.from("booking_outbox").insert(rowToWrite).select("id");\nreturn (data ?? []).length;`,
  },
  {
    name: "multi-level write builder (base.update -> gated.select)",
    flagged: false,
    src: `const base = supabaseAdmin().from("bookings").update(patch).eq("id", id);\nconst gated = base.eq("assigned_user_id", u);\nconst { data } = await gated.select("id");\nreturn ((data ?? []) as unknown[]).length > 0;`,
  },

  // NOT FLAGGED: not a supabase select ----------------------------------------
  {
    name: "non-supabase await (no .from/.select)",
    flagged: false,
    src: `const { data } = await httpClient.get("/x");\nreturn data;`,
  },
  {
    name: "count head:true (binds count, not data)",
    flagged: false,
    src: `const { count } = await db.from("bookings").select("id", { count: "exact", head: true }).eq("bucket_id", b);\nif (count) x();`,
  },

  // NOT FLAGGED: documented escape hatch --------------------------------------
  {
    name: "error-ok opt-out on the line above",
    flagged: false,
    src: `// error-ok: best-effort worklist; a read error skips this tick and retries next\nconst { data } = await db.from("pending_event_deletions").select("*").limit(n);\nreturn (data ?? []);`,
  },
  {
    name: "error-ok opt-out inside a multi-line comment block",
    flagged: false,
    src: `// a read failure here falls back to a safe re-route,\n// error-ok: so a transient error must not throw and block the reschedule\nconst { data } = await db.from("availability_schedules").select("timezone").eq("user_id", u).limit(1);\nreturn (data ?? [])[0];`,
  },
];

for (const f of FIXTURES) {
  const found = scanSwallowedErrorReads(f.src, "fixture").length > 0;
  assert(found === f.flagged, `${f.flagged ? "flags" : "allows"}: ${f.name}`);
}

// --- the scan surface: availability, booking, google, routing (#865) ----------

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) continue; // both dirs are flat; the issue scopes /*
    if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(join(dir, e.name));
  }
  return out;
}

const surface = [
  ...tsFiles(join(ROOT, "src", "lib", "availability")),
  ...tsFiles(join(ROOT, "src", "lib", "booking")),
  ...tsFiles(join(ROOT, "src", "lib", "google")),
  ...tsFiles(join(ROOT, "src", "lib", "routing")),
  ...tsFiles(join(ROOT, "src", "lib", "salesforce")),
  // #1036: the webhook emit path silently dropped a booking event on a swallowed
  // endpoints-read / insert error because it sat outside this scanner's scope.
  ...tsFiles(join(ROOT, "src", "lib", "webhooks")),
];
assert(surface.length > 0, `found source files to scan (got ${surface.length})`);

// --- real-file mutation control: stripping the opt-outs MUST be caught --------
// booking/service.ts carries the `// error-ok:` opt-outs on its deliberately
// null-tolerant reads. Strip them and those real reads become swallowed-error
// reads the guard MUST flag. Proves it verifies something against the real code
// and cannot rot into a no-op.
const servicePath = join(ROOT, "src", "lib", "booking", "service.ts");
const serviceSrc = readFileSync(servicePath, "utf8");
assert(
  scanSwallowedErrorReads(serviceSrc, servicePath).length === 0,
  "the real booking/service.ts is clean",
);
const stripped = serviceSrc
  .split("\n")
  .filter((l) => !/^\s*\/\/\s*error-ok:/i.test(l))
  .join("\n");
assert(
  scanSwallowedErrorReads(stripped, servicePath).length > 0,
  "positive control: stripping the // error-ok: opt-outs is caught",
);

// Same real-file mutation control on the newly-scanned sync path (#865):
// google/sync.ts carries the `// error-ok:` opt-outs on its deliberately
// null-tolerant reads. Strip them and those real reads must be flagged, proving
// the guard actually reaches src/lib/google and isn't a no-op there.
const syncPath = join(ROOT, "src", "lib", "google", "sync.ts");
const syncSrc = readFileSync(syncPath, "utf8");
assert(
  scanSwallowedErrorReads(syncSrc, syncPath).length === 0,
  "the real google/sync.ts is clean",
);
const syncStripped = syncSrc
  .split("\n")
  .filter((l) => !/^\s*\/\/\s*error-ok:/i.test(l))
  .join("\n");
assert(
  scanSwallowedErrorReads(syncStripped, syncPath).length > 0,
  "positive control: stripping google/sync.ts's // error-ok: opt-outs is caught",
);

// A second control on the availability file: the exact #277 regression shape
// (a `const { data } = await ...select()` that ignores error) appended to the
// real precompute.ts must be flagged.
const precomputePath = join(ROOT, "src", "lib", "availability", "precompute.ts");
const precomputeSrc = readFileSync(precomputePath, "utf8");
assert(
  scanSwallowedErrorReads(precomputeSrc, precomputePath).length === 0,
  "the real availability/precompute.ts is clean",
);
const reintroduced =
  precomputeSrc +
  `\nasync function _regression() {\n  const { data } = await supabaseAdmin().from("bucket_slots").select("payload").eq("bucket_code", c);\n  return data;\n}\n`;
assert(
  scanSwallowedErrorReads(reintroduced, precomputePath).length > 0,
  "positive control: a reintroduced swallowed-error availability read is caught",
);

// A control on the newly-scanned salesforce path (#963): salesforce/sync.ts
// routes its roster reads through `unwrap` (no `// error-ok:` opt-outs to strip),
// so append the exact #277 regression shape and confirm the guard flags it,
// proving the scan actually reaches src/lib/salesforce and isn't a no-op there.
const sfSyncPath = join(ROOT, "src", "lib", "salesforce", "sync.ts");
const sfSyncSrc = readFileSync(sfSyncPath, "utf8");
assert(
  scanSwallowedErrorReads(sfSyncSrc, sfSyncPath).length === 0,
  "the real salesforce/sync.ts is clean",
);
const sfReintroduced =
  sfSyncSrc +
  `\nasync function _regression() {\n  const { data } = await supabaseAdmin().from("users").select("id, email").eq("org_id", o);\n  return data;\n}\n`;
assert(
  scanSwallowedErrorReads(sfReintroduced, sfSyncPath).length > 0,
  "positive control: a reintroduced swallowed-error salesforce read is caught",
);

// A control on the newly-scanned webhook path (#1036): webhooks/emit.ts routes
// its critical endpoints read through a checked `error` (throw) and carries
// `// error-ok:` opt-outs on its best-effort sweep/resend/replay reads. Append
// the exact #277 regression shape and confirm the guard flags it, proving the
// scan actually reaches src/lib/webhooks and isn't a no-op there.
const emitPath = join(ROOT, "src", "lib", "webhooks", "emit.ts");
const emitSrc = readFileSync(emitPath, "utf8");
assert(
  scanSwallowedErrorReads(emitSrc, emitPath).length === 0,
  "the real webhooks/emit.ts is clean",
);
const emitReintroduced =
  emitSrc +
  `\nasync function _regression() {\n  const { data } = await supabaseAdmin().from("webhook_deliveries").select("id, status").eq("endpoint_id", e);\n  return data;\n}\n`;
assert(
  scanSwallowedErrorReads(emitReintroduced, emitPath).length > 0,
  "positive control: a reintroduced swallowed-error webhook read is caught",
);

// --- repo invariant: the whole scan surface is clean --------------------------

let siteCount = 0;
for (const file of surface) {
  const src = readFileSync(file, "utf8");
  const findings = scanSwallowedErrorReads(src, file.slice(ROOT.length + 1));
  siteCount += findings.length;
  for (const fnd of findings) {
    assert(
      false,
      `${fnd.file}:${fnd.line} awaited select destructured for \`${fnd.binding}\` without consulting \`error\`; ` +
        `route it through unwrap (src/lib/db/result.ts), also destructure \`error\` and check it, ` +
        `or annotate // error-ok: <reason> if it deliberately tolerates a null/empty result [${fnd.snippet}]`,
    );
  }
}
if (siteCount === 0) {
  console.log(
    `ok: no swallowed-error reads across ${surface.length} availability, booking, google, routing, and salesforce source files`,
  );
}

finish();

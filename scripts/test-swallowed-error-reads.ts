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
// #1629 widened it in BOTH directions at once, because widening either alone
// would have fixed nothing:
//
//   - the SHAPE. The scanner only saw `const { data } = await ...`. The two sites
//     #1629 is about are written as `const [aRes, bRes] = await Promise.all([...])`
//     followed by `(aRes.data ?? [])`, which produces no such destructure. One of
//     them, `staffing-depth-load.ts`, has been INSIDE the scanned paths since #865
//     with four swallowed reads in it, and this guard reported clean over it every
//     single run. A guard blind to the shape reads exactly like a clean tree.
//   - the PATHS, now including the whole `src/app/admin` tree. That surface is
//     where the empty answer is most convincing ("no agents", "no buckets",
//     "nobody is in this pool", "nothing was ever sent to Regal" are all
//     legitimate readings, several of them alarming), and several of those panels
//     sit beside a control that writes back what they show.
//
// #1647 and #1648 widened the PATHS again, and each carries its own revert
// control, because a widened path list and a path list that reaches nothing
// produce the same clean tree (L98):
//
//   - #1647, `src/app/me` recursively: the agent's own page reads the schedule
//     and its rules, renders them as a form, and REPLACES every rule on save, so
//     an unreadable read draws a plausible week that is not theirs over hours one
//     press is about to destroy;
//   - #1648, `src/lib/provision.ts`, ONE FILE rather than a directory, since
//     src/lib is not scanned wholesale. It ran read then insert three times on
//     the LOGIN path with every read swallowed, so a transient failure created a
//     second organization or a duplicate users row.
//
// Both controls assert an EXACT finding count, so a scanner that flagged
// everything could not satisfy them.
//
// #1641 added the two shapes where the result never gets a NAME at all: the
// inline `(await ...).data`, and a loop over an awaited `Promise.all` wave
// reading each element's `.data`. The second is the weak-match booking lookup,
// where an unreadable query resolved to an empty candidate list, which is not
// "no failure" but the specific answer "this lead has no call booked", so the
// dedupe gate passed and a SECOND booking was created for someone who already
// had one. Both were invisible to every earlier shape for the same reason, which
// is why they are guarded together.
//
// Widening the paths flagged 22 further reads across the admin tree. They were
// triaged one at a time, not blanket-annotated: nineteen turned out to be the
// "empty is indistinguishable from an answer" class and now `unwrap` (three of
// them were fail-open authorization or write-branch decisions), and three are
// genuinely safe degrades carrying an `// error-ok:` that names the safe path.
//
// #2511 and #2383 are ONE widening, deliberately made together, because fixing
// either alone would have left the other reading as covered. The guard had grown
// one directory per incident (#865, #963, #1036, #1629, #1647, #1648, #1674), so
// what was not yet on the list was exempt from the check meant to catch it (L96),
// and the two surfaces left off it are the two where an empty answer is least
// distinguishable from a healthy one:
//
//   - src/lib/monitor (#2511). A detector that scores a failed query as "nothing
//     found" reports health it never measured. #1134 (a recovery notice posted
//     off a query that never ran) and #1152 (three worklist reads whose zero read
//     as "under the cap" and cleared a streak that would have paged) were both
//     this class, both here, and both found by hand. The tree is clean today, and
//     a clean tree is what a path list reaching nothing also produces, so the
//     control below reverts the real tier-staffing roster read.
//   - src/app/api/cron (#2383). Two daily digests read a failed query as an empty
//     day. Neither lane gets a second attempt: the approvals window is yesterday
//     relative to the clock, so a day it drops falls out of every later run.
//
// Five reads were flagged, four of them time off lanes, and every one turned out
// to be the "empty is indistinguishable from an answer" class rather than a safe
// degrade, so all five were fixed and none annotated.
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
  // #1165: the bare `await q` form (no trailing method call) was invisible to the
  // builder resolution until the count guard's fixtures caught the gap. It was
  // hiding a real swallowed-error read in webhooks/emit.ts, so the guard was
  // reporting clean over an instance of the very bug it exists to catch.
  {
    name: "builder terminal await with NO trailing call (bare await q)",
    flagged: true,
    src: `let q = db.from("webhook_endpoints").select("*").eq("org_id", o);\nif (id) q = q.eq("id", id);\nconst { data: endpoints } = await q;\nreturn (endpoints ?? []).length;`,
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

  // FLAGGED: the RESULT-OBJECT member read (#1629) ------------------------------
  // The shape both sites in #1629 were written in, and the reason widening the
  // scanned PATHS alone would have fixed nothing: src/lib/routing has been in
  // scope since #865, and staffing-depth-load.ts sat inside it reading four
  // tables this way with the guard reporting clean over it.
  {
    name: "Promise.all result object, .data read later, .error never read",
    flagged: true,
    src: `const [usersRes, bucketsRes] = await Promise.all([\n  db.from("users").select("*").eq("org_id", o),\n  db.from("buckets").select("*").eq("org_id", o),\n]);\nconst users = (usersRes.data ?? []) as User[];\nconst buckets = (bucketsRes.data ?? []) as Bucket[];`,
  },
  {
    name: "a leading // comment WITH COMMAS does not shift the element alignment",
    flagged: true,
    // The admin page's own shape. Split naively, the comment's two commas make
    // three elements and every later name lands on the wrong query.
    src: `const [aRes, bRes] = await Promise.all([\n  // Exclude the synthetic agent, the bookable count, and the pickers fed by it.\n  db.from("users").select("*"),\n  db.from("buckets").select("*"),\n]);\nreturn (bRes.data ?? []).length + (aRes.data ?? []).length;`,
  },
  {
    name: "a bare BUILDER NAME as the Promise.all element, defined on an earlier line",
    flagged: true,
    src: `let bucketsQuery = db.from("buckets").select("*");\nif (orgId) bucketsQuery = bucketsQuery.eq("org_id", orgId);\nconst [bucketsRes] = await Promise.all([bucketsQuery]);\nreturn (bucketsRes.data ?? []) as Bucket[];`,
  },
  {
    name: "a single awaited result bound to a name, .data read later",
    flagged: true,
    src: `const usersRes = await db.from("users").select("id, email").eq("org_id", o);\nconst users = (usersRes.data ?? []) as User[];\nreturn users.length;`,
  },

  // NOT FLAGGED: the same shape with `.error` actually consulted ---------------
  {
    name: "result object whose .error is checked somewhere in the file",
    flagged: false,
    src: `const [usersRes] = await Promise.all([db.from("users").select("*")]);\nconst unreadable = usersRes.error != null;\nconst users = (usersRes.data ?? []) as User[];\nreturn { users, unreadable };`,
  },
  {
    name: "result object never consumed as .data (nothing reads the rows)",
    flagged: false,
    src: `const [pingRes] = await Promise.all([db.from("users").select("id").limit(1)]);\nreturn pingRes != null;`,
  },
  {
    name: "result object from a WRITE (mutator before the select)",
    flagged: false,
    src: `const [updRes] = await Promise.all([db.from("bookings").update(patch).eq("id", id).select("id")]);\nreturn ((updRes.data ?? []) as unknown[]).length > 0;`,
  },
  {
    name: "result object carrying an error-ok opt-out above the binding",
    flagged: false,
    src: `// error-ok: a read error leaves the panel blank and the next tick refills it\nconst [rowsRes] = await Promise.all([db.from("bucket_slots").select("payload")]);\nreturn (rowsRes.data ?? []).length;`,
  },
  {
    name: "result object carrying an error-ok opt-out above the .data read",
    flagged: false,
    src: `const [rowsRes] = await Promise.all([db.from("bucket_slots").select("payload")]);\ndoSomethingElse();\n// error-ok: an unreadable cache re-routes to a cold compute below\nconst rows = (rowsRes.data ?? []);\nreturn rows.length;`,
  },
  {
    name: "a non-supabase awaited result bound to a name",
    flagged: false,
    src: `const res = await fetch(url);\nconst body = res.data;\nreturn body;`,
  },

  // FLAGGED: the UNNAMED result (#1641) --------------------------------------
  // Neither of the shapes above needs a name to exist; these are the two where
  // the result never gets one, so `.error` cannot be consulted anywhere.
  {
    name: "inline (await ...).data, the result never bound at all",
    flagged: true,
    src: `const buckets = ((await db.from("buckets").select("*").in("id", ids)).data ?? []) as Bucket[];\nreturn buckets.length;`,
  },
  {
    name: "inline (await ...).data wrapped across lines",
    flagged: true,
    src: `const manager = (\n  await db\n    .from("users")\n    .select("name, email")\n    .eq("id", managerId)\n    .maybeSingle()\n).data as User | null;\nreturn manager;`,
  },
  {
    name: "a loop over an awaited Promise.all wave, reading each result's .data",
    flagged: true,
    // The weak-match booking lookup's own shape: the wave is built by pushing
    // onto an array, so no element names a table until `base` is resolved.
    src: `const base = () => db.from("bookings").select("*").limit(20);\nconst queries = [];\nif (a) queries.push(base().eq("external_id", a));\nif (b) queries.push(base().eq("salesforce_id", b));\nconst results = await Promise.all(queries);\nfor (const r of results) {\n  for (const row of (r.data ?? [])) byId.set(row.id, row);\n}\nreturn [...byId.values()];`,
  },
  {
    name: "a loop over an awaited Promise.all ARRAY LITERAL of selects",
    flagged: true,
    src: `const results = await Promise.all([\n  db.from("users").select("*"),\n  db.from("buckets").select("*"),\n]);\nfor (const r of results) rows.push(...(r.data ?? []));\nreturn rows;`,
  },

  // NOT FLAGGED: the unnamed shapes, done correctly or opted out --------------
  {
    name: "inline await routed through unwrap (no bare .data)",
    flagged: false,
    src: `const buckets = (unwrap(await db.from("buckets").select("*").in("id", ids), "join") ?? []) as Bucket[];\nreturn buckets.length;`,
  },
  {
    name: "inline await on a WRITE (mutator before the select)",
    flagged: false,
    src: `const ids = ((await db.from("bookings").update(patch).eq("id", id).select("id")).data ?? []) as Row[];\nreturn ids.length;`,
  },
  {
    name: "inline await on something that is not a supabase chain",
    flagged: false,
    src: `const body = (await httpClient.get("/x")).data;\nreturn body;`,
  },
  {
    name: "inline await carrying an error-ok opt-out above it",
    flagged: false,
    src: `// error-ok: a decorative org name; the next recompute refills it\nconst name = (await db.from("organizations").select("name").maybeSingle()).data;\nreturn name;`,
  },
  {
    name: "loop over a wave whose results are unwrapped one at a time",
    flagged: false,
    src: `const base = () => db.from("bookings").select("*").limit(20);\nconst queries = [];\nqueries.push(base().eq("external_id", a));\nconst results = await Promise.all(queries);\nfor (const r of results) {\n  for (const row of (unwrap(r, "lookup") ?? [])) byId.set(row.id, row);\n}\nreturn [...byId.values()];`,
  },
  {
    name: "loop over a wave of NON-supabase promises that happen to carry .data",
    flagged: false,
    src: `const queries = urls.map((u) => httpClient.get(u));\nconst results = await Promise.all(queries);\nfor (const r of results) rows.push(...(r.data ?? []));\nreturn rows;`,
  },
  {
    name: "loop whose results DO have their .error consulted",
    flagged: false,
    src: `const results = await Promise.all([db.from("users").select("*")]);\nfor (const r of results) {\n  if (r.error) throw r.error;\n  rows.push(...(r.data ?? []));\n}\nreturn rows;`,
  },
  {
    name: "loop over a wave carrying an error-ok opt-out above the binding",
    flagged: false,
    src: `// error-ok: best-effort prefetch; an unreadable wave leaves the cache cold and the next tick refills it\nconst results = await Promise.all([db.from("users").select("*")]);\nfor (const r of results) rows.push(...(r.data ?? []));\nreturn rows;`,
  },
  {
    name: "loop over a plain array that was never an awaited wave",
    flagged: false,
    src: `const results = cachedResponses;\nfor (const r of results) rows.push(...(r.data ?? []));\nreturn rows;`,
  },
];

for (const f of FIXTURES) {
  const found = scanSwallowedErrorReads(f.src, "fixture").length > 0;
  assert(found === f.flagged, `${f.flagged ? "flags" : "allows"}: ${f.name}`);
}

// --- the scan surface: availability, booking, google, routing (#865), ooo (#1674) ---

function tsFiles(dir: string, recursive = false): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (recursive) out.push(...tsFiles(join(dir, e.name), true));
      continue; // the lib dirs are flat; the issue scopes /*
    }
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
  // #1629: the whole /admin tree, recursively (it is nested, unlike the lib dirs
  // above). The admin surface is where the empty answer is most convincing:
  // "no agents", "no buckets", "nobody in this pool", "nothing was ever sent to
  // Regal" are all legitimate readings, several of them alarming, and two of them
  // sit beside a control that would write the empty reading back as fact.
  ...tsFiles(join(ROOT, "src", "app", "admin"), true),
  // #1647: the agent's own page, for the same reason the admin tree came in, on
  // the same tables. `/me` reads the schedule and its rules, renders them as a
  // form, and REPLACES every rule for the schedule on save, so an unreadable
  // read draws a week that is not this agent's and one press destroys the real
  // one. The admin twin of that exact read was fixed by #1629 while this one
  // stayed outside the scan, which is the shape of a class that reads as closed
  // (L30, L247).
  ...tsFiles(join(ROOT, "src", "app", "me"), true),
  // #1648: provisioning, a single FILE rather than a directory (src/lib is not
  // scanned wholesale). It sat outside every scanned path while running read then
  // insert three times on the LOGIN path with all three reads swallowed, so a
  // transient failure created a second organization (which mis scopes every
  // bucket lookup, since resolveBucketByCode matches globally by code) or a
  // duplicate users row (which splits one person's identity across the roster,
  // the bookable pool and the manager link).
  join(ROOT, "src", "lib", "provision.ts"),
  // #1674: the time off tree. `listActiveRequests` returned `(data ?? [])`, so a
  // failed read reached the overlap guard behind the time off form as a clear
  // calendar and an overlapping absence was accepted; `loadRequest` and
  // `getUser` turned a failed read into "Request not found." and "The requesting
  // agent no longer exists.", both claims about rows nothing measured; and
  // `agentPrimaryCalendarId` fell back to "primary" on error, writing the block
  // to a calendar the agent may not be booked against. All four sat outside
  // every scanned path, so the guard reported clean over the whole folder.
  ...tsFiles(join(ROOT, "src", "lib", "ooo")),
  // #2511: the monitoring tree. A swallowed read is hardest to notice here,
  // because a detector that scores a failed query as "nothing found" reports
  // health it never measured and the silence is indistinguishable from a healthy
  // system. Both #1134 (`loadFailingAgents` returning `[]`, which posted a
  // recovery notice off a query that never ran) and #1152 (three self heal
  // worklist reads returning `[]`, which read as "under the cap" and cleared a
  // streak that would have paged) were this exact class, both in monitoring, and
  // both found by hand rather than by this guard.
  ...tsFiles(join(ROOT, "src", "lib", "monitor")),
  // #2383: the cron routes, recursively (each lane is its own directory). Two
  // daily digests read a failed query as an empty day: the approvals lane
  // answered `{ sent: false, count: 0 }` under a comment saying "Skip silently on
  // empty days", and the pending lane answered `{ sent: 0, pending: 0 }`, so a
  // PostgREST failure at 7am or 9am ET meant no CSV and no manager nudged, on a
  // 200 that looked like a quiet morning.
  ...tsFiles(join(ROOT, "src", "app", "api", "cron"), true),
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

// A control on the newly-scanned time off path (#1674): ooo/service.ts routes
// its four reads through `unwrap` or through an explicitly checked `error` that
// returns null. Put `listActiveRequests` back the way it was, as `(data ?? [])`,
// and the guard must catch it, proving the scan actually reaches src/lib/ooo and
// isn't a no-op there. That read is the one worth controlling on: an empty array
// is the specific answer "this agent has no time off booked", so the overlap
// guard passed on a read that never ran.
const oooServicePath = join(ROOT, "src", "lib", "ooo", "service.ts");
const oooServiceSrc = readFileSync(oooServicePath, "utf8");
assert(
  scanSwallowedErrorReads(oooServiceSrc, oooServicePath).length === 0,
  "the real ooo/service.ts is clean",
);
const oooReverted = oooServiceSrc.replace(
  "const { data, error } = await db()",
  "const { data } = await db()",
);
assert(
  oooReverted !== oooServiceSrc,
  "the ooo revert control actually changed ooo/service.ts (else it proves nothing)",
);
assert(
  scanSwallowedErrorReads(oooReverted, oooServicePath).length === 1,
  "positive control: the reverted active-requests read is caught",
);

// A control on the newly-covered SHAPE (#1629), driven off the real file the
// issue was filed about. staffing-depth-load.ts now routes its four reads through
// `unwrap`; put them back as `(<name>Res.data ?? [])` and the guard must catch all
// four. This is the control that matters most here, because src/lib/routing has
// been in the scanned paths since #865 and the guard reported it CLEAN the whole
// time those four reads were swallowing errors: a scanner blind to the shape reads
// exactly like a clean tree (L1, L98).
const depthPath = join(ROOT, "src", "lib", "routing", "staffing-depth-load.ts");
const depthSrc = readFileSync(depthPath, "utf8");
assert(
  scanSwallowedErrorReads(depthSrc, depthPath).length === 0,
  "the real routing/staffing-depth-load.ts is clean",
);
const depthReverted = depthSrc
  .replace(/unwrap\((\w+Res), "[^"]*"\)/g, "$1.data")
  // The busy-block read goes through selectAllPages and is not part of this shape.
  .replace(/import \{ unwrap \} from "@\/lib\/db\/result";\n/, "");
assert(
  depthReverted !== depthSrc,
  "the revert control actually changed staffing-depth-load.ts (else it proves nothing)",
);
const depthFindings = scanSwallowedErrorReads(depthReverted, depthPath);
assert(
  depthFindings.length === 4,
  `positive control: reverting loadTierDepths' four unwraps is caught (got ${depthFindings.length})`,
);
assert(
  depthFindings.every((f) => f.shape === "result-object"),
  "the reverted reads are caught as the result-object shape, not by accident as a destructure",
);

// A control on the newly-scanned provisioning file (#1648): provision.ts routes
// its three reads through `unwrap` and carries one `// error-ok:` opt-out on the
// cosmetic avatar refresh. Append the exact #277 regression shape and confirm the
// guard flags it, proving the scan actually reaches src/lib/provision.ts. A single
// FILE is easy to add to the surface list and just as easy to add in a way that
// never matches anything, which reads exactly like a clean file (L98).
const provisionPath = join(ROOT, "src", "lib", "provision.ts");
const provisionSrc = readFileSync(provisionPath, "utf8");
assert(
  scanSwallowedErrorReads(provisionSrc, provisionPath).length === 0,
  "the real provision.ts is clean",
);
const provisionReintroduced =
  provisionSrc +
  `\nasync function _regression() {\n  const { data } = await supabaseAdmin().from("organizations").select("*").limit(1).maybeSingle();\n  return data;\n}\n`;
const provisionFindings = scanSwallowedErrorReads(provisionReintroduced, provisionPath);
// An exact count, not "some findings": one planted read must produce exactly one
// finding, or the control is equally satisfied by a scanner that flags the whole
// file, which would hide the real reads going unguarded (L63).
assert(
  provisionFindings.length === 1,
  `positive control: a reintroduced swallowed-error provisioning read is caught (got ${provisionFindings.length})`,
);
assert(
  provisionFindings[0].shape === "destructure" &&
    provisionFindings[0].snippet.includes('.from("organizations")'),
  `the finding names the planted read (got: ${provisionFindings[0]?.snippet})`,
);
assert(
  surface.some((f) => f === provisionPath),
  "src/lib/provision.ts is really in the scanned surface, not merely controlled for",
);

// And the shape's own alignment, on the real admin page: each finding must name a
// read that is really there. A scanner that names the WRONG read is worse than one
// that names none, because the reader goes and looks at code that is fine.
const adminPagePath = join(ROOT, "src", "app", "admin", "page.tsx");
const adminSrc = readFileSync(adminPagePath, "utf8");
assert(
  scanSwallowedErrorReads(adminSrc, adminPagePath).length === 0,
  "the real admin/page.tsx is clean",
);
const adminReverted = adminSrc.replace(
  /const rosterUnreadable = usersRes\.error != null;/,
  "const rosterUnreadable = false;",
);
assert(
  adminReverted !== adminSrc,
  "the admin revert control actually changed page.tsx (else it proves nothing)",
);
const adminFindings = scanSwallowedErrorReads(adminReverted, adminPagePath);
assert(
  adminFindings.some((f) => f.binding === "usersRes.data"),
  "positive control: dropping the admin page's only usersRes.error check is caught",
);
assert(
  adminFindings.every((f) => f.snippet.includes('.from("users")')),
  `the finding names the read it is about (got: ${adminFindings.map((f) => f.snippet).join(" | ")})`,
);

// #1647: the same control on the newly added path. A widened path list and a
// path list that reaches nothing produce the same clean tree (L98), so the real
// /me page has its schedule read put back the way it was and the guard must
// catch it. It also pins the direction the widening was for: the schedule read
// is the one whose empty answer draws a plausible default week over hours that
// are about to be replaced.
// #2107 moved the page to its own address; the directory above is scanned
// recursively so the coverage is unchanged, but a control that names a file has
// to follow it, or it reverts nothing and proves nothing (L100).
const mePagePath = join(ROOT, "src", "app", "me", "my-availability", "page.tsx");
const meSrc = readFileSync(mePagePath, "utf8");
assert(
  scanSwallowedErrorReads(meSrc, mePagePath).length === 0,
  "the real my-availability page is clean",
);
const meReverted = meSrc.replace(
  /const \{ data: schedule, error: schedErr \} = await db/,
  "const { data: schedule } = await db",
);
assert(
  meReverted !== meSrc,
  "the availability revert control actually changed the page (else it proves nothing)",
);
const meFindings = scanSwallowedErrorReads(meReverted, mePagePath);
// #1648 tightened this from `.some(...)` to an exact count, for the same reason
// the provisioning control above carries one: reverting ONE read must produce ONE
// finding, or a scanner flagging everything satisfies the control just as well.
assert(
  meFindings.length === 1,
  `positive control: dropping the /me schedule read's error binding is caught (got ${JSON.stringify(
    meFindings.map((f) => f.snippet),
  )})`,
);
assert(
  meFindings[0].shape === "destructure" &&
    meFindings[0].snippet.includes('.from("availability_schedules")'),
  `the finding names the /me schedule read (got: ${meFindings[0]?.snippet})`,
);

// A control on the two UNNAMED shapes (#1641), driven off the real file the issue
// was filed about. booking/service.ts now unwraps both the weak-match wave and the
// bucket join in queryBookings; put each back the way it was and the guard must
// catch it, and catch it as the shape that was blind to it. Without this the new
// shapes are indistinguishable from a scanner that reads nothing: the tree is
// clean either way (L1, L98).
const loopReverted = serviceSrc.replace(
  /const rows = unwrap\(r, "person booking lookup"\) as Booking\[\] \| null;\n(\s*)for \(const row of rows \?\? \[\]\)/,
  "const rows = r.data as Booking[] | null;\n$1for (const row of rows ?? [])",
);
assert(
  loopReverted !== serviceSrc,
  "the weak-match revert control actually changed service.ts (else it proves nothing)",
);
const loopFindings = scanSwallowedErrorReads(loopReverted, servicePath);
assert(
  loopFindings.length === 1 && loopFindings[0].shape === "result-loop",
  `positive control: the reverted weak-match lookup is caught as result-loop (got ${JSON.stringify(
    loopFindings.map((f) => f.shape),
  )})`,
);
assert(
  loopFindings[0].binding === "r.data",
  `the result-loop finding names the loop variable it is about (got ${loopFindings[0].binding})`,
);

const inlineReverted = serviceSrc.replace(
  /\(\(unwrap\(\n(\s*)await supabaseAdmin\(\)\.from\("buckets"\)\.select\("\*"\)\.in\("id", bucketIds\),\n\s*"queryBookings bucket join",\n\s*\) \?\? \[\]\) as Bucket\[\]\)/,
  '((await supabaseAdmin().from("buckets").select("*").in("id", bucketIds)).data ?? []) as Bucket[]',
);
assert(
  inlineReverted !== serviceSrc,
  "the bucket-join revert control actually changed service.ts (else it proves nothing)",
);
const inlineFindings = scanSwallowedErrorReads(inlineReverted, servicePath);
assert(
  inlineFindings.length === 1 && inlineFindings[0].shape === "inline-await",
  `positive control: the reverted bucket join is caught as inline-await (got ${JSON.stringify(
    inlineFindings.map((f) => f.shape),
  )})`,
);
assert(
  inlineFindings[0].snippet.includes('.from("buckets")'),
  `the inline-await finding names the read it is about (got: ${inlineFindings[0].snippet})`,
);

// And the same on availability/service.ts, on the bucket lookup the booker itself
// makes. It used to revert the empty-bucket sweep's roster read, which #2505
// deleted with the sweep; re-pointed rather than dropped, because a control that
// stops exercising the real tree is a positive control in name only (L1). A
// swallowed error here reads as "no such bucket", which is a 404 for a lead whose
// booking link is perfectly good.
const availServicePath = join(ROOT, "src", "lib", "availability", "service.ts");
const availServiceSrc = readFileSync(availServicePath, "utf8");
assert(
  scanSwallowedErrorReads(availServiceSrc, availServicePath).length === 0,
  "the real availability/service.ts is clean",
);
const availReverted = availServiceSrc.replace(
  /const row = unwrap\(\n\s*await db\n(\s|\S)*?"bucket by code",\n\s*\);/,
  'const row = (await db.from("buckets").select("*, event_types(*)").eq("code", code).maybeSingle()).data;',
);
assert(
  availReverted !== availServiceSrc,
  "the bucket-lookup revert control actually changed availability/service.ts (else it proves nothing)",
);
assert(
  scanSwallowedErrorReads(availReverted, availServicePath).some((f) => f.shape === "inline-await"),
  "positive control: the reverted bucket lookup is caught as inline-await",
);

// A control on the newly scanned monitoring tree (#2511). The tree is clean
// today, and a clean tree is exactly what a path list that reaches nothing also
// produces (L1, L98), so the control drives the real file the issue names.
// `tier-staffing-load.ts` unwraps the roster read the debt tier alarm judges;
// put it back as a swallowed destructure and the guard must catch it, and catch
// exactly one read, or a scanner flagging the whole file would satisfy this just
// as well. The direction matters too: an empty roster there reads as zero agents
// in every tier, which pages five tiers at once off a query that never ran.
const tierLoadPath = join(ROOT, "src", "lib", "monitor", "tier-staffing-load.ts");
const tierLoadSrc = readFileSync(tierLoadPath, "utf8");
assert(
  scanSwallowedErrorReads(tierLoadSrc, tierLoadPath).length === 0,
  "the real monitor/tier-staffing-load.ts is clean",
);
const tierLoadReverted = tierLoadSrc.replace(
  /const rows = \(unwrap\(\n(\s|\S)*?"tier staffing roster",\n\s*\) \?\? \[\]\)/,
  'const { data: rows } = await db\n    .from("users")\n    .select("id, attributes")\n    .eq("bookable", true)',
);
assert(
  tierLoadReverted !== tierLoadSrc,
  "the tier staffing revert control actually changed tier-staffing-load.ts (else it proves nothing)",
);
const tierLoadFindings = scanSwallowedErrorReads(tierLoadReverted, tierLoadPath);
assert(
  tierLoadFindings.length === 1,
  `positive control: the reverted tier staffing roster read is caught (got ${JSON.stringify(
    tierLoadFindings.map((f) => f.snippet),
  )})`,
);
assert(
  tierLoadFindings[0].shape === "destructure" &&
    tierLoadFindings[0].snippet.includes('.from("users")'),
  `the finding names the planted roster read (got: ${tierLoadFindings[0]?.snippet})`,
);
assert(
  surface.some((f) => f === tierLoadPath),
  "src/lib/monitor is really in the scanned surface, not merely controlled for",
);

// A control on the newly scanned cron lanes (#2383), driven off the read the
// issue was filed about. The pending time off queue now unwraps; put it back the
// way it shipped and the guard must catch it. That read is the one worth
// controlling on, because an empty array there is the specific answer "nobody is
// waiting on a manager this morning", which the lane returns as
// `{ sent: 0, pending: 0 }` on a 200.
const digestPath = join(ROOT, "src", "app", "api", "cron", "ooo-digest", "route.ts");
const digestSrc = readFileSync(digestPath, "utf8");
assert(
  scanSwallowedErrorReads(digestSrc, digestPath).length === 0,
  "the real ooo-digest route is clean",
);
const digestReverted = digestSrc.replace(
  /const pendingRows = unwrap\(\n\s*await db\n/,
  "const { data: pendingRows } = await db\n",
);
assert(
  digestReverted !== digestSrc,
  "the pending queue revert control actually changed the digest route (else it proves nothing)",
);
const digestFindings = scanSwallowedErrorReads(digestReverted, digestPath);
assert(
  digestFindings.length === 1,
  `positive control: the reverted pending time off read is caught (got ${JSON.stringify(
    digestFindings.map((f) => f.snippet),
  )})`,
);
assert(
  digestFindings[0].shape === "destructure" &&
    digestFindings[0].snippet.includes('.from("ooo_requests")'),
  `the finding names the pending queue read (got: ${digestFindings[0]?.snippet})`,
);
assert(
  surface.some((f) => f === digestPath),
  "src/app/api/cron is really in the scanned surface, not merely controlled for",
);

// --- repo invariant: the whole scan surface is clean --------------------------

let siteCount = 0;
for (const file of surface) {
  const src = readFileSync(file, "utf8");
  const findings = scanSwallowedErrorReads(src, file.slice(ROOT.length + 1));
  siteCount += findings.length;
  for (const fnd of findings) {
    const what: Record<typeof fnd.shape, string> = {
      "result-object": `awaited select bound to a result object read later as \`${fnd.binding}\`, with its \`.error\` read nowhere`,
      "inline-await": `awaited select read inline as \`(await ...).data\`, so nothing can ever consult its \`error\``,
      "result-loop": `awaited select wave looped over, reading each result's \`${fnd.binding}\` with its \`.error\` read nowhere`,
      destructure: `awaited select destructured for \`${fnd.binding}\` without consulting \`error\``,
    };
    assert(
      false,
      `${fnd.file}:${fnd.line} ${what[fnd.shape]}; ` +
        `route it through unwrap (src/lib/db/result.ts), also read \`error\` and check it, ` +
        `or annotate // error-ok: <reason> if it deliberately tolerates a null/empty result. ` +
        `The question that decides which: not "can this read fail harmlessly" but ` +
        `"can anything downstream read the empty result as an answer?" [${fnd.snippet}]`,
    );
  }
}
if (siteCount === 0) {
  console.log(
    `ok: no swallowed-error reads across ${surface.length} availability, booking, ` +
      `google, routing, salesforce, webhook, admin, agent-page, provisioning, time off, ` +
      `monitoring and cron lane source files`,
  );
}

finish();

# Repo guard conventions, in full

The scans that keep a class of defect from reaching main, what each one
reads, what it cannot see, and the opt out each one accepts. `AGENTS.md`
carries a table of the opt outs and the rules a session needs mid task.

Moved out of `AGENTS.md` on 2026-10-15, where every character was loaded into
every session (#2393). `AGENTS.md` keeps the rule and points here; this is the
full text as it stood, with the reasoning, the incidents and the measurements
behind it.

## Capped single-page reads (the `// cap-safe:` convention)

PostgREST returns at most **one 1000-row page** per list read. Code that then
does `.length`, `.filter()`, `.map()`, or `.reduce()` on the result treats a
truncated page as the whole set, and the read silently under-counts. This class
shipped as #35 / #166 (the availability cache came back short and the booker
over-offered slots) and false-passed a #440 soak invariant. Two static guards,
both run by `pnpm test`, block a **new** capped read from reaching main:

- **`scripts/test-capped-reads.ts`** (#730) scans `scripts/loadtest/**` and
  `scripts/smoke-*.ts` for the raw `fetch(...select=...)` shape (and wrappers
  like `pgGet` / `getJson`) whose result feeds a count or aggregate. Cap-safe
  here means the read goes through the paginating `listAll` or server-side
  `count` helper (`scripts/loadtest/invariants.ts`), carries an explicit
  `limit=`, is a single-row `rows[0]` grab rather than an aggregate, or carries
  the opt-out below.

- **`scripts/test-src-capped-reads.ts`** (#822) scans production `src/` for the
  supabase-js `.from("t").select(...)` shape that the fetch detector cannot see.
  It only flags reads on a **growth table** (see below).

The scan logic for each lives beside it in `scripts/lib/scan-capped-reads.ts`
and `scripts/lib/scan-src-capped-reads.ts`, so both are unit-testable, and each
guard carries a positive control proving it still catches the bad pattern.

**To fix a flagged `src/` read**, paginate it (`selectAllPages`,
`src/lib/supabase/paginate.ts`) or give the chain a bounding signal. A
growth-table SELECT is cap-safe when it carries ONE of:

- `.single()` / `.maybeSingle()` (at most one row),
- `.limit(...)` / `.range(...)` (an explicit bounded or paginated page),
- `.csv()` (streamed, not a row array),
- `{ ..., head: true }` (a server-side count, no rows returned),
- `.eq("id", ...)` / `.in("id", ...)` (a primary-key lookup, bounded set).

**A paged read is keyset paged (2026-10-25).** `selectAllPages` orders by the
unique key its caller names and asks each page for the rows after the last key
seen, so a row inserted or removed between page requests can neither repeat nor
skip a row (under OFFSET, one booking inserted mid read paged the buffer breach
check about a booking overlapping itself). It throws on a row missing its key and
on a key returned twice. `scripts/test-paged-read-keys.ts` holds every call site to
the rules this needs: the key covers a unique column set in the migrations and
EVERY key column is NOT NULL there (not only the unique set inside the key: a key
of `["id", "booking_id"]` covers the primary key, then throws on the first row with
a null `booking_id`), the chain carries no `.order()` of its own (sort the result
with `sortByStamp` instead), the select returns every key column under its own name
(an alias named like the key, `id:booking_id`, is refused, since the read is
ordered by the real `id` and cut on `booking_id`; `id:id` and plain `id` pass), and
a composite key's chain carries no `.or()` of its own (the helper writes the tuple
comparison as one).

A write (`.insert` / `.update` / `.delete` / `.upsert` reached before any
`.select`) is not a read and is never flagged. A reused builder
(`let q = db.from(...).select(...); ...; await q.range(...)`) is handled: a bound
applied on a later line still counts.

**The escape hatch** (both guards) is a one-line opt-out sitting on, or in the
block of `//` comment lines directly above, the read:

```ts
// cap-safe: idempotency_key is unique, so this returns at most one row
const rows = await pgGet("booking_reservations?select=id&idempotency_key=eq.abc");
```

Use it only when the set genuinely can never exceed one page, and say why.

**Growth vs roster-bounded.** The `src/` guard is table-aware. Roster-bounded
config, singleton, and lock tables are capped by the design target (100 to 200
agents, ~60 buckets) or a fixed key space, so they can never fill a page and are
never flagged. The allowlist is `SAFE_TABLES` in
`scripts/lib/scan-src-capped-reads.ts`, and the constant is its one home: each
entry carries its reason there, and no doc copies the list, because the copy
that used to sit in `AGENTS.md` drifted two tables behind (#2398).
**Every other table defaults to a growth table (flagged): a new table must be
justified, not silently unguarded.** When you add a table whose row count is
bounded by the roster rather than by booking volume or time, add it to
`SAFE_TABLES` with its reason; otherwise leave it off and make each read
cap-safe.

`alert_state` was on that list until #2726 and is deliberately NOT any more. It
was roster bounded when it held only cooldowns for lanes and buckets, and stopped
being so the day an alert was keyed by booking (`booking_offsite_origin:<id>`,
`stale_phone_invite:<id>`, `booking_below_lead_tier:<id>`): an incident never
resolves, so those rows only ever accumulated, and the one pattern read over the
table (`firingFamilyMembers`) was a single capped page. Its key reads are
`.eq("key")` / `.in("key")` lookups on the primary key, which the guard accepts
through `PRIMARY_KEYS` in the scanner; a family read pages with `selectAllPages`.
Two halves keep the table from growing again, each blind where the other looks:
every `:*` family in `src/lib/notify/alert-catalog.ts` must declare what its
suffix is (`booking`, `bounded` or `caller`), and the daily
`prune-booking-alert-state` lane deletes the rows of every `booking` family once
that booking started and was made more than a week ago, with the family list
DERIVED from the catalog so a new per booking alert is pruned by construction.
`scripts/test-alert-state-retention.ts` pins both.

## An `in` filter fed from an unbounded list (the `// in-chunk-ok:` convention)

The capped read above is about a response that comes back SHORT. This is the
opposite end of the same table: a request that never goes out at all.

`.in("id", ids)` puts every id in the QUERY STRING, so a long enough list is
**REFUSED at the transport** rather than truncated. Measured against the real prod
PostgREST on 2026-08-04 with 36 character uuids: 350 ids (13,028 bytes) is accepted,
400 (14,878) is refused, 1,000 gives a 400 and 2,000 a 414. `MAX_IN_FILTER_BYTES`
(`src/lib/db/id-batch.ts`) sits at 10,000, well inside proven good territory, which
is roughly **266 uuids** per request.

**Bytes decide, never a row count.** That number was got wrong three times, every
time by carrying a count over from a call site whose ids were a different length
(#1259, #1267, #1268). So split with **`chunkIdsByUrlBudget`**, which measures the
ids it is actually given, and run the split with **`inIdChunks`**, which owns what
happens when request three of five fails.

**Splitting without accounting is the other half of the defect** (#2388). A sweep
that deleted two batches of five and then met a refusal must never answer as though
it finished: the remainder is real work nobody else picks up, and on a redaction lane
the finished batches are irreversibly blanked. `inIdChunks` therefore THROWS a
`PartialIdSweepError` naming how many batches and ids landed, and `destroyVerified`
adds the ROW count on its way past. A per BATCH zero rows check sits inside the loop
for the same reason: a sum cannot see one component collapsing (L367).

**The four retention lanes are covered by construction, not by a comment.** Each one
reads up to `MAX_VERIFY_BATCH` (500) candidates and hands `destroyVerified` a
`destroy(ids)` callback, and 500 uuids is roughly 18.6 KB, so every lane was refused
outright the first night a retention window opened on production volume: nothing
redacted, the same 500 candidates the next night, and the retention gate freezing the
export behind a permanent failure. The split is owned INSIDE `destroyVerified`, so
the callback is handed a batch and a fifth lane cannot be written without it. A rule
every call site must opt into is enforced by nobody (L621).

**The guard** is `scripts/test-unchunked-in-filters.ts`
(`scripts/lib/scan-unchunked-in-filters.ts`), which fails the build on an `.in(` whose
value is built from a list this repo read with `selectAllPages`, or with an exported
function whose own body pages. That reader list is DERIVED by scanning the tree, so a
reader added tomorrow is covered rather than exempt (L96). Its positive control puts
the real defect back into the real monitor route in memory and requires itself to
catch it.

Its sibling `scripts/test-batch-sizes.ts` catches a list that IS split but by a
literal stride. This one catches the list that is not split at all.

**The escape hatch is `// in-chunk-ok: <why>`**, on or in the `//` block directly
above the `.in(` line, and it is refused when it carries no reason. Use it for a set
the ROSTER bounds rather than the growth table it was read from: a deduplicated agent
id list is at most 200 ids at the design target, which is 7,520 bytes against the
10,000 budget. Say which population bounds it, not just that it is small.

What the scan CANNOT see is named in its own header: a list crossing a function
boundary as a callback parameter (which is why `destroyVerified` owns its split), an
array destructure of a `Promise.all` of paginated reads, and a `.limit(n)` above the
ceiling.

## Swallowed-error reads (the `// error-ok:` convention)

A read that destructures `const { data } = await db.from("t").select(...)` and
ignores `error` fails silently: when the query errors (a missing column on a
half-applied migration), `data` comes back null, the availability pool collapses
to empty, and the booker shows NO times, a broken deploy that looks like a quiet
day. That was #277; it routed the availability-critical reads through **`unwrap`**
(`src/lib/db/result.ts`), which throws on a real error and passes a not-found
(`data: null, error: null`) through unchanged.

**`scripts/test-swallowed-error-reads.ts`** (#315) keeps that invariant from
eroding. It scans **all of `src/`** and fails on an awaited SELECT whose `error`
is never consulted. That surface is DERIVED rather than listed (#2542): it used to
be a hand written directory list grown one incident at a time, so everything not
yet on it was exempt from the check meant to catch it (L96), and nine widenings
had not made that stop happening. Eight live reads sat outside the list with the
shipped scanner flagging every one, the booker's own `is_test` refusal among them.
A file leaves the surface only through the NAMED exclusion list in that file, each
entry carrying its reason; today it holds one, `src/lib/db/schema.type-test.ts`,
which is never imported at runtime. The scan logic lives in
`scripts/lib/scan-swallowed-error-reads.ts` (unit-testable), and the guard carries
positive controls (stripping the opt-outs from the real `booking/service.ts`, and
reverting `staffing-depth-load.ts`'s four unwraps, must both be caught) so it can
never rot into a no-op.

**It reads FOUR shapes, and each was added because the previous set read a live
instance of the bug as a clean tree.** Until #1629 it saw only
`const { data } = await ...`. The second shape is the result object bound whole
and read later:

```ts
const [usersRes, bucketsRes] = await Promise.all([...]);
const users = (usersRes.data ?? []) as User[];   // and usersRes.error read NOWHERE
```

`src/lib/routing` had been in the scanned paths since #865 with
`staffing-depth-load.ts` reading four tables exactly that way, and the guard
reported clean over it on every run: a scanner blind to the shape and a clean tree
produce the same empty result (L98). So widening the paths alone would have fixed
nothing, and widening the shape alone would have left the admin surface (where the
empty answer is most convincing) unguarded. Both were widened together.

The third and fourth shapes (#1641) are the ones where the result never gets a
name at all, so no earlier shape could reach them:

```ts
const buckets = ((await db.from("buckets").select("*").in("id", ids)).data ?? []) as Bucket[];

const results = await Promise.all(queries);
for (const r of results) for (const row of (r.data ?? []) as Booking[]) byId.set(row.id, row);
```

The second of those is the weak-match booking lookup on the booking hot path. A
failed query resolved to an empty candidate list, which is not "no failure" but
the specific answer "this lead has no call booked", so the dedupe gate passed and
a SECOND booking was created for someone who already had one. There is no
compliant way to write an inline `(await ...).data` (nothing can consult an
`error` on a result that never exists as a value), so it is `unwrap` or the
opt-out.

**One shape stays deliberately out of scope**, and is named in the scanner's own
header so the next instance of it is not assumed covered: an array destructure of
object patterns, `const [{ data: a }, { data: b }] = await Promise.all([...])`.

A read is **compliant** when it does ONE of:

- routes through `unwrap(await ...)` (or a paginating helper like
  `selectAllPages`), so a real error throws;
- also destructures `error` (`const { data, error } = ...`) and checks it;
- is a write, not a list read (a `.insert`/`.update`/`.delete`/`.upsert` reached
  before the `.select(`, the "update ... returning" shape); or
- carries the `// error-ok:` escape hatch below.

**The escape hatch** is a one-line opt-out on, or in the `//` block directly
above, the destructure, for a read that DELIBERATELY tolerates a null/empty result
on error:

```ts
// error-ok: best-effort worklist; a read error skips this tick and the lane retries
const { data } = await db.from("pending_event_deletions").select("*").limit(n);
```

Use it only when a swallowed error degrades to a genuinely SAFE path (a retry next
tick, a re-route, a caller null/empty branch), and say why. A read whose swallowed
error would silently show no availability must use `unwrap` instead. On the
result-object shape the opt-out may sit above the binding OR above the `.data`
read, because the two are routinely tens of lines apart and the reason belongs
where the reader of the empty value is.

#### The count-shaped twin: `unwrapCount` (#1165)

The same defect wears a second shape. A query asked for `{ count: "exact" }`
returns `count: null` when it FAILS, and the `count ?? 0` every call site writes
turns that into a healthy-looking **"0 rows"**. A `delete({ count: "exact" })`
that never ran then reports `blocksDeleted: 0`, indistinguishable from having had
nothing to clean, which is how stale cached busy time survived the #248 backstop.

Use **`unwrapCount`** (`src/lib/db/result.ts`), the count-shaped sibling of
`unwrap`: it throws on a real `error` and passes a null count with no error
through as 0. `scripts/test-swallowed-count-results.ts` scans **all of `src/`**
and fails on an awaited supabase chain destructured for `count` without also
binding `error`. Two deliberate differences from the read guard: a **write is
flagged too** (the delete case is the headline), and `.select(` is not required.
The same `// error-ok:` escape hatch applies, and the same question decides
whether you may use it (below).

### Ask what the EMPTY result means downstream, not just what the read does

The question that decides `error-ok` vs `unwrap` is not "can this read fail
harmlessly", it is **"can anything downstream read the empty result as an
answer?"** Two classes, and the comment must say which one it is:

- **Empty degrades to a safe path.** Nothing acts on the emptiness: the tick
  skips, the caller re-routes, the value falls back to a documented default, the
  next run retries. `error-ok` is correct. Say what the safe path IS
  ("the 1-min cron backstop reconverges", "the guard re-routes"), not just
  "best effort".
- **Empty is indistinguishable from healthy, or from within-limits.** Something
  downstream treats the empty result as a real answer. Then it must fail loud
  (`unwrap`) or return an explicit unknown (`null`), never `[]` or `0`.

The second class keeps shipping because the read looks local and the consequence
is three files away. Every instance so far:

- **#277** an availability read returned empty, the pool collapsed, the booker
  showed no times and a broken deploy looked like a quiet day.
- **#1134** `loadFailingAgents` returned `[]`, which meant "no agents failing",
  which posted "calendar sync has recovered" off a query that never ran.
- **#1165** a pool-exit prune reported `blocksDeleted: 0` for a delete that
  errored, which reads as "nothing needed cleaning"; the last-admin guard scored
  a failed count as zero admins and refused with a claim it never measured; and
  the header's pending-approvals badge vanished on a broken read exactly as it
  does when the queue is empty.
- **#1629** the admin page read six tables as `(res.data ?? [])`, so an unreadable
  table drew the same screen an empty one draws (no agents, no buckets, nobody in
  any pool, nothing ever sent to Regal), and two of those blanks sat beside a
  control that would have written them back as fact. The same read shape in
  `loadTierDepths` returned an empty depth list, which `/admin/tiers` rendered as
  "No tiers yet" and which the availability canary scored as **zero staffed
  buckets** and answered a healthy **200** on. `loadTierDepths` throws now, and
  every caller maps that to an explicit unknown: the canary answers 503 with
  `staffedBuckets: null` rather than `0`.
- **#1641** the weak-match booking lookup read its query wave as
  `for (const r of results) ... (r.data ?? [])`, so a failed read arrived as "this
  lead has no call booked", the one-call-per-person gate passed, and a second
  booking was created: a second invite, a second slot consumed, `booking.created`
  fired twice. The confirmation-screen warning that was supposed to catch it runs
  the SAME query on the SAME table, so it was blind in exactly that failure
  (L345). The read `unwrap`s now and the booker REFUSES with a retriable 503,
  reversing the fail-open this path shipped with.
- **#1152** three self-heal worklist reads returned `[]`, the resulting count of
  zero read as "under the cap", and that posted "the backlog has cleared, no
  action is needed" while clearing the streak that would have paged. The same
  audit found `agentActiveBookingStartsMs` returning `[]`, which counts as "no
  bookings that day" and quietly waived an agent's daily cap.
- **#2383 and #2511** widened the scanned paths to the monitoring tree and the
  cron lanes together, because a path list grown one incident at a time leaves
  everything not yet on it exempt from the check meant to catch it (L96), and
  fixing either surface alone would have left the other reading as covered. The
  two daily time off lanes were the live cost: the approvals digest answered
  `{ sent: false, count: 0 }` under a comment saying "Skip silently on empty
  days" and the pending digest answered `{ sent: 0, pending: 0 }`, so a failed
  `ooo_requests` read at 7am or 9am ET meant no CSV and no manager nudged on a
  200 that looked like a quiet morning, with no second attempt: the approvals
  window is yesterday relative to the clock, so a dropped day falls out of every
  later run. Their two `users` reads degraded into a CSV naming nobody and a
  whole queue posted to the fallback channel as unrouted. All four `unwrap` now.
  The fifth, the monitor lane's cal.com override retry, returned "failed: agent
  has no email" for a read that never ran, a claim about the agent nothing
  measured (L11) that was written into `side_effects` and quoted in Slack; it
  gets its own outcome, which is still a failure, so the row stays in the
  candidate set and no all-clear is cleared off it.

Note the asymmetry that keeps catching people out: **`null` and `[]` are not
interchangeable.** `busyIntervalsForAgent` returns `null` for "could not tell" and
its caller re-routes on it; the daily-cap read next to it returned `[]`, borrowed
that comment, and meant the opposite.

Two guards cover the alerting end of this, both in `pnpm test`:
`scripts/test-swallowed-error-reads.ts` (the read shape) and
`scripts/test-all-clear-failure-coverage.ts` (#1152: every module that sends a
recovery notice must carry a test proving it stays silent when its health signal
cannot be read, or point at the suite that does with `// all-clear-proof:`).

## Unchecked writes in a server action (the `// write-ok:` convention)

The same defect wearing its third shape, and the one the two guards above were
blind to by construction. A server action that awaits a WRITE and throws the
result away:

```ts
await db.from("booking_settings").upsert({ id: 1, public_booking_paused: paused }, { onConflict: "id" });
await recordAudit({ action: "booking.settings", details: { public_booking_paused: paused } });
redirect(`/admin/business-hours${savedQuery("booking-paused")}`);
```

supabase-js does not throw on a statement Postgres refuses; it resolves
`{ error }`. So on a refusal (a half applied migration, an RLS or grant change, a
statement timeout) that runs to completion: the admin is shown "Online booking is
stopped", the audit trail records `public_booking_paused: true`, and the embed
keeps taking bookings. The record written to answer "were we taking bookings at
3am" answers it with a confident wrong value, which is the one question it exists
for (#2379, L529, L12). **The kill switch is the headline and the role change is
its twin**: `setUserRole` recorded `admin` to `agent` for a role that never
changed, so a revoked admin kept admin. Eleven writes in
`src/app/admin/actions.ts` were written this way.

**The class was invisible, and that is the part worth remembering.**
`scripts/test-swallowed-error-reads.ts` skips a chain whose mutator is reached
before its `.select(`, and said in its own header that a write is "a different
concern". True, and with nothing on the far side of that boundary it read as a
class somebody had handled (L400).

`scripts/test-unchecked-writes.ts` is the guard, and it is the sibling of the
read one: that one asks whether an `error` was BOUND, this one asks whether the
result of the write went anywhere at all. It scans every `src/app/**/actions.ts`
(walked, never a hand written list, so a new action file is covered by
construction) and flags an awaited Supabase chain carrying `.insert(` /
`.update(` / `.upsert(` / `.delete(` that appears as a bare EXPRESSION
STATEMENT. The result of one has nowhere to go, so nothing anywhere can consult
its `error`. Scan logic in `scripts/lib/scan-unchecked-writes.ts`.

Compliant shapes: bind `{ error }` and refuse, bind the whole result to a name,
or return it to the caller.

**Refuse BEFORE the audit entry, before `revalidatePath`, and before the success
redirect**, and say so on the page the form is on. The wording is built in one
place, `writeRefused` in `src/app/admin/actions.ts`, which also logs the full
error: eleven saves must not drift into eleven ways of saying the same thing
(L41). Which mechanism to use is decided by the ACTION, not by this rule: an
action that already refuses with `redirect(...?error=)` does that, and one that
already throws throws. A third pattern on one form is worse than either.

**The escape hatch is `// write-ok: <why>`**, on or in the `//` block directly
above the statement, for a write nothing downstream reads as having happened: no
audit entry claiming the value, no success notice, no cache invalidation standing
in for the change.

It is deliberately NOT the siblings' `// error-ok:`. Putting a second rule behind
an existing suppression token silently widens every existing use of it (L448),
and an `// error-ok:` is written about a READ: it would then exempt a write
sitting under the same comment block, which is exactly the pairing an action that
reads a row and then writes it produces. A fixture pins that.

**Scope, so a green run is never read as more than it is.** This sees the
DISCARDED result and nothing else. A result bound to a name and then never
consulted (`const res = await db.from(...).update(...)` with `res.error` read
nowhere) is the same defect and is NOT flagged: it is the result-object shape the
read scanner already covers for reads, and it has not appeared once on this
surface. If one turns up, widen the shape there rather than assuming it is
covered here.

## Raw `Date.parse` on a timestamp (the `// parse-ok:` convention)

`Date.parse` returns **NaN** for anything it cannot read, and every comparison
with NaN is false. So the check lands on the healthy / permissive branch with no
error raised anywhere: not stale, not expired, not due for retry, **does not
overlap**. #1169 found ten monitoring sites like this; #1171 found the same class
on the verify-on-book path, where an unreadable busy interval from Google read as
**free time** on the last check before a booking.

Use **`parseStampMs`** (`src/lib/date/stamp.ts`), which returns a number or
`null` and forces you to map `null` to the fail-safe side (stale for a heartbeat,
due for an expiry, "never sent" for a cooldown). For a pair of interval bounds,
`isReadableInterval` (`src/lib/booking/core.ts`) is the single judge of whether
Google gave us something usable.

`scripts/test-date-parse-guard.ts` (#1171) scans the surface where an unreadable
stamp is **indistinguishable from healthy**: `src/lib/monitor`, `src/lib/notify`,
`src/lib/snowflake`, `src/lib/google`, `src/app/api/cron`, `src/app/api/health`,
and `src/lib/booking/core.ts`. A site is compliant when it routes through
`parseStampMs`, is judged on the same line by `Number.isFinite` / `Number.isNaN`
/ `isNaN`, or carries a **`// parse-ok:`** opt-out (per line, like its siblings)
saying why NaN is impossible or safe there.

The wider booking / availability domain is deliberately **out of scope**: ~40
parses there read our own NOT NULL `timestamptz` columns, and blanket-annotating
them would trade real thought for mechanical comments (the same call made for the
table-aware capped-read guard). That boundary is stated in the guard's header so
it is never read as broader coverage than it has.

When you write the opt-out, say which way it fails. `hasBlockingBusy` fails
**closed** (a NaN bound makes the block read as blocking, never free) and that
rests entirely on its `Math.max` / `Math.min` and `os >= oe` ordering, which is
why a test pins it. Do not restructure that comparison without rechecking it.

## Departing and returning an agent (the `// lifecycle-write-ok:` convention)

One module decides which columns a departure and a return move:
**`src/lib/offboarding/lifecycle-write.ts`**. Leaving the pool stamps
`deactivated_at` AND clears `bookable`, in one statement; returning writes
`bookable` false, so re-entry to the routing pool always goes through the
activation gate.

That last clause is the part that reaches a lead. The calendar reachability probe
and the pool entry bootstrap live ONLY on the `bookable` flip
(`applyBookableByUserId`, `onboardIntoPool`), so a row that never stopped being
bookable is routable the instant somebody clears `deactivated_at`, with no probe,
no bootstrap, an empty availability cache and a retained sync token that keeps
every minute lane on an incremental pass. Dan's rule, 2026-09-14: no agent is
bookable until every one of their calendars READS.

It is a guard rather than only a helper because the rule has already been copied
badly once. #1324 fixed the offboarding service and wrote the rule down; the
hourly Salesforce reap kept its own `update({ deactivated_at })` for six weeks
(#2386), so every leaver it processed stayed marked bookable and every count of
the bookable pool overstated itself. A shared constant would not have stopped
that, because the copy never reached for the shared thing (L370).
`scripts/test-deactivation-write.ts` fails the build on a `.update(` naming
`deactivated_at` anywhere else in `src/`, following one hop through a local
`const`. The escape hatch is `// lifecycle-write-ok: <why>` on, or in the `//`
block above, the write, and it is refused when it carries no reason.

### Who writes those columns, and why Regal hears about it (#2085)

Every write to `users.bookable` or `users.deactivated_at` goes through ONE
helper, **`writeRoutableState`** in `src/lib/bookable/routable-write.ts`: the
bookable flip (`writeBookable`), the lifecycle departure and return, and the
reap's batch (`deactivateUsersByIds`). It reads the rows before, writes, reads
what it wrote from the same statement, and for every row whose `isRoutable`
value moved records an `agent.bookable_changed` delivery for Regal
(`{"userId": <email>, "traits": {"slateBookable": <bool>}}`), suppressed for an
`is_test` agent. Only on a change, so a reactivation and a flip on a departed row
send nothing. The emit lives inside the write because a rule each writer must
remember is enforced by nothing (L621): `scripts/test-routable-write-owner.ts`
fails the build on any other `src/` or `worker/` writer of either column, with a
`// routable-write-ok: <why>` hatch. SQL run by hand sends nothing;
`pnpm backfill:bookable-trait` is the repair, and what gives Regal its starting state.

A trait send states the agent's value AT THAT SEND (`payloadForSend`,
`src/lib/webhooks/agent-trait.ts`), because retries and replays reorder, and a
stale false retried after a newer true would otherwise win.

## An outbound call with no timeout of its own (the `// deadline-ok:` convention, #3972)

Cloudflare kills an invocation at hard deadlines: `after()` work 30 seconds after
the response, a scheduled tick at its own wall limit. A kill runs no catch block, so
whatever a call's failure path records or pages never happens, and a dependency that
HANGS goes silent while one that refuses is reported (L1028). So every server `fetch`
names a `signal` (usually `AbortSignal.timeout`, sized well inside the deadline it
runs under), or goes through `fetchWithinBudget`/`fetchWithDeadline`.

`scripts/test-outbound-deadlines.ts` scans `src/` and `worker/` (tests and
`"use client"` modules excluded) for a global `fetch` call whose options name no
`signal`, and for the global `fetch` handed on as a value (`fetchImpl: fetch`,
`?? fetch`, a default parameter), since the receiver calls it where the scan cannot
follow. `// deadline-ok: <why>`, on the line or in the `//` block above it, names
what bounds it instead: the deadline wrapper it is the inner fetch of, the
receiver's own timeout, or a browser.

What it cannot see: a library that makes its own requests (googleapis is bounded
through the fetch it is given, `src/lib/google/`), and a `signal` that never fires,
such as a caller's own signal with no timer behind it.

## Adding a webhook event (#1459)

`emitWebhook` delivers only to endpoints whose stored `events` array **contains**
the event (`.contains("events", [event])`). Zero matches is not an error: the map
over the empty endpoint list resolves, the outbox step is marked done, and the
event is gone with no failure, no alert, and no delivery row. So adding a value to
the `WebhookEvent` union ships it **inert**, and it stays inert until somebody
remembers a database update that lives nowhere in the repo.

The subscription is a database column no code change touches, so **both halves are
guarded, each blind where the other looks**:

- `scripts/test-webhook-event-subscribers.ts` compares the union against the
  migration **DEFAULT**, which is what a NEW endpoint is created with. It can say
  nothing about the endpoint that already exists.
- the monitor lane's `webhook_subscribers` step reads the **live rows**, which is
  the only thing that can notice the existing endpoint was never updated. The one
  live Regal endpoint predates every event added from here on.

So adding an event means three things, not one: the union in `src/lib/db/types.ts`,
the family map in `src/lib/webhooks/events.ts` (keyed on the union, so `tsc` names
the omission), and a **`webhook_endpoints.events` update on the live row**. The
FAMILY (`booking.*` or `agent.*`, #2085) decides the payload type and the Regal
body, never the endpoint format: `regal.ts` keys its event names on the booking
events only, since an agent trait carries no name.

To ship an event deliberately unsubscribed, add it to `DELIBERATELY_UNSUBSCRIBED`
(`src/lib/webhooks/events.ts`) with a reason **and the issue that will subscribe
it**; both guards then stay quiet about it and the guard rejects an entry with no
issue number. Delete the entry in the change that subscribes it.

# Slate architecture at a glance

Two coarse diagrams, because the moving parts are hard to hold in your head from the
code alone: a booking touches a cache, Google, Postgres, an outbox and a webhook
subscriber, and the freshness of what a lead sees comes from three different writers.

Deeper detail lives in `CLAUDE.md` (architecture notes), `AGENTS.md` (the rules that
bite), `docs/crash-safe-booking-mutations.md` (the durable-intent pattern) and
`docs/adr/` (the decisions).

## Booking and availability

The read path is deliberately free of Google. The one live Google call a lead's
request makes is at confirm, which is what turns a stale cache into a slower booking
rather than a double booking (ADR 0003).

```mermaid
flowchart TD
  lead(["Lead on a Pennie landing page"])
  widget["widget.js embed"]
  booker["Booker at /book"]
  avail["GET /api/availability"]
  l1[("L1 edge cache")]
  rows[("bucket_slots")]
  confirm["POST booking confirm"]
  verify{{"verify-on-book: live Google freeBusy"}}
  bookings[("bookings")]
  outbox[("booking_outbox")]
  gcal["Google Calendar event"]
  busy[("busy_blocks")]
  hook["Regal and Cadence"]

  lead --> widget --> booker
  booker --> avail
  avail --> l1
  l1 -->|"miss"| rows
  rows -->|"cold"| avail

  booker --> confirm
  confirm --> verify
  verify -->|"first free agent"| bookings
  bookings --> outbox
  outbox --> gcal
  outbox --> busy
  outbox --> hook
  outbox -.->|invalidate| rows
```

The three gates a bookable time must pass, in one shared predicate, are the org's
business hours, then the agent's working hours, then their calendar. The org window
is applied at READ time as well, so narrowing the hours lands on the next request
rather than the next recompute.

A fourth gate belongs to the LEAD, not the availability (#2310): a call may only start
from 08:00 to before 20:00 in the lead's own zone. It is judged in that zone, never
intersected with the org or agent windows, and it is not in the shared cache, because
every lead reads the same cached list. The shared slot picker filters what it shows,
and the booking layer refuses an outside start at confirm and on every reschedule.

## Keeping the cache fresh, and the lanes that do it

Three writers keep `busy_blocks` and `bucket_slots` current, and they are layered on
purpose: the fast one is not trusted to be reliable, and the reliable one is not fast.

```mermaid
flowchart LR
  slate["A Slate booking or cancel"] -->|"write-through, synchronous"| busy[("busy_blocks")]
  gpush["Google push notification"] -->|seconds| sync["/api/google/push"]
  sync --> busy
  cron[["/api/cron/sync (every minute)"]] -->|"backstop for a lost push"| busy
  busy --> recompute[["/api/cron/recompute"]]
  recompute --> rows[("bucket_slots")]
  truth[["pnpm verify:availability-truth"]] -.->|"asks Google, not the cache"| rows
```

Four lanes share ONE Worker invocation budget on the every-minute trigger (`sync`,
`recompute`, `outbox`, `selfheal`), which is why per-lane subrequest cost matters. The
full lane list is in `docs/api.md`, and the platform ceilings are in
`docs/cloudflare-platform-notes.md`.

Every lane stamps a heartbeat, and a watchdog pages when one goes quiet, because a
lane that has stopped running looks exactly like a lane with nothing to do. Three
detectors carry a second stamp for when they last reached a MEASURED verdict, since a
fail-safe detector that reports "could not check" renders identically to one finding
nothing wrong (#1394).

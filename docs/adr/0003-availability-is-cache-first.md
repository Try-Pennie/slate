# Availability is cache-first, and the only live Google call is verify-on-book

The embed reads slots from a precomputed cache (`bucket_slots`, plus an L1 edge
cache), never from live Google. Google is called on the hot path exactly once: at
confirm time, to verify the chosen agent is really free before the booking is
written.

## Status

Accepted, and in production. This record exists to make the decision findable: the
reasoning and the mechanics were scattered across `AGENTS.md`, `CLAUDE.md` and the
availability modules, and a future engineer looking for "why does the booker not
just ask Google" had nowhere to look (#1053).

## Why

cal.com asked Google on the read path and the booker took about 8.8 seconds to show
times. Slate serves a warm read in about 39 milliseconds (#256). That is the whole
argument: the read path is what a lead waits on, and a lead who waits does not book.

Google's own limits make the live read worse than slow, too. `freeBusy` caps at 20
calendars per call, so a pool of 100 to 200 agents is 5 to 10 sequential calls per
bucket per read, on a shared quota, on the request a customer is watching.

## What keeps the cache honest

The cache is not allowed to be the only thing between a lead and the truth:

- **Write-through**: a Slate booking updates `busy_blocks` synchronously.
- **Push**: Google's push notifications (`/api/google/push`) land external calendar
  changes within seconds.
- **A backstop**: the every-minute `/api/cron/sync` lane reconverges anything a lost
  push would have missed.
- **Verify-on-book**: at confirm, the round-robin candidates are checked against live
  Google in batched waves, and the first genuinely free agent takes the booking. This
  is what makes a stale cache a slower booking rather than a double booking.

## Consequences

- A slot read can be up to about a minute stale, so `SLOT_TAKEN` at confirm is a
  normal outcome the caller must handle, not an error condition.
- The three gates a bookable time passes (org business hours, the agent's working
  hours, their calendar) must live in ONE predicate, or the cache and the confirm
  disagree. They do: `bookableSlotReason`.
- Anything that counts cached slots has to apply the same read-time business-hours
  filter, or it counts times the booker would never offer (#1296).
- A detector built on `busy_blocks` cannot verify the cache, because `busy_blocks` is
  written by the very reads under test. That is why `pnpm verify:availability-truth`
  asks Google directly.

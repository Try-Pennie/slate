# Architecture decision records

One record per decision that a future engineer could reasonably try to undo. Each
says what was decided, why, and what breaks if it is reversed.

| # | Decision | Where the mechanics live |
|---|---|---|
| [0001](./0001-reschedule-as-durable-appointment-with-history.md) | A reschedule moves the appointment in place and records append-only history, rather than cancelling and recreating | `docs/crash-safe-booking-mutations.md` |
| [0002](./0002-per-bucket-equal-share-fair-assignment.md) | Assignment is equal-share fair per bucket, not global round robin | `src/lib/routing/` |
| [0003](./0003-availability-is-cache-first.md) | Availability is served from a precomputed cache; the only live Google call on the hot path is verify-on-book | `CLAUDE.md` architecture notes, `src/lib/availability/` |
| [0004](./0004-no-browser-tests-in-ci.md) | No browser or end-to-end tests in CI; a production canary covers the funnel post-deploy | `AGENTS.md` "What CI covers", `.github/workflows/smoke-canary.yml` |
| [0005](./0005-post-commit-side-effects-through-an-outbox.md) | Post-commit side effects are delivered through a durable, idempotent outbox | `docs/crash-safe-booking-mutations.md` |
| [0006](./0006-cal-com-compatibility-is-a-frozen-contract.md) | The cal.com URL and embed contract is frozen and extended, never renamed | `README.md` URL contract, `public/widget.js`, `docs/slate-vs-calcom.md` |

Records 0003 to 0006 were backfilled in #1053. Each was a real decision, already
in force and already reasoned about, that lived only in `AGENTS.md`, `CLAUDE.md` or a
closed issue: findable if you knew it existed, invisible if you did not. The
mechanics stay where they are (they change more often than the decision does); these
records carry the reasoning and point at them.

Two decisions deliberately have no record here, because they are recorded better
elsewhere and duplicating them would create two versions to keep in sync: the
detection-not-prevention stance on main (`AGENTS.md`, since it is about how to push),
and the retention and erasure positions (`docs/pii-legal-positions.md`, which is
written to be shown to somebody outside engineering).

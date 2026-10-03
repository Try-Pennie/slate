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
| [0007](./0007-no-staging-environment.md) | No staging environment; production is the first real environment, with the compensating controls named | `DEPLOY.md`, `docs/review-process.md`, `.github/workflows/smoke-canary.yml` |
| [0008](./0008-twilio-is-the-routing-source-of-truth.md) | Twilio TaskRouter tags, not Salesforce, are the source of truth for the facts that decide an agent's pools | `src/lib/twilio/`, `AGENTS.md` `verify:twilio-parity` |
| [0009](./0009-the-pilot-switch-lives-in-salesforce.md) | Which leads book through Slate is a Salesforce record trypennie reads, never a Slate setting or a deploy | `scripts/lib/pilot-settings-read.ts`, `docs/pilot-split-report.md` |
| [0010](./0010-lead-quiet-hours-are-a-gate.md) | No call is offered or booked outside 08:00 to 20:00 on the lead's clock | `src/lib/booking/lead-calling-window.ts` |

Records 0003 to 0006 were backfilled in #1053, 0007 in #1038, and 0008 to 0010 in #3130. Each was a real decision, already
in force and already reasoned about, that lived only in `AGENTS.md`, `CLAUDE.md` or a
closed issue: findable if you knew it existed, invisible if you did not. The
mechanics stay where they are (they change more often than the decision does); these
records carry the reasoning and point at them.

Two decisions deliberately have no record here, because they are recorded better
elsewhere and duplicating them would create two versions to keep in sync: the
detection-not-prevention stance on main (`AGENTS.md`, since it is about how to push),
and the retention and erasure positions (`docs/pii-legal-positions.md`, which is
written to be shown to somebody outside engineering).

## When to write one (#3130)

Write a record in the same PR as the change when the change makes a decision that
a future engineer could reasonably try to undo, and the reason is not visible in the
code. In practice, any one of these:

- somebody outside engineering decided it (Dan, a partner, counsel), and the code
  only carries it out;
- it picks one system as the source of truth over another, or moves where a fact
  is decided;
- it adds or removes a gate on who can book, be booked, or be routed;
- it rejects an alternative a reviewer would otherwise suggest again.

Quote the decision with its date and where it was made, and give only the reasons
that were recorded at the time: a record that invents its rationale is worse than
none, because it is believed. The PR template asks the question, so the answer is on
the record either way.

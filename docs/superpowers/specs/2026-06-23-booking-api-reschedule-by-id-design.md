# Reschedule / move a booking via the direct API (#391)

## Problem

The direct booking API has no explicit "reschedule this booking" verb, so #391
asked for a reschedule-by-id endpoint. On investigation, the bot can already
reschedule or move a booking using only its API key + `external_id`, via the
create endpoint it already calls. No new endpoint and no per-booking token are
needed. The only real gap is that this isn't documented.

## Two callers, two mechanisms (no overlap)

- **The lead (a logged-out human)** manages their own booking through the public
  manage link, which carries an unguessable per-booking token
  (`/booking/manage/<token>` → `POST /api/bookings/{token}/reschedule|cancel`).
  Possessing the secret link is the permission. **Unchanged by this work.**
- **The bot (authenticated)** uses its API key plus `external_id`. The key proves
  who it is; `external_id` identifies whose booking it acts on. It never needs a
  token.

The bot's entire lifecycle is already key-only:

| Action | Endpoint |
|--------|----------|
| Create | `POST /api/bookings/direct` |
| Look up | `GET /api/bookings/direct` (#386) |
| Cancel | `DELETE /api/bookings/direct` (#386) |
| Reschedule / move | re-submit `POST /api/bookings/direct` |

## Key finding (why no new endpoint)

The bot reschedules or moves a booking by **re-submitting** to
`POST /api/bookings/direct` with the same `external_id`, a new `start`, and
optionally a different `bucketCode`. Because the bot always carries a strong id,
the person-dedupe engine deterministically:

- **reschedules in place** when the bucket is the same and the time differs
  (strong match → reschedule, never `confirm_required`), or
- **moves cross-bucket** when `bucketCode` differs (#364: create-in-new,
  cancel-old).

Both behaviors are already shipped and verified live (smoke scenarios 1 and 2).
Slate enforces **one active appointment per person**, so "which booking?" is
never ambiguous — the person's single active booking is the one that moves.

## Scope

- **In:** document the re-submit reschedule/move flow in `docs/booking-api.md`;
  close #391 as achievable by composition, referencing the doc.
- **Out:** any new `/api/bookings/direct` mutation verb; any token/`rescheduleUrl`
  exposure to the bot; any change to booking/routing/reschedule logic or to the
  human token-reschedule endpoint. No code change at all.

## Documentation (`docs/booking-api.md`)

Add a section "Reschedule or move an existing booking" after the cancel section:

- **How:** `POST /api/bookings/direct` with the same `external_id`, a new `start`,
  the same required attendee fields, and optionally a different `bucketCode`.
- **Result:** returns `outcome: "rescheduled"`. Same `bucketCode` (or omitted) =
  in-place time change; different `bucketCode` = cross-bucket move (the lead's
  appointment is recreated on the new team and the old one cancelled). A strong
  id never yields `confirm_required`.
- **Why no separate verb:** the create endpoint already does this for an
  authenticated caller; "one active appointment per person" means the target
  booking is unambiguous.
- **Note for humans:** end-users still self-reschedule via their emailed manage
  link; that path is unchanged and unrelated to the bot flow.

Reuse the existing error contract already documented for `POST` (`SLOT_TAKEN`,
`VERIFY_UNAVAILABLE`, `UNKNOWN_BUCKET`, `NO_ELIGIBLE_AGENTS`, `VALIDATION`).

## Tests

None — documentation only, no behavior change. The underlying re-submit behavior
is already covered by the orchestration tests (reschedule + cross-bucket move
branches) and the live smoke test (scenarios 1 and 2).

## Deploy

No code, no migration, no new env. A docs PR on `feat/booking-api-reschedule-docs`,
then close #391.

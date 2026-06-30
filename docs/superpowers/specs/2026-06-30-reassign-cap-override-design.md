# Reassign cap-override + reschedule cap walk-back — design

Date: 2026-06-30
Status: approved (phase 1)
Related: #536 (shipped), #540, #542 (this supersedes part of it), #544 (RBAC follow-up)

## Problem

Two cap-related behaviors need correcting, both stemming from #536 (which made the
in-place reschedule guard enforce the booker's full slot rules, including the daily
cap).

1. **Reschedule should not be daily-cap-blocked when it keeps the same agent.** A
   reschedule moves an *existing* meeting; it is not a net-new booking, so it should
   not count against the agent's per-day cap. Today, rescheduling an existing meeting
   onto a day already full of that agent's *other* meetings makes #536 decline the
   in-place branch and silently reroute to a different agent — a surprising outcome.

2. **Reassign (force a booking onto a specific agent) is cap-blind.** A manager will
   eventually want to manually reassign a call onto an agent who is at their daily cap,
   see a warning, and push it through. Reassign today force-creates the event with no
   cap awareness. There is **no manager UI** for reassign yet — it is a machine-only,
   bearer-key endpoint used by the contact-owner automation (#9). So the human
   "warn + two-step confirm" flow is a future UI; phase 1 builds the backend capability.

## Decisions (from the user, 2026-06-30)

1. Daily cap does **not** apply to a reschedule that keeps the same agent, even when
   the target day is on a different day already full for that agent. Allow it.
2. Reassign cap handling is phased: backend cap-aware override now, manager screen later.
3. The existing automated reassign connection (contact-owner, `REASSIGN_API_KEY`) keeps
   forcing unconditionally — no behavior change for automation.
4. The future manager reassign flow uses a **two-step confirm** (out of scope for phase 1).

## Scope — phase 1 (backend only)

### Part A — remove the daily cap from the same-agent reschedule guard

`src/lib/booking/orchestration.ts` `applyReschedule`: the in-place keep-same-agent
guard runs `isBookableSlotForAgent`. That predicate enforces working-hours +
min-notice + daily-cap + buffer. For the in-place (same-agent) decision we must
enforce working-hours + min-notice + buffer but **NOT** the daily cap.

Approach: add an opt-out for the cap to the shared predicate rather than duplicating
its logic, so the booker keeps full enforcement and the reschedule guard skips only the
cap. Concretely, give `isBookableSlotForAgent` an `opts.enforceDailyCap?: boolean`
option (default `true`). The in-place guard passes `enforceDailyCap: false` so the cap
is not checked; `memberOpenStarts` (the booker) relies on the default `true`, so slot
display is unchanged. With the cap skipped, the guard no longer needs to load the
agent's day bookings for the in-place decision, so `agentActiveBookingStartsMs` is no
longer called on the same-agent path (pass an empty list / skip the read).

Result: a same-agent reschedule succeeds in place as long as the agent is on-shift, the
new time gives enough notice, and the buffer around it is clear — regardless of how many
other meetings the agent has that day. If the agent is off-shift / inside a buffer /
too soon, the guard still declines and falls through to `assignAgent`, which assigns a
fresh agent and DOES enforce the cap for that net-new assignment (correct).

### Part B — cap-aware reassign with an override switch

`src/lib/booking/orchestration.ts` `reassignBooking(bookingId, agentEmail, reason, deps)`:

1. Add an `overrideCap: boolean` parameter (default `false`).
2. After resolving the target agent and before forcing the event, compute whether the
   target agent is at their daily cap for the booking's local day. This is computed
   ALWAYS (regardless of `overrideCap`) so the result can be reported:
   - Read the event type's `daily_cap`. If `null` (uncapped) → `overCap = false`,
     skip the rest of the check.
   - Reuse the #536 helpers: `deps.agentActiveBookingStartsMs(targetUserId, dayStart,
     dayEnd, bookingId)` for the target agent's other bookings that day (excluding the
     booking being moved), and `isUnderDailyCap(...)` from `compute.ts` to decide.
   - The day window is the booking's NEW local day in the agent's timezone (reuse the
     same day-bounds logic as the reschedule guard; read the agent timezone via
     `deps.agentWorkingHours(targetUserId)`).
3. If `overCap` and `overrideCap === false` → throw a new typed error
   `DailyCapExceededError` (carrying the agent email + the day) and do NOT force /
   create the event. Nothing is mutated.
4. If under cap, or `overrideCap === true` → proceed exactly as today (force-create,
   `allow_double_book: true`).
5. Reporting: when `overCap` is true AND the reassign proceeds (override path), log a
   warning ("reassign forced <agent> over their daily cap on <day>") and include an
   `overCap: true` flag in the returned result. The reassign return type is extended to
   carry `overCap: boolean` alongside `{ booking, manageUrl }` (a small struct, not the
   shared `BookingResult`, so other callers are untouched).

Caller wiring:
- Service wrapper `reassignBooking` (`src/lib/booking/service.ts`) threads `overrideCap`
  and passes the `overCap` result back out.
- The existing machine route `src/app/api/bookings/reassign/route.ts` passes
  `overrideCap: true` so the contact-owner automation keeps forcing unconditionally
  (no contract change), and includes `overCap` in its JSON response so callers and logs
  can see a forced reassign landed the agent over cap. It never blocks.
- Phase 2 (NOT in this spec) adds an admin-authed reassign route + manager UI that pass
  `overrideCap` only when the manager confirms the two-step warning.

### Error mapping

`DailyCapExceededError` is a new domain error in `orchestration.ts` (alongside
`NoEligibleAgentsError` etc.) and re-exported from `service.ts`. Since the existing
machine route always passes `overrideCap: true`, it will never see this error in phase 1;
it exists for the phase-2 route/UI. A unit test still covers the throw path directly.

## Components & boundaries

- `src/lib/availability/compute.ts` — `isBookableSlotForAgent` gains a cap opt-out
  flag. Pure, unit-tested in `scripts/test-compute.ts`.
- `src/lib/booking/orchestration.ts` — `applyReschedule` (Part A), `reassignBooking`
  + `DailyCapExceededError` (Part B). Logic-only, fakes-driven, tested in
  `scripts/test-booking-orchestration.ts`.
- `src/lib/booking/service.ts` — thread `overrideCap` through the wrapper; machine route
  passes `true`. IO glue.

## Testing (TDD)

1. `test-compute.ts`: `isBookableSlotForAgent` with the cap opt-out — over-cap slot is
   bookable when the cap is skipped, still blocked when enforced.
2. `test-booking-orchestration.ts`:
   - reschedule keeping the same agent onto a day full of the agent's OTHER meetings →
     stays in place (no reroute), even though over cap.
   - reschedule still re-routes when off-shift / buffer / too-soon (unchanged).
   - reassign onto an at-cap agent with `overrideCap: false` → throws
     `DailyCapExceededError`, no event created.
   - reassign onto an at-cap agent with `overrideCap: true` → forces through (current
     behavior), event created, returns `overCap: true`.
   - reassign onto an under-cap agent → succeeds regardless of the flag, `overCap: false`.
   - reassign with `daily_cap: null` → never blocks, `overCap: false`.
3. Full gate: `tsc --noEmit`, lint, node suites, vitest, `cf:build`.

## Out of scope (future)

- Phase 2: manager reassign screen (pick agent, cap warning, two-step confirm) + an
  admin-authed reassign route. Tracked separately.
- #540 (enforce cap on the NEW-booking reroute/verify path) is unrelated and stays open.
- #544 (managers see admin-only buttons) is a separate RBAC fix.

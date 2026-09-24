"use client";

import { setPublicBookingPaused } from "@/app/admin/actions";
import { ConfirmAction } from "@/components/ui/ConfirmAction";
import { SaveForm, holdsAView } from "@/components/ui/SaveForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { btnCls, btnDangerCls } from "@/components/ui/styles";

/**
 * Stop and start public booking (#2297).
 *
 * The lever somebody reaches for when the landing pages are pointed at Slate and
 * something is wrong. It takes effect on the next request, with no deploy: the
 * booking route reads the stored flag every time.
 *
 * ## Three states, not two
 *
 * Running, stopped, and could-not-read. The third is not a rendering nicety. The
 * booking route REFUSES while the flag is unreadable, so a page that drew that as
 * "running" would tell an admin the opposite of what leads are meeting, on the one
 * screen they would go to in order to check (L530, L11).
 *
 * ## Why stopping asks and starting does not
 *
 * Stopping is the destructive direction, so it confirms, and the question names
 * what it does AND what it leaves alone. A bare "are you sure" would send somebody
 * to find out whether it also stops calendar sync, at the moment they have least
 * time to (L608). Starting again is the safe direction and is one press: dressing
 * it up as dangerous would teach people to click through both.
 *
 * ## Why there is no auto-expiry
 *
 * A hand-set suppression that nobody can see is the thing that gets forgotten
 * (L523), which is why the Overview states this too. The other half of that rule,
 * an expiry, is deliberately NOT taken here: a kill switch that lifted itself would
 * start taking bookings again in the middle of the incident it was thrown for,
 * which is worse than being forgotten. Visibility is the half that helps.
 *
 * ## Why this is client code
 *
 * It calls `holdsAView()` from `SaveForm.tsx`, a `"use client"` module. Rendered as
 * a server component that call threw on every request and took the whole Hours
 * page down with it, kill switch included (#2690).
 * `scripts/test-client-boundary-calls.ts` fails the build on the next such call.
 */
export function PublicBookingSwitch({ paused }: { paused: boolean | null }) {
  if (paused === null) {
    return (
      <div data-state="unreadable" className="rounded-sm border border-border bg-[var(--field)] p-4">
        <p className="text-sm text-fg">
          Could not read whether online booking is running.
        </p>
        <p className="mt-2 text-sm text-fg-muted">
          While it cannot be read, leads cannot book a call: the booker refuses rather than
          guessing. Everything else keeps working, and this clears itself as soon as the setting
          can be read again. If it does not, the most likely cause is a deploy that went out
          ahead of its database change.
        </p>
      </div>
    );
  }

  if (paused) {
    return (
      <div
        data-state="paused"
        className="rounded-sm border-2 border-[var(--danger)] bg-[var(--danger-bg,var(--field))] p-4"
      >
        <p className="text-sm font-semibold text-fg">Online booking is stopped.</p>
        <p className="mt-2 text-sm text-fg-muted">
          Leads cannot book a call. Availability is still being computed, calendars are still
          syncing, and anyone who already has a call can still move or cancel it.
        </p>
        <SaveForm
          action={setPublicBookingPaused}
          name="public-booking-start"
          unsaved={holdsAView("the switch holds nothing typed: it is one button carrying a fixed value")}
          className="mt-3"
        >
          <input type="hidden" name="paused" value="false" />
          <SubmitButton className={btnCls} pendingLabel="Starting">
            Start online booking
          </SubmitButton>
        </SaveForm>
      </div>
    );
  }

  return (
    <div>
      <p className="text-sm text-fg-muted">Leads can book a call.</p>
      <SaveForm
        action={setPublicBookingPaused}
        name="public-booking-stop"
        unsaved={holdsAView("the switch holds nothing typed: it is one button carrying a fixed value")}
        className="mt-3"
      >
        <input type="hidden" name="paused" value="true" />
        <ConfirmAction
          className={btnDangerCls}
          label="Stop online booking"
          confirmLabel="Stop online booking"
          pendingLabel="Stopping"
          message={
            <>
              Leads will not be able to book a call, starting with the next one who tries.
              Availability keeps being computed, calendars keep syncing, and anyone who already
              has a call can still move or cancel it. You start it again on this screen.
            </>
          }
        />
      </SaveForm>
    </div>
  );
}

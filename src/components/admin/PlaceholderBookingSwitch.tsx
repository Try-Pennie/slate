"use client";

import { setPlaceholderBookingEnabled } from "@/app/admin/actions";
import { ConfirmAction } from "@/components/ui/ConfirmAction";
import { SaveForm, holdsAView } from "@/components/ui/SaveForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { btnCls, btnDangerCls, proseCls } from "@/components/ui/styles";
import { COORDINATOR_BOOKING_COPY, PLACEHOLDER_SWITCH_UNREADABLE } from "@/lib/admin/coordinator-booking-copy";

const COPY = COORDINATOR_BOOKING_COPY.switch;

/**
 * Whether scheduling coordinators can book a call nobody is free for on Marcia (#4264,
 * `booking_settings.placeholder_booking_enabled`), as settled in
 * docs/design/coordinator-admin.html (D6 to D9).
 *
 * It lives on /admin/coordinator-booking and nowhere else (D3): drawn on the Hours page it
 * read as though leads on the website could book Marcia, and only coordinators ever can, which
 * the rule line under the heading says in both states.
 *
 * Three states, not two. Off says only that it is off (a switch's help text says its current
 * state, .impeccable.md), and turning it on is the warning treatment and asks first, through
 * ConfirmAction, the way "Stop online booking" asks, because it changes what customers get.
 * On is the body colour, and turning it off is the safe direction and one press. Could not
 * read says what coordinators meet meanwhile and offers no control, since a press would be a
 * guess at which way it goes (L530).
 *
 * Client code for the reason PublicBookingSwitch is: `holdsAView()` comes from a client module.
 */
export function PlaceholderBookingSwitch({
  on,
  initiallyAsking = false,
}: {
  on: boolean | null;
  /** The turn on question drawn open, for the design's preview frame only. */
  initiallyAsking?: boolean;
}) {
  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold">{COPY.heading}</h3>
      <p className={`mb-4 ${proseCls} text-xs text-fg-muted`}>{COPY.rule}</p>
      <State on={on} initiallyAsking={initiallyAsking} />
    </div>
  );
}

function State({ on, initiallyAsking }: { on: boolean | null; initiallyAsking: boolean }) {
  if (on === null) {
    return (
      <div data-state="unreadable" className="rounded-sm border border-border bg-[var(--field)] p-4">
        <p className="text-sm text-fg">{PLACEHOLDER_SWITCH_UNREADABLE.title}</p>
        <p className="mt-2 text-sm text-fg-muted">{PLACEHOLDER_SWITCH_UNREADABLE.meanwhile}</p>
      </div>
    );
  }

  if (on) {
    return (
      <div data-state="on">
        <p className="text-sm text-fg">{COPY.on}</p>
        <SaveForm
          action={setPlaceholderBookingEnabled}
          name="placeholder-booking-off"
          unsaved={holdsAView("the switch holds nothing typed: it is one button carrying a fixed value")}
          className="mt-3"
        >
          <input type="hidden" name="on" value="false" />
          <SubmitButton className={btnCls} pendingLabel="Turning off">
            {COPY.turnOff}
          </SubmitButton>
        </SaveForm>
      </div>
    );
  }

  return (
    <div data-state="off">
      <p className="text-sm text-fg-muted">{COPY.off}</p>
      <SaveForm
        action={setPlaceholderBookingEnabled}
        name="placeholder-booking-on"
        unsaved={holdsAView("the switch holds nothing typed: it is one button carrying a fixed value")}
        className="mt-3"
      >
        <input type="hidden" name="on" value="true" />
        <ConfirmAction
          className={btnDangerCls}
          label={COPY.turnOn}
          confirmLabel={COPY.turnOn}
          pendingLabel="Turning on"
          message={COPY.confirmOn}
          initiallyOpen={initiallyAsking}
        />
      </SaveForm>
    </div>
  );
}

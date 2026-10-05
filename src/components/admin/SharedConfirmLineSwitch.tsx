"use client";

import { setSharedConfirmLine } from "@/app/admin/actions";
import { ConfirmAction } from "@/components/ui/ConfirmAction";
import { SaveForm, holdsAView } from "@/components/ui/SaveForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { btnCls } from "@/components/ui/styles";
import { SHARED_LINE_SWITCH_TTL_SECONDS } from "@/lib/booking/shared-line-switch-core";

/**
 * Turn the shared confirm line on and off (#3325), built like `FrameLockSwitch`.
 *
 * Three states: on, off, and could-not-read, which says what servers do meanwhile
 * rather than claiming either answer (L530).
 *
 * Turning it on asks first, because it changes how every confirm for a time is lined
 * up, and the question says when it takes hold from the reader's own TTL constant.
 * Neither direction is destructive (a confirm the line cannot serve falls back to its
 * own server's line), so neither wears the danger treatment. Turning it off is how
 * confirms have always run, so it is one press.
 *
 * Imports the constant from the CORE module, never `shared-line-switch.ts`, which reads
 * the database and must not reach the browser bundle.
 */
export function SharedConfirmLineSwitch({ on }: { on: boolean | null }) {
  if (on === null) {
    return (
      <div data-state="unreadable" className="rounded-sm border border-border bg-[var(--field)] p-4">
        <p className="text-sm text-fg">Could not read whether confirms share one line.</p>
        <p className="mt-2 text-sm text-fg-muted">
          Until it can be read, each server keeps the setting it last read, or uses the
          deployment&apos;s default if it has read nothing yet.
        </p>
      </div>
    );
  }

  if (on) {
    return (
      <div data-state="on">
        <p className="text-sm text-fg">On. Confirms for one time wait in one line shared by every server.</p>
        <SaveForm
          action={setSharedConfirmLine}
          name="shared-line-off"
          unsaved={holdsAView("the switch holds nothing typed: it is one button carrying a fixed value")}
          className="mt-3"
        >
          <input type="hidden" name="on" value="false" />
          <SubmitButton className={btnCls} pendingLabel="Turning off">
            Turn off the shared line
          </SubmitButton>
        </SaveForm>
      </div>
    );
  }

  return (
    <div data-state="off">
      <p className="text-sm text-fg-muted">Off. Each server keeps its own line for a time, as before.</p>
      <SaveForm
        action={setSharedConfirmLine}
        name="shared-line-on"
        unsaved={holdsAView("the switch holds nothing typed: it is one button carrying a fixed value")}
        className="mt-3"
      >
        <input type="hidden" name="on" value="true" />
        <ConfirmAction
          className={btnCls}
          label="Turn on the shared line"
          confirmLabel="Turn on the shared line"
          pendingLabel="Turning on"
          message={
            <>
              Within {SHARED_LINE_SWITCH_TTL_SECONDS} seconds, every server will put confirms for one
              time in the one shared line. You can turn it off again on this screen.
            </>
          }
        />
      </SaveForm>
    </div>
  );
}

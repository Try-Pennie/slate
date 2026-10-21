"use client";

import { setEmbedPrerender } from "@/app/admin/actions";
import { SaveForm, holdsAView } from "@/components/ui/SaveForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { btnCls } from "@/components/ui/styles";

/**
 * Turn building the booker at page load on and off (#3706), built like
 * `SharedConfirmLineSwitch`.
 *
 * Three states: on, off, and could-not-read, which says what partner pages do meanwhile
 * rather than claiming either answer (L530).
 *
 * Neither direction is destructive: with it off, or when a page cannot tell, the booker
 * loads on the lead's tap, as it always has. So each direction is one press posting the
 * state it wants, and neither wears the danger treatment or asks first. When it takes
 * hold is said once, by the save notice above (`save-outcomes.ts`).
 */
export function EmbedPrerenderSwitch({ on }: { on: boolean | null }) {
  if (on === null) {
    return (
      <div data-state="unreadable" className="rounded-sm border border-border bg-[var(--field)] p-4">
        <p className="text-sm text-fg">Could not read whether the booker loads with the page.</p>
        <p className="mt-2 text-sm text-fg-muted">
          Until it can be read, partner pages load the booker when a lead taps to book.
        </p>
      </div>
    );
  }

  if (on) {
    return (
      <div data-state="on">
        <p className="text-sm text-fg">
          On. A partner page that asks loads the booker as it opens, so a lead who taps to book
          sees times at once.
        </p>
        <SaveForm
          action={setEmbedPrerender}
          name="prerender-off"
          unsaved={holdsAView("the switch holds nothing typed: it is one button carrying a fixed value")}
          className="mt-3"
        >
          <input type="hidden" name="on" value="false" />
          <SubmitButton className={btnCls} pendingLabel="Saving">
            Load the booker on the tap instead
          </SubmitButton>
        </SaveForm>
      </div>
    );
  }

  return (
    <div data-state="off">
      <p className="text-sm text-fg-muted">Off. The booker loads when a lead taps to book.</p>
      <SaveForm
        action={setEmbedPrerender}
        name="prerender-on"
        unsaved={holdsAView("the switch holds nothing typed: it is one button carrying a fixed value")}
        className="mt-3"
      >
        <input type="hidden" name="on" value="true" />
        <SubmitButton className={btnCls} pendingLabel="Saving">
          Load the booker with the page
        </SubmitButton>
      </SaveForm>
    </div>
  );
}

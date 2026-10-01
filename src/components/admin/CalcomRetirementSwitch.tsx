"use client";

import { setCalcomRetired } from "@/app/admin/actions";
import { ConfirmAction } from "@/components/ui/ConfirmAction";
import { SaveForm, holdsAView } from "@/components/ui/SaveForm";
import { btnDangerCls, btnSecondaryCls } from "@/components/ui/styles";
import { putBackConfirmSentence } from "@/lib/calcom/put-back";

/**
 * Retire cal.com, or put it back (#2875), on /admin/alerts.
 *
 * One stored switch every cal.com lane reads (src/lib/calcom/retirement.ts), so
 * cutover needs no code change and is itself audited.
 *
 * ## Three states, not two
 *
 * Live, retired, and could-not-read. A failed read is its own screen and offers
 * neither direction, because the lanes themselves treat it differently from both
 * (the hours import refuses, the watchdogs carry on), and a page that drew it as
 * "live" would invite somebody to retire a cal.com that may already be retired.
 *
 * ## Both directions ask
 *
 * Unlike the booking kill switch, where starting again is simply safe, BOTH
 * presses here change what Slate writes. Retiring stops the time off dual write
 * while cal.com might still be taking leads, and putting it back restarts the
 * morning import that writes cal.com's hours over the week Slate holds. So each
 * confirms, and each message names what it starts or stops (L608, L180). Retiring
 * wears the destructive treatment; putting it back is the neutral one.
 *
 * ## Why this is client code
 *
 * It calls `holdsAView()` from `SaveForm.tsx`, a `"use client"` module, which a
 * server component may not call (#2690).
 */
export function CalcomRetirementSwitch({
  retired,
  awaitingCopy,
  notice,
}: {
  retired: boolean | null;
  /**
   * #2890: how many approved time off requests made during retirement the override
   * sweep will copy into cal.com once it is put back, or null when that could not
   * be counted. Read only while retired, and named in the put back confirmation.
   */
  awaitingCopy: number | null;
  /** The outcome of the last press, drawn here rather than at the top of the page. */
  notice?: React.ReactNode;
}) {
  if (retired === null) {
    return (
      <div data-state="unreadable" className="rounded-sm border border-border bg-[var(--field)] p-4">
        {notice}
        <p className="text-sm text-fg">Could not read whether cal.com is retired.</p>
        <p className="mt-2 text-sm text-fg-muted">
          While it cannot be read, no hours are imported from cal.com, and everything else carries on
          as it does during the parallel run. Reload to try again.
        </p>
      </div>
    );
  }

  if (retired) {
    return (
      <div
        data-state="retired"
        className="rounded-sm border-2 border-[var(--danger)] bg-[var(--danger-bg,var(--field))] p-4"
      >
        {notice}
        <p className="text-sm font-semibold text-fg">cal.com is retired.</p>
        <p className="mt-2 text-sm text-fg-muted">
          Nothing is compared against it, no hours are imported from it, and no time off is written to
          it. The hours each agent holds in Slate are the record.
        </p>
        <SaveForm
          action={setCalcomRetired}
          name="calcom-live"
          unsaved={holdsAView("the switch holds nothing typed: it is one button carrying a fixed value")}
          className="mt-3"
        >
          <input type="hidden" name="retired" value="false" />
          <ConfirmAction
            className={btnSecondaryCls}
            label="Put cal.com back"
            confirmLabel="Put cal.com back"
            pendingLabel="Saving"
            message={
              <>
                The daily comparison and the weekly routing replay start again, and page if they go
                quiet. Every morning the hours import writes each agent&apos;s cal.com week over the one in
                Slate, unless the agent set it themselves, and approved time off is written to cal.com
                again. {putBackConfirmSentence(awaitingCopy)}
              </>
            }
          />
        </SaveForm>
      </div>
    );
  }

  return (
    <div data-state="live">
      {notice}
      <p className="text-sm text-fg-muted">
        cal.com is live: the parallel run is on, and Slate keeps itself in step with it.
      </p>
      <SaveForm
        action={setCalcomRetired}
        name="calcom-retired"
        unsaved={holdsAView("the switch holds nothing typed: it is one button carrying a fixed value")}
        className="mt-3"
      >
        <input type="hidden" name="retired" value="true" />
        <ConfirmAction
          className={btnDangerCls}
          label="Retire cal.com"
          confirmLabel="Retire cal.com"
          pendingLabel="Retiring"
          message={
            <>
              Do this once cal.com takes no more bookings. The daily comparison and the weekly routing
              replay stop, and nothing pages about them going quiet. No hours are imported from cal.com
              again, so an edit made in Slate stays. Approved time off stops being written to cal.com,
              and a time off page about cal.com is cleared. You can put it back on this screen.
            </>
          }
        />
      </SaveForm>
    </div>
  );
}

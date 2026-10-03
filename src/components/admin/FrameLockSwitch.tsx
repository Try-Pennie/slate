"use client";

import { setFrameLock } from "@/app/admin/actions";
import { ConfirmAction } from "@/components/ui/ConfirmAction";
import { SaveForm, holdsAView } from "@/components/ui/SaveForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { btnCls, btnDangerCls } from "@/components/ui/styles";
import { FRAME_LOCK_TTL_SECONDS } from "@/lib/embed/frame-lock";

/**
 * Lock and unlock who may frame the booker (#3137), built like `PublicBookingSwitch`.
 *
 * Three states: unlocked, locked, and could-not-read, which says that the booker
 * keeps whatever it last read rather than claiming either answer.
 *
 * Locking is the dangerous direction, so it confirms, and the question is derived from
 * what was measured (L180): how many sites framed the booker in the window that the lock
 * would now refuse. Unlocking is how the booker has always run, so it is one press.
 */
export function FrameLockSwitch({
  locked,
  refusedSites,
  foldedSites,
  windowDays,
}: {
  locked: boolean | null;
  /** Sites seen framing the booker in the window that are not on the allow list, or
   *  null when the record could not be read. */
  refusedSites: number | null;
  /** Whether more such sites were counted together as other sites past the daily
   *  limit. They are off the allow list too, so the question must not say none. */
  foldedSites: boolean;
  windowDays: number;
}) {
  if (locked === null) {
    return (
      <div data-state="unreadable" className="rounded-sm border border-border bg-[var(--field)] p-4">
        <p className="text-sm text-fg">Could not read whether framing is locked.</p>
        <p className="mt-2 text-sm text-fg-muted">
          Until it can be read, the booker keeps the setting it last read, or leaves framing
          unlocked if it has none. Sites on the allow list are unaffected either way.
        </p>
      </div>
    );
  }

  if (locked) {
    return (
      <div data-state="locked">
        <p className="text-sm text-fg">
          Locked. Only Slate and the sites on the allow list can show the booker.
        </p>
        <SaveForm
          action={setFrameLock}
          name="frame-unlock"
          unsaved={holdsAView("the switch holds nothing typed: it is one button carrying a fixed value")}
          className="mt-3"
        >
          <input type="hidden" name="locked" value="false" />
          <SubmitButton className={btnCls} pendingLabel="Unlocking">
            Unlock framing
          </SubmitButton>
        </SaveForm>
      </div>
    );
  }

  const named =
    refusedSites === null || refusedSites === 0
      ? null
      : `${refusedSites} ${refusedSites === 1 ? "site" : "sites"} outside the allow list`;
  const consequence =
    refusedSites === null
      ? "Any site not on the allow list will show an empty frame where the booker was. Who frames it now could not be read."
      : !named && !foldedSites
        ? `No site outside the allow list framed the booker in the last ${windowDays} days.`
        : `${named ? `${named}${foldedSites ? ", and more counted together as other sites," : ""}` : "Sites outside the allow list, counted together as other sites,"} framed the booker in the last ${windowDays} days, and will show an empty frame where the booker was.`;

  return (
    <div data-state="unlocked">
      <p className="text-sm text-fg-muted">Unlocked. Any site can show the booker.</p>
      <SaveForm
        action={setFrameLock}
        name="frame-lock"
        unsaved={holdsAView("the switch holds nothing typed: it is one button carrying a fixed value")}
        className="mt-3"
      >
        <input type="hidden" name="locked" value="true" />
        <ConfirmAction
          className={btnDangerCls}
          label="Lock framing"
          confirmLabel="Lock framing"
          pendingLabel="Locking"
          message={
            <>
              Only Slate and the sites on the allow list will be able to show the booker, within{" "}
              {FRAME_LOCK_TTL_SECONDS} seconds. {consequence} You can unlock it again on this screen.
            </>
          }
        />
      </SaveForm>
    </div>
  );
}

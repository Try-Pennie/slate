"use client";

import { setPlaceholderDayLimit } from "@/app/admin/actions";
import { SaveForm } from "@/components/ui/SaveForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { btnCls, inputCls, labelCls, proseCls } from "@/components/ui/styles";
import {
  PLACEHOLDER_DAY_LIMIT_MAX,
  PLACEHOLDER_DAY_LIMIT_MIN,
  PROGRAM_LEADS_COPY,
} from "@/lib/admin/program-leads-copy";

const COPY = PROGRAM_LEADS_COPY.limit;

/**
 * The placeholder day limit on /admin/program-leads (#4392,
 * `booking_settings.placeholder_day_limit`). Built as `TransferOfferSettings` is: the admin
 * area's number box and Save button in a `SaveForm`, which guards what was typed. The
 * server action checks admin itself and reads the value (`parsePlaceholderDayLimit`), so the
 * box only shows what it will accept.
 *
 * Two states: the stored limit in the box, or could not be read, which says what program
 * leads meet meanwhile and offers no box, since saving over a limit nobody read would be a
 * guess (L530). Client code because `SaveForm` is.
 */
export function PlaceholderDayLimitForm({ limit }: { limit: number | null }) {
  return (
    <div>
      <p className={`mb-4 ${proseCls} text-xs text-fg-muted`}>{COPY.rule}</p>
      {limit === null ? (
        <div data-state="unreadable" className="rounded-sm border border-border bg-[var(--field)] p-4">
          <p className="text-sm text-fg">{COPY.unreadable}</p>
          <p className="mt-2 text-sm text-fg-muted">{COPY.unreadableMeanwhile}</p>
        </div>
      ) : (
        <SaveForm
          action={setPlaceholderDayLimit}
          name="placeholder-day-limit"
          unsaved="the placeholder day limit you typed"
          className="flex flex-wrap items-end gap-4"
        >
          <div className="w-72">
            <label className={labelCls} htmlFor="placeholder-day-limit">
              {COPY.label}
            </label>
            <input
              id="placeholder-day-limit"
              name="placeholder_day_limit"
              className={`${inputCls} tabular-nums`}
              type="number"
              inputMode="numeric"
              min={PLACEHOLDER_DAY_LIMIT_MIN}
              max={PLACEHOLDER_DAY_LIMIT_MAX}
              step={1}
              defaultValue={String(limit)}
              required
            />
          </div>
          <SubmitButton className={btnCls} pendingLabel="Saving">
            {COPY.save}
          </SubmitButton>
        </SaveForm>
      )}
    </div>
  );
}

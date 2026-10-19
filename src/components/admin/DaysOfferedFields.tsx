"use client";

import { useState } from "react";
import { SelectField } from "@/components/ui/SelectField";
import { useRestoredValue } from "@/components/ui/SaveForm";
import { labelCls } from "@/components/ui/styles";
import {
  EXTRA_DAYS_HINT,
  EXTRA_DAYS_LABEL,
  FURTHEST_DAY_TERM,
  OFFERED_DAYS_HINT,
  OFFERED_DAYS_LABEL,
  furthestDayValue,
} from "@/lib/admin/days-offered-copy";
import { extraDayChoices, offeredDayChoices, restoredChoice } from "@/lib/booking/days-offered";

const OFFERED_NAME = "offered_open_days";
const EXTRA_NAME = "last_resort_extra_days";

const asOptions = (values: number[]) => values.map((n) => ({ value: String(n), label: String(n) }));

/**
 * The two controls of the Hours page's "Days offered" card and the fact line under
 * them (#3922), as settled in docs/design/days-offered.html.
 *
 * Both are Slate's own dropdown listing bare numbers (D5), narrow with the value
 * centred, the same in both (D4). The extra days list only what keeps offered plus
 * extra at 7 or less (D6), so the furthest day cannot pass the ceiling from here;
 * when a larger offered count leaves the chosen extra out of range it comes down to
 * the most that fits, and the fact line says what that makes. The server holds the
 * same rules for a post that did not come from this card (`parseDaysOfferedForm`).
 *
 * Client side only because the second list depends on the first. The values post
 * through each control's own hidden input, so the form, the unsaved changes guard
 * and the stale action restore all see them like any other field.
 */
export function DaysOfferedFields({ offered: savedOffered, extra: savedExtra }: { offered: number; extra: number }) {
  // A value restored from a save that never arrived (#1994) is used only when the
  // dropdown lists it; anything else falls back to the saved value.
  const rawOffered = useRestoredValue(OFFERED_NAME);
  const rawExtra = useRestoredValue(EXTRA_NAME);
  const initialOffered = restoredChoice(rawOffered, offeredDayChoices()) ?? savedOffered;
  const [offered, setOffered] = useState(initialOffered);
  const [extra, setExtra] = useState(restoredChoice(rawExtra, extraDayChoices(initialOffered)) ?? savedExtra);
  const extraChoices = extraDayChoices(offered);
  const mostExtra = extraChoices[extraChoices.length - 1] ?? 0;
  const shownExtra = Math.min(extra, mostExtra);
  const furthest = furthestDayValue(offered, shownExtra);

  return (
    <>
      <div className="flex flex-wrap items-start gap-x-7 gap-y-4">
        <div className="flex flex-col gap-1.5">
          <label className={labelCls} htmlFor="days-offered-offered">
            {OFFERED_DAYS_LABEL}
          </label>
          <SelectField
            id="days-offered-offered"
            name={OFFERED_NAME}
            value={String(offered)}
            options={asOptions(offeredDayChoices())}
            onChange={(v) => {
              const next = Number(v);
              setOffered(next);
              setExtra((e) => Math.min(e, Math.max(0, extraDayChoices(next).length - 1)));
            }}
            compact
            className="w-21"
            ariaDescribedBy="days-offered-offered-hint"
          />
          <span id="days-offered-offered-hint" className="max-w-64 text-xs text-fg-muted">
            {OFFERED_DAYS_HINT}
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className={labelCls} htmlFor="days-offered-extra">
            {EXTRA_DAYS_LABEL}
          </label>
          <SelectField
            id="days-offered-extra"
            name={EXTRA_NAME}
            value={String(shownExtra)}
            options={asOptions(extraChoices)}
            onChange={(v) => setExtra(Number(v))}
            compact
            className="w-21"
            ariaDescribedBy="days-offered-extra-hint"
          />
          <span id="days-offered-extra-hint" className="max-w-64 text-xs text-fg-muted">
            {EXTRA_DAYS_HINT}
          </span>
        </div>
      </div>
      {/* D3: kept although it repeats both values, because the furthest day is the
          number a reader is asking about. Polite live region, so a change in either
          control is heard as the new furthest day. */}
      <div className="mt-3.5 flex flex-col gap-0.5">
        <span className="text-xs font-semibold text-fg">{FURTHEST_DAY_TERM}</span>
        <span className="text-sm text-fg" aria-live="polite">
          <b className="font-semibold tabular-nums">{furthest.day}</b> <span className="tabular-nums">{furthest.sum}</span>
        </span>
      </div>
    </>
  );
}

"use client";

import { REASON_DETAIL_MAX, type ReasonOption } from "@/lib/booking/core";

/**
 * Mandatory reason picker (#326): a single-select radio group with an "Other"
 * option that reveals a length-capped free-text field. Shared by the customer
 * manage-link (ManageBooking) and the internal admin reschedule/cancel screen.
 * Collects input only — the parent gates its submit on `validateReason`.
 */
export default function ReasonPicker({
  legend,
  options,
  code,
  detail,
  onCode,
  onDetail,
  idPrefix,
}: {
  legend: string;
  options: ReasonOption[];
  code: string;
  detail: string;
  onCode: (code: string) => void;
  onDetail: (detail: string) => void;
  idPrefix: string;
}) {
  return (
    <fieldset className="mt-1">
      <legend className="text-sm font-semibold text-fg">{legend}</legend>
      <div className="mt-2 flex flex-col">
        {options.map((o) => (
          <label
            key={o.code}
            className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-fg"
          >
            <input
              type="radio"
              name={idPrefix}
              value={o.code}
              checked={code === o.code}
              onChange={() => onCode(o.code)}
              className="size-4 accent-[var(--sky)] focus-visible:outline-2 focus-visible:outline-offset-2"
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      {code === "other" && (
        <div className="mt-2">
          <label htmlFor={`${idPrefix}-detail`} className="sr-only">
            Tell us more
          </label>
          <textarea
            id={`${idPrefix}-detail`}
            aria-label="Tell us more"
            value={detail}
            onChange={(e) => onDetail(e.target.value)}
            maxLength={REASON_DETAIL_MAX}
            rows={2}
            placeholder="Tell us more"
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg focus-visible:border-[var(--sky)] focus-visible:outline-2 focus-visible:outline-offset-0"
          />
        </div>
      )}
    </fieldset>
  );
}

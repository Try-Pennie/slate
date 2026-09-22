"use client";

import { REASON_DETAIL_MAX, type ReasonOption } from "@/lib/booking/core";

/**
 * Mandatory reason picker (#326): a single-select radio group with an "Other"
 * option that reveals a length-capped free-text field. Shared by the customer
 * manage-link (ManageBooking) and the internal admin reschedule/cancel screen.
 *
 * It collects input and SAYS what is missing; the parent still decides, with
 * `validateReason`, and hands the answer back through `error`.
 *
 * That `error` exists because the surfaces used to express the same rule by
 * DISABLING their submit, so the refusal a lead needed could only have been
 * spoken by the control the rule had just switched off, and was therefore never
 * spoken at all (L109). Dan, 2026-09-22: "let's let them choose a time and just
 * tell them the reason is required if they try to submit without it."
 *
 * The wording is never composed here. It is whatever `validateReason` returned,
 * which is the same sentence the server answers with, so the two cannot drift
 * (L41) and "choose a reason" is never shown to somebody whose actual omission
 * was the free text.
 */
export default function ReasonPicker({
  legend,
  options,
  code,
  detail,
  onCode,
  onDetail,
  idPrefix,
  error,
}: {
  legend: string;
  options: ReasonOption[];
  code: string;
  detail: string;
  onCode: (code: string) => void;
  onDetail: (detail: string) => void;
  idPrefix: string;
  /** What `validateReason` refused on the last attempt, or null. */
  error?: string | null;
}) {
  const errorId = `${idPrefix}-error`;
  return (
    <fieldset className="mt-1" aria-describedby={error ? errorId : undefined}>
      <legend className="text-sm font-semibold text-fg">{legend}</legend>
      {/* Above the options rather than below them: the group is up to five rows
          tall plus a text box, so a message under it can be off screen on a
          phone at the moment it is put there.

          It reaches assistive tech twice over and neither is `aria-invalid` on
          the radios, which that role does not take, because validity here is a
          property of the GROUP and not of any one option: `role="alert"` speaks
          it the moment it appears, and the fieldset's `aria-describedby` carries
          it for anyone arriving at the group afterwards. The fieldset is NOT
          relabelled `radiogroup` to take `aria-invalid`, because it also holds
          the free text box, and a role naming a structure is a promise about its
          children (L560). */}
      {error && (
        <p id={errorId} role="alert" className="mt-2 text-sm text-[var(--error)]">
          {error}
        </p>
      )}
      <div className="mt-2 flex flex-col">
        {options.map((o) => (
          <label
            key={o.code}
            className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-fg"
          >
            <input
              type="radio"
              // Addressable, so a caller can put focus on the group it just
              // refused rather than leaving the message to be found.
              id={`${idPrefix}-${o.code}`}
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
            aria-invalid={error ? true : undefined}
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

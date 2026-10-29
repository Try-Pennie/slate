"use client";

import { setTransferOfferSettings } from "@/app/admin/actions";
import { SaveForm } from "@/components/ui/SaveForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { btnCls, inputCls, labelCls, proseCls } from "@/components/ui/styles";
import { TRANSFER_FORM_COPY as COPY } from "@/lib/admin/transfer-offer-form";
import { TRANSFER_THRESHOLD_MAX, TRANSFER_THRESHOLD_MIN, type TransferOfferSettings as Settings } from "@/lib/coordinator/transfer-queue";

/**
 * When the coordinator page offers a live transfer, and to which line (#4380,
 * `booking_settings.transfer_offer_threshold` and `transfer_line`). On
 * /admin/coordinator-booking, beside the coordinators' other setting; the server action
 * checks super admin itself and reads the values (`parseTransferOfferForm`), so the form
 * only shows what it will accept.
 *
 * Two states: the stored values in a form, or could not be read, which says what
 * coordinators meet meanwhile and offers no form, since saving over values nobody read
 * would be a guess (L530). Client code because `SaveForm` guards what was typed.
 */
export function TransferOfferSettings({ settings }: { settings: Settings | null }) {
  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold">{COPY.heading}</h3>
      <p className={`mb-4 ${proseCls} text-xs text-fg-muted`}>{COPY.rule}</p>
      {settings === null ? (
        <div data-state="unreadable" className="rounded-sm border border-border bg-[var(--field)] p-4">
          <p className="text-sm text-fg">{COPY.unreadable}</p>
          <p className="mt-2 text-sm text-fg-muted">{COPY.unreadableMeanwhile}</p>
        </div>
      ) : (
        <SaveForm action={setTransferOfferSettings} name="transfer-offer" unsaved="the live transfer settings you typed" className="flex flex-wrap items-end gap-4">
          <div className="w-56">
            <label className={labelCls} htmlFor="transfer-threshold">
              {COPY.thresholdLabel}
            </label>
            <input
              id="transfer-threshold"
              name="transfer_offer_threshold"
              className={`${inputCls} tabular-nums`}
              type="number"
              inputMode="numeric"
              min={TRANSFER_THRESHOLD_MIN}
              max={TRANSFER_THRESHOLD_MAX}
              step={1}
              defaultValue={String(settings.threshold)}
              required
            />
          </div>
          <div className="w-56">
            <label className={labelCls} htmlFor="transfer-line">
              {COPY.lineLabel}
            </label>
            <input
              id="transfer-line"
              name="transfer_line"
              className={`${inputCls} tabular-nums`}
              type="text"
              inputMode="tel"
              autoComplete="off"
              spellCheck={false}
              defaultValue={settings.line}
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

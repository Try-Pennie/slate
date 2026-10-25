import { SaveForm } from "@/components/ui/SaveForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Field } from "@/components/admin/Field";
import { btnCls } from "@/components/ui/styles";
import { setEventTypeGap } from "@/app/admin/actions";
import type { EventType } from "@/lib/db/types";
import { loadedFieldName, loadedFieldValue } from "@/lib/admin/edit-version";

/**
 * Edit the gap kept between two calls on one advisor, in place on the listed
 * event type. It is the setting here an admin tunes as a lever on capacity (BC,
 * 2026-10-02), so it does not need an engineer.
 *
 * This is an EDIT of a stored record, so the field arrives holding the stored
 * value: unlike the add form, an untouched box submits exactly what is already
 * there. A stored pair that is not equal predates this control and is said as it
 * is, rather than shown as one number it is not.
 */
export function EventTypeGapForm({ eventType: e }: { eventType: EventType }) {
  const even = e.buffer_before_min === e.buffer_after_min;
  return (
    <SaveForm
      action={setEventTypeGap}
      name={`event-type-gap-${e.id}`}
      unsaved={`the gap between ${e.name} calls`}
      className="flex flex-wrap items-end gap-3"
    >
      <input type="hidden" name="event_type_id" value={e.id} />
      {/* #3122, #3798: the gap this form was drawn with, so a save over somebody
          else's newer gap is refused, while a save of the notice or the
          description in between is not. */}
      <input type="hidden" name={loadedFieldName("buffer_before_min")} value={loadedFieldValue(e.buffer_before_min)} />
      <input type="hidden" name={loadedFieldName("buffer_after_min")} value={loadedFieldValue(e.buffer_after_min)} />
      <Field
        name="gap_min"
        id={`field-gap_min-${e.id}`}
        label="Gap between calls (m)"
        defaultValue={even ? String(e.buffer_after_min) : undefined}
        placeholder={even ? undefined : `${e.buffer_before_min} before, ${e.buffer_after_min} after`}
        small
      />
      <SubmitButton className={btnCls} pendingLabel="Saving…">
        Save gap
      </SubmitButton>
    </SaveForm>
  );
}

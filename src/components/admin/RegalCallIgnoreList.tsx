"use client";

import { SaveForm } from "@/components/ui/SaveForm";
import { SelectField } from "@/components/ui/SelectField";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { DestructiveConfirm } from "@/components/ui/DestructiveConfirm";
import { btnCls, inputCls, labelCls } from "@/components/ui/styles";
import { shortStamp } from "@/lib/admin/last-changed";
import { IGNORE_REASON_MAX } from "@/lib/admin/regal-call-ignores";

export interface RegalIgnoreRowView {
  userId: string;
  person: string;
  email: string | null;
  reason: string;
  addedBy: string;
  addedAt: string;
}

/**
 * The Regal call ignore list (#2090): people whose calls in Regal are not reported
 * while Slate routes no bookings to them, each with the reason, who added them and
 * when, and a picker over the roster to add one.
 *
 * A PICKER, never a text box (L611): the list is a set of Slate users, and a typed
 * address offers every typo as an entry that suppresses nobody. People are shown by
 * name. Every entry is on screen with its reason, because a suppression set by hand
 * that is not visible somewhere is how a check quietly stops covering anybody
 * (L523), and removing one is confirmed with its consequence (L608).
 *
 * The table is hand written until the shared admin table component exists
 * (#1894): header and cell alignment come from one class per column so they cannot
 * drift apart (L553).
 */
export function RegalCallIgnoreList({
  rows,
  options,
  addAction,
  removeAction,
}: {
  rows: RegalIgnoreRowView[];
  options: { value: string; label: string }[];
  addAction: (form: FormData) => Promise<void>;
  removeAction: (form: FormData) => Promise<void>;
}) {
  const col = {
    person: "py-2 pr-4 text-left align-top",
    reason: "py-2 pr-4 text-left align-top",
    added: "py-2 pr-4 text-left align-top whitespace-nowrap",
    action: "py-2 text-right align-top",
  };
  return (
    <div className="space-y-5">
      {rows.length === 0 ? (
        <p className="text-sm text-fg">
          Nobody is on the list, so every agent Slate routes no bookings to is reported when they
          place a call in Regal.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-fg-muted">
              <tr>
                <th scope="col" className={`${col.person} font-semibold`}>
                  Person
                </th>
                <th scope="col" className={`${col.reason} font-semibold`}>
                  Why
                </th>
                <th scope="col" className={`${col.added} font-semibold`}>
                  Added
                </th>
                <th scope="col" className={`${col.action} font-semibold`}>
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId} className="border-t border-border" data-regal-ignore={r.userId}>
                  <td className={`${col.person} font-semibold text-fg`}>
                    {r.person}
                    {/* The address only where the name is not already it. */}
                    {r.email && r.email !== r.person && (
                      <span className="block text-xs font-normal text-fg-muted">{r.email}</span>
                    )}
                  </td>
                  <td className={`${col.reason} text-fg`}>{r.reason}</td>
                  <td className={`${col.added} text-xs text-fg-muted tabular-nums`}>
                    {r.addedBy}, {shortStamp(r.addedAt)}
                  </td>
                  <td className={col.action}>
                    <DestructiveConfirm
                      openLabel="Remove"
                      question={`Report ${r.person}'s calls in Regal again?`}
                      consequence={`The next call ${r.person} places while Slate routes no bookings to them sends an alert.`}
                      dismissLabel="Keep on the list"
                      confirmLabel="Remove from the list"
                      pendingLabel="Removing..."
                      action={removeAction}
                      hidden={<input type="hidden" name="user_id" value={r.userId} />}
                      openGroupClassName="flex justify-end"
                      panelClassName="text-left"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {options.length === 0 ? (
        <p className="text-sm text-fg-muted">Every agent is already on the list.</p>
      ) : (
        <SaveForm
          action={addAction}
          name="regal-ignore"
          unsaved="the person and the reason you entered"
          className="flex flex-wrap items-end gap-3"
        >
          <div className="w-72">
            <label className={labelCls} htmlFor="regal_ignore_person">
              Person
            </label>
            <SelectField
              id="regal_ignore_person"
              name="user_id"
              defaultValue=""
              placeholder="Pick an agent"
              options={options}
            />
          </div>
          <div className="min-w-[16rem] flex-1">
            <label className={labelCls} htmlFor="regal_ignore_reason">
              Why
            </label>
            <input
              id="regal_ignore_reason"
              name="reason"
              required
              maxLength={IGNORE_REASON_MAX}
              className={`${inputCls} w-full`}
            />
          </div>
          <SubmitButton className={btnCls} pendingLabel="Adding...">
            Add to the list
          </SubmitButton>
        </SaveForm>
      )}
    </div>
  );
}

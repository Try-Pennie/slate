import { createBucket, updateBucket } from "@/app/admin/actions";
import { seederOwnsCode } from "@/lib/xbc";
import { SubmitButton } from "@/components/ui/SubmitButton";
import {
  BucketCriteriaPicker,
  BucketMembersPicker,
} from "@/components/admin/BucketMembersPicker";
import { btnCls, inputCls, labelCls } from "@/components/ui/styles";
import type { RosterEntry } from "@/lib/admin/bucket-member-picker";
import type { Bucket, EventType } from "@/lib/db/types";
import { SelectField } from "@/components/ui/SelectField";
import { UnsavedGuard } from "@/components/ui/UnsavedGuard";

/**
 * The routing pool editor (#1748). Both of these were local helpers on the old
 * single page /admin; Buckets is its own route now, so they moved out with it
 * rather than being copied.
 *
 * The two pickers inside it are on-demand client components since #1760: this
 * form is rendered once per bucket (about 60 of them), and drawing the whole
 * roster and the whole attribute catalog inside each one put 8,820 `<input>`
 * elements on the page (9,450 measured on the served page across its 64 forms).
 * See `BucketMembersPicker.tsx` for the measurement and the form contract.
 */
export function BucketForm({
  bucket,
  eventTypes,
  roster,
  memberIds,
  catalog,
  eligibleCount,
  overflowTo = null,
}: {
  bucket?: Bucket;
  eventTypes: EventType[];
  /**
   * The org roster, already projected to what the editor draws. The picker reads
   * the same list from `RosterProvider`; this copy is what the fallback-agent
   * select and the label copy need on the server.
   */
  roster: RosterEntry[];
  memberIds: Set<string>;
  catalog: Record<string, string[]>;
  /**
   * How many bookable agents this bucket's criteria and members reach.
   *
   * `undefined` means NOT MEASURED, and it has its own sentence (#1929). It used
   * to default to 0, and zero is the state this panel paints in the error colour
   * with "bookings will fail", so a bucket the depth measurement had simply left
   * out was reported as broken. Two of them were, on every view, for months.
   */
  eligibleCount?: number;
  /** Where the routing ladder sends this bucket's leads when nobody matches, in
   *  words, or null when it reaches nobody (Dan, 2026-10-02). */
  overflowTo?: string | null;
}) {
  const editing = !!bucket;
  // #2006: what is read only is what the SEEDER writes, not "this bucket
  // exists". The seeder writes only the sixty XBC codes, so a bucket created by
  // hand keeps its own fields editable; #1935 froze those too and left a typo in
  // one permanent, since the create form is the only place they can be set.
  const seederOwned = editing && seederOwnsCode(bucket.code);
  const memberList = roster
    .map((u) => u.id)
    .filter((id) => memberIds.has(id))
    // A membership whose user is not on the roster still has to be posted back,
    // or saving this form would silently drop it (#1762).
    .concat([...memberIds].filter((id) => !roster.some((u) => u.id === id)));
  return (
    <form
      action={editing ? updateBucket : createBucket}
      autoComplete="off"
      className="space-y-3 rounded-md border border-border p-3"
    >
      {/* #2076: a bucket's name, code and criteria are typed by hand and exist
          nowhere else until this saves. */}
      <UnsavedGuard what="changes to this bucket" formName="bucket-form" />
      {editing && <input type="hidden" name="bucket_id" value={bucket.id} />}
      {editing && (
        <>
          {/* #1929: three states, and only ONE of them is a failure. A count
              that was never measured cannot be a prediction that bookings will
              fail, so it says what it is and keeps the muted treatment. */}
          <p
            className={`text-xs ${
              eligibleCount === 0 && !bucket.fallback_user_id && !overflowTo
                ? "text-[var(--error)]"
                : "text-fg-muted"
            }`}
          >
            {eligibleCount === undefined
              ? "Eligible agents not measured"
              : `${eligibleCount} eligible agent${eligibleCount === 1 ? "" : "s"}${
                  eligibleCount === 0
                    ? bucket.fallback_user_id
                      ? " (using fallback agent)"
                      : overflowTo
                        ? ` (leads go to ${overflowTo})`
                        : " (no fallback set, bookings will fail)"
                    : ""
                }`}
          </p>
          {/* #1760: two numbers sit on this panel and neither said what it
              measured. The eligible count is this bucket's depth; the manual
              members list is the whole org roster. Both are correct, and the gap
              between them read as a bug. */}
          <p className="text-xs text-fg-muted" data-testid="bucket-count-note">
            Eligible agents are the bookable people whose attributes match the
            criteria below, plus this bucket&rsquo;s manual members. The manual
            members list is drawn from the whole roster, so the two counts measure
            different things.
          </p>
        </>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          {/* #1901: the gloss was the real name. XBC is what the three digit
              routing code is called, in `xbc.ts`, in the URL contract and by the
              people who use it, so the label is the name rather than a generic
              word with the name in brackets after it. */}
          <label className={labelCls}>XBC</label>
          {/* #1935: EDITABLE WHEN CREATING, READ ONLY WHEN EDITING, and the same
              for the name and the criteria below.

              `scripts/seed-buckets.ts` refreshes a bucket's name and criteria on
              every run, from `src/lib/xbc.ts`, because that is what the seeder is
              for: a rule changing in one place and reaching all sixty buckets. So
              an edit here was accepted, written, and replaced by the next seed
              run, which is the #1874 defect exactly. An override that is silently
              undone is worse than none.

              The refusal does not live in this markup. `updateBucket` takes these
              from the stored row and ignores whatever is posted, and
              `scripts/test-seeder-owned-fields.ts` derives the boundary from the
              seeder's own row literal, so it cannot drift the next time the
              seeder grows a column. What is here is only the part a person can
              see: a field that cannot be typed into should not look like one. */}
          {seederOwned ? (
            <p className="mt-1 h-11 text-sm font-semibold tabular-nums leading-[2.75rem]">
              {bucket?.code}
            </p>
          ) : (
            <input
              name="code"
              aria-label="XBC"
              defaultValue={bucket?.code ?? ""}
              className={`${inputCls} w-28`}
              required
            />
          )}
        </div>
        <div>
          <label className={labelCls}>Name</label>
          {seederOwned ? (
            <p className="mt-1 h-11 text-sm leading-[2.75rem]">{bucket?.name}</p>
          ) : (
            <input
              name="name"
              aria-label="Name"
              defaultValue={bucket?.name ?? ""}
              className={inputCls}
              required
            />
          )}
        </div>
        <div>
          <label className={labelCls}>Event type</label>
          {/* #1849: `required` is gone with the native select and is not missed here:
              every option carries a real id, so there is no empty value it could
              have refused. A list that CAN be empty needs real validation
              instead, since a hidden input is not validated by the browser. */}
          <SelectField
            name="event_type_id"
            ariaLabel="Event type"
            defaultValue={bucket?.event_type_id ?? eventTypes[0]?.id ?? ""}
            className="w-full"
            options={eventTypes.map((e) => ({ value: e.id, label: e.name }))}
          />
        </div>
        <div>
          {/* heading-gloss-ok: optionality. */}
          <label className={labelCls}>Cal routing form id (optional)</label>
          <input
            name="routing_form_id"
            aria-label="Cal routing form id (optional)"
            defaultValue={bucket?.routing_form_id ?? ""}
            className={`${inputCls} w-44`}
          />
        </div>
        <div>
          {/* #1784: the same picker in single select mode, not a roster sized
              <select> per bucket. This one control was 8,755 <option> elements
              across the page, about 70% of its nodes, scaling with buckets times
              roster exactly as the member checkboxes had before #1760. */}
          <BucketMembersPicker
            mode="fallback"
            selectedIds={bucket?.fallback_user_id ? [bucket.fallback_user_id] : []}
            rosterTotal={roster.length}
          />
        </div>
      </div>
      {/* Read only on an existing bucket, for the reason recorded on the XBC
          field above: the seeder rewrites these from `xbc.ts` on every run. */}
      <BucketCriteriaPicker
        catalog={catalog}
        current={bucket?.criteria ?? {}}
        readOnly={seederOwned}
      />
      <BucketMembersPicker selectedIds={memberList} rosterTotal={roster.length} />
      <SubmitButton className={btnCls} pendingLabel={editing ? "Saving…" : "Creating…"}>
        {editing ? "Save bucket" : "Create bucket"}
      </SubmitButton>
    </form>
  );
}

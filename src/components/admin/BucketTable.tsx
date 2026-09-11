"use client";

import { useId, useState, type ReactNode } from "react";

import { Pill, type PillVariant } from "@/components/ui/Pill";
import { inputCls } from "@/components/ui/styles";
import {
  bucketHealth,
  bucketHealthLabel,
  bucketTableSummary,
  filterBucketRows,
  noMatchText,
  showsManualMembers,
  sortBucketRows,
  type BucketHealth,
  type BucketRow,
} from "@/lib/admin/bucket-table";

/**
 * Sixty routing pools, readable (#1896).
 *
 * ## The shape, and the one thing it must not undo
 *
 * A row per pool, and the editor for ONE pool at a time underneath the row it
 * belongs to. Editing in place rather than on its own route because the
 * neighbouring pools are the context: the matrix is what makes a pool's
 * configuration make sense, and a detail page throws it away.
 *
 * The editors arrive already rendered, from the server, in `forms`. That is not
 * incidental. `BucketForm` renders server actions and two on demand pickers, so
 * it cannot be built in the browser, and this component holds it as opaque
 * markup. Only the OPEN one is ever put in the DOM: rendering all sixty and
 * hiding them with CSS would keep every node on the page, which is the cost
 * #1760 and #1784 were spent removing (9,450 inputs, then 8,755 options).
 *
 * ## What it deliberately does not have
 *
 * No sort controls. The code IS the sort: three digits, one per dimension, so
 * ordering by code groups by debt tier, then backend, then legal, which is the
 * matrix's own order. A sortable column here would offer to destroy the one
 * arrangement that makes the table legible.
 *
 * No pagination. Sixty rows is a page somebody scans, and paging it would hide
 * exactly the comparison the table exists for.
 */

const HEALTH_PILL: Record<BucketHealth, PillVariant> = {
  blocked: "status-error",
  "fallback-only": "status-pending",
  staffed: "status-ok",
  unmeasured: "outline",
};

export function BucketTable({
  rows,
  forms,
  newForm,
}: {
  rows: BucketRow[];
  /**
   * The editor for each pool, keyed by bucket id, rendered on the SERVER.
   * Opaque here: this component decides which one is on screen and never what
   * is in it.
   */
  forms: Record<string, ReactNode>;
  newForm: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const filterId = useId();
  const blockedId = useId();

  const filter = { query, blockedOnly };
  const shown = sortBucketRows(filterBucketRows(rows, filter));
  const withMembers = showsManualMembers(rows);
  const blockedTotal = rows.filter((r) => bucketHealth(r) === "blocked").length;

  const open = (id: string) => {
    // One editor at a time, and opening one closes the create form. Two open
    // forms on a page whose fields have the same names is a person about to
    // save the wrong one.
    setCreating(false);
    setOpenId((current) => (current === id ? null : id));
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-fg-muted">{bucketTableSummary(rows)}</p>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-xs font-semibold text-fg-muted" htmlFor={filterId}>
            Find a pool
          </label>
          <input
            id={filterId}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="code, or a tier or backend name"
            className={`${inputCls} w-72`}
          />
        </div>
        {/* Offered only when there is something to filter DOWN to. A checkbox
            that can only ever empty the table is a control with no use, and it
            reads as though the page is hiding something (L187 in reverse: the
            control is gated on the state it acts on existing). */}
        {blockedTotal > 0 && (
          <label className="flex items-center gap-2 pb-3 text-sm" htmlFor={blockedId}>
            <input
              id={blockedId}
              type="checkbox"
              checked={blockedOnly}
              onChange={(e) => setBlockedOnly(e.target.checked)}
              className="h-4 w-4"
            />
            Only the {blockedTotal} that can take no booking
          </label>
        )}
      </div>

      {shown.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-fg-muted">
          {noMatchText(filter, rows.length)}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs font-semibold text-fg-muted">
                {/* The header alignment and the cells' alignment are one fact
                    set at two sites, so they are written to match deliberately
                    (L553): the code and the count are the two that sit right. */}
                <th scope="col" className="py-2 pr-4 text-right">XBC</th>
                <th scope="col" className="py-2 pr-4">Debt tier</th>
                <th scope="col" className="py-2 pr-4">Backend</th>
                <th scope="col" className="py-2 pr-4">Legal</th>
                {/* #2237: which of the fifteen pools this code routes through.
                    It sits right of the three digits on purpose, so a reader
                    sees the decomposition and then sees that changing the Legal
                    digit does not change the pool. */}
                <th scope="col" className="py-2 pr-4">Pool</th>
                {withMembers && (
                  <th scope="col" className="py-2 pr-4 text-right">Members</th>
                )}
                <th scope="col" className="py-2 pr-4">Who can take a booking</th>
                <th scope="col" className="py-2">
                  <span className="sr-only">Edit</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => {
                const isOpen = openId === row.id;
                return (
                  <FragmentRow
                    key={row.id}
                    row={row}
                    isOpen={isOpen}
                    onToggle={() => open(row.id)}
                    form={forms[row.id]}
                    withMembers={withMembers}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="border-t border-border pt-4">
        {creating ? (
          <>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">
              New bucket
            </h3>
            {newForm}
            <button
              type="button"
              className="mt-2 text-xs underline text-fg-muted"
              onClick={() => setCreating(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          // #1896: the create form used to sit open at the foot of sixty
          // identical edit forms, indistinguishable from them. A pool is made
          // rarely and edited often, so making one is now a thing you ask for.
          <button
            type="button"
            className="pn-btn pn-btn--small pn-btn--additional"
            onClick={() => {
              setOpenId(null);
              setCreating(true);
            }}
          >
            New bucket
          </button>
        )}
      </div>
    </div>
  );
}

function FragmentRow({
  row,
  isOpen,
  onToggle,
  form,
  withMembers,
}: {
  row: BucketRow;
  isOpen: boolean;
  onToggle: () => void;
  form: ReactNode;
  withMembers: boolean;
}) {
  const health = bucketHealth(row);
  return (
    <>
      <tr className={`border-b border-border ${isOpen ? "bg-bg-alt" : ""}`}>
        <td className="py-2 pr-4 text-right font-semibold tabular-nums">{row.code}</td>
        {row.matrix ? (
          <>
            <td className="py-2 pr-4">{row.matrix.tier}</td>
            <td className="py-2 pr-4">{row.matrix.backend}</td>
            <td className="py-2 pr-4">{row.matrix.legal}</td>
          </>
        ) : (
          // A hand made pool has no three way decomposition, so it shows its own
          // name across those cells rather than three blanks that read as
          // missing data.
          <td className="py-2 pr-4" colSpan={3}>
            {row.name} <span className="text-xs text-fg-muted">(made by hand)</span>
          </td>
        )}
        <td className="py-2 pr-4">
          {row.pool.label ?? (
            <span className="text-xs text-fg-muted">Not a routing pool</span>
          )}
        </td>
        {withMembers && (
          <td className="py-2 pr-4 text-right tabular-nums">{row.manualMembers}</td>
        )}
        <td className="py-2 pr-4">
          {/* `alignToColumn` because this pill STARTS its cell: without it the
              label sits 9px right of the column header above it (#1821). */}
          <Pill variant={HEALTH_PILL[health]} alignToColumn>
            {bucketHealthLabel(row)}
          </Pill>
        </td>
        <td className="py-2 text-right">
          {/* The NAME carries the code, the visible label does not. Sixty
              buttons all called "Edit" are sixty identical announcements, and a
              screen reader user tabbing the table has no idea which pool they
              are on.

              It is an `aria-label` rather than a visually hidden span beside the
              text, because the accessible name is built by CONCATENATING the
              text nodes with no separator: written that way it computed as
              "Edit100", measured in jsdom before this was changed. The label
              still STARTS with the visible word, so somebody driving by voice
              can say what they can see. */}
          <button
            type="button"
            className="pn-btn pn-btn--small pn-btn--additional"
            aria-expanded={isOpen}
            aria-label={`${isOpen ? "Close" : "Edit"} ${row.code}`}
            onClick={onToggle}
          >
            {isOpen ? "Close" : "Edit"}
          </button>
        </td>
      </tr>
      {isOpen && (
        <tr className="border-b border-border bg-bg-alt">
          <td colSpan={withMembers ? 8 : 7} className="px-2 py-3">
            {form}
          </td>
        </tr>
      )}
    </>
  );
}

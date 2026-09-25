import { Pill, type PillVariant } from "@/components/ui/Pill";
import { cardCls, proseCls } from "@/components/ui/styles";
import {
  entryStatus,
  entryAgeDays,
  worklistOrder,
  type EntryStatus,
  type ErasureWorklistState,
} from "@/lib/snowflake/erasure-worklist";
import {
  emptyTrailText,
  entryResidualText,
  entryStatusLabel,
  howToPurgeText,
  trailUnreadableText,
  warehouseUnconfiguredText,
  warehouseUnreadableText,
  worklistHeadline,
  entryAgeText,
  deadlineNote,
} from "@/lib/snowflake/erasure-worklist-copy";
import { summarizeWorklist } from "@/lib/snowflake/erasure-worklist";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";

/**
 * The erasure worklist: what the warehouse still holds, and nothing else
 * (#1124, made read only by #1961).
 *
 * ## Why the controls went
 *
 * Dan, 2026-09-04: "feels like it shouldn't be this easy to purge data and I
 * think I'd prefer to go through Claude to do it." Both controls have gone, the
 * single and the bulk, on his decision of 2026-09-06.
 *
 * The QUEUE stays, and keeping it is the point rather than a consolation. An
 * erasure request carries a statutory deadline, so what is outstanding and how
 * long it has been outstanding is a thing somebody has to be able to look at.
 * Deleting the page with the buttons would have removed the only view of an
 * obligation with a clock on it. Hard to purge, easy to see what is owed.
 *
 * ## Read only means it does not write, not that it says nothing
 *
 * A screen that names a fault and offers no remedy teaches people to skim it
 * (L126, L148), so the page says how a purge IS run now rather than leaving
 * somebody staring at an outstanding row with nothing to do. The remedy is an
 * instruction to a person, which is exactly what it should be for an
 * irreversible deletion of customer data.
 *
 * It is a SERVER component now. Every piece of state it held existed to drive
 * the purge: the confirmation, the elapsed second count, the outcome panel, the
 * abort. With the controls gone it draws what it was handed, so nothing about it
 * needs to reach the browser at all.
 */

const STATUS_PILL: Record<EntryStatus, PillVariant> = {
  clean: "status-ok",
  outstanding: "status-error",
  unknown: "status-pending",
};

/** Absolute local time: an erasure is a compliance record read weeks later. */
function stamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export function ErasureWorklist({
  state,
  viewerRunsPurge,
}: {
  state: ErasureWorklistState;
  /** Whether the viewer is the one who runs the warehouse purge (#2699). */
  viewerRunsPurge: boolean;
}) {
  if (state.kind === "trail-unreadable") {
    return (
      <div role="alert" className="rounded-xl border border-[var(--error)] px-5 py-4 text-sm text-error">
        {trailUnreadableText(state.reason)}
      </div>
    );
  }

  // #1961: the instant every age is measured from. It comes with the state,
  // taken beside the read it describes, because rendering may not read a clock.
  const { warehouse, nowMs } = state;
  // Outstanding first and oldest first inside that: the entry that has been
  // waiting longest is the one closest to a deadline, and a list rendered in
  // whatever order the store returned puts it anywhere (L343).
  const entries = worklistOrder(state.entries, nowMs);
  const summary = summarizeWorklist(entries, nowMs);

  return (
    <div className="space-y-6">
      <AdminPageHeader title={worklistHeadline(summary)}>
        The Supabase half of every erasure is already done. This is the warehouse
        half: what Snowflake still holds for the people whose data Slate has
        erased, and how long each one has been waiting.
      </AdminPageHeader>

      {/* #1961: what the days on each row are counted from, and the one thing
          this page cannot tell you. Said once, above the list, rather than on
          every row. */}
      <p className={`text-xs text-fg-muted ${proseCls}`}>{deadlineNote()}</p>

      {warehouse.kind === "unreadable" && (
        <div role="alert" className="rounded-xl border border-[var(--error)] px-5 py-4 text-sm text-error">
          {warehouseUnreadableText(warehouse.reason)}
        </div>
      )}
      {warehouse.kind === "unconfigured" && (
        <div role="alert" className="rounded-xl border border-border bg-bg-alt px-5 py-4 text-sm text-fg-muted">
          {warehouseUnconfiguredText()}
        </div>
      )}

      {entries.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-fg-muted">
          {emptyTrailText()}
        </p>
      ) : (
        <ul className="space-y-4">
          {entries.map((e) => {
            const status = entryStatus(e);
            return (
              <li key={e.auditId} className={cardCls}>
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg">
                    <Pill variant={STATUS_PILL[status]}>{entryStatusLabel(status)}</Pill>
                    <span className="tabular-nums text-fg-muted">{stamp(e.createdAt)}</span>
                  </p>
                  <p className="mt-1 text-sm text-fg">{entryAgeText(entryAgeDays(e.createdAt, nowMs))}</p>
                  <p className="mt-2 font-mono text-xs break-all text-fg-muted">
                    {e.emailSha256
                      ? `email hash ${e.emailSha256.slice(0, 12)}`
                      : "no email hash recorded"}
                    {`, ${e.bookingIds.length} booking${e.bookingIds.length === 1 ? "" : "s"}`}
                  </p>
                  <p className="mt-2 text-sm text-fg-muted">{entryResidualText(e)}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* #1961: the page names a fault, so it must name the remedy, or it
          teaches its reader to skim it (L126, L148). There is no control here on
          purpose, and saying so is part of the answer: an irreversible deletion
          of customer data is an instruction to a person, not a button. */}
      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">How an outstanding purge is run</h2>
        <p className={`text-xs text-fg-muted ${proseCls}`}>{howToPurgeText(viewerRunsPurge)}</p>
      </section>
    </div>
  );
}

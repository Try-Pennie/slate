import { DateTime } from "luxon";
import { formatLongDate } from "@/lib/date/parse";
import {
  dayIsClosed,
  debtTierDigitOf,
  supplyPoolGroups,
  supplyTotals,
  type BucketSupplyRow,
  type SupplyDay,
} from "@/lib/admin/bucket-supply";
import { DEBT_TIER } from "@/lib/xbc";
import { LegendList } from "@/components/ui/LegendList";
import { DayHeaderCell } from "@/components/ui/DayHeaderCell";
import {
  SUPPLY_ALARMING_STATES,
  SUPPLY_DAY_GROUP_HEADER,
  SUPPLY_LEGEND,
  SUPPLY_SUMMARY_STATES,
  agentCountLabel,
  cellStyle,
  computedAtLabel,
  freshnessLabel,
  overflowNote,
  poolRowDetail,
  poolRowName,
  sharePercent,
  supplyCellTitle,
  supplyLegendEntry,
} from "@/lib/admin/bucket-supply-copy";

/**
 * The per bucket supply table and its key (#1254).
 *
 * A component rather than markup inside the page so the rendering can be driven
 * by a test. What a cell shows is a number, and the sentence behind that number
 * is the only thing a screen reader gets, so a static check on the copy builder
 * cannot prove the sentence reaches the screen.
 *
 * Rows are grouped by the DEBT TIER, descending, because that is the axis Dan
 * reads the page by (#1942): Ultra High first, Low last.
 *
 * THE BACKEND PATTERN IS STILL REAL, and it is recorded here rather than deleted
 * because it survived a re-measurement. The original grouping was chosen on
 * 2026-08-04, while the roster was deliberately dark (#1272), so it was worth
 * re-taking once the roster went live on 2026-09-02. Measured again on
 * 2026-09-05, across all sixty buckets, in cached slots per bucket:
 *
 *   by backend   0: mean 355    1: mean 355    2: mean 57    3: mean 355
 *   by debt tier 1: mean 352    2: 367    3: 289    4: 205    5: mean 190
 *
 * So backend 2 (Beyond) is still a step change rather than a gradient, and it is
 * still all fifteen of them, including the only three buckets offering nothing at
 * all (120, 121, 122). The debt tier is a real gradient too, thinning as the tier
 * rises, which is the same direction the original note recorded.
 *
 * The backend stays the SECONDARY sort, so those fifteen still land together
 * inside each tier. It is no longer a group heading, and it needs no separate
 * label because each row's own name already carries it (`Low | Beyond | Legal`).
 *
 * TWO VIEWS (2026-10-02). Admins see one row per bucket code, with the code,
 * because codes are how they configure buckets. Managers see one row per routing
 * POOL, named in words ("Low with Beyond"), and no code anywhere: not in the row
 * header and not in a cell's sentence. The pools come from `supplyPoolGroups`,
 * which collapses a pool's codes only where every one of them reads alike, so a
 * disagreement stays on screen as separate rows rather than being decided here.
 */
export function BucketSupplyTable({
  days,
  rows,
  showCodes,
  zone,
  nowMs,
  depthReadable,
  bucketListReadable,
}: {
  days: SupplyDay[];
  rows: BucketSupplyRow[];
  /** True for admins: one row per code, with the code. False for managers: one
   *  row per pool, in words. Decided by the page from the viewer's role. */
  showCodes: boolean;
  zone: string;
  /** The instant the loader judged every freshness state against, so the age a
   *  row shows and the grade it was given come from ONE clock read (#1938). */
  nowMs: number;
  depthReadable: boolean;
  bucketListReadable: boolean;
}) {
  // Grouped ONCE, and the same groups feed both the counts and the manager rows,
  // so the two cannot disagree about what a pool is.
  const poolGroups = supplyPoolGroups(rows, nowMs);
  const totals = supplyTotals(poolGroups, 0);
  const closedToday = dayIsClosed(rows, 0);
  // What each drawn row is. For a manager it is a pool (its first code stands in
  // for the readings, which agree by construction of the group); for an admin it
  // is a code. The summary counts POOLS either way, because `supplyTotals` does,
  // so "across N pools" and the counts under it describe the same things, and
  // for a manager N is exactly the number of rows on screen.
  //
  // A SPLIT pool (codes that disagree) draws several rows under one pool name,
  // so each of those carries a muted line saying which bucket it is, in words
  // (`poolRowDetail`), never by code. A uniform pool needs none.
  const drawn: { key: string; row: BucketSupplyRow; name: string; detail: string | null }[] =
    showCodes
      ? rows.map((r) => ({ key: r.code, row: r, name: r.name, detail: null }))
      : poolGroups.map((g) => {
          const first = g.rows[0]!;
          const name = poolRowName(first);
          const detail = g.uniform ? null : poolRowDetail(first);
          return { key: g.codes.join(","), row: first, name, detail: detail === name ? null : detail };
        });
  const todayLabel = days[0]
    ? (formatLongDate(DateTime.fromISO(days[0].iso, { zone })) ?? "today")
    : "today";

  // One `tbody` per DEBT TIER, descending, each opening with a `scope="rowgroup"`
  // heading (#1942). The structure is unchanged and deliberate: the table stays
  // ONE table (one caption, one set of column headers a screen reader can
  // associate every cell with) and the group label is a real heading for the
  // rows under it rather than a styled row that happens to look like one. Only
  // what it groups BY has changed.
  //
  // The tier is read off a row's code, which is never drawn for a manager: it
  // only decides which heading a pool sits under.
  const groups: { label: string; rows: typeof drawn }[] = [];
  for (const item of drawn) {
    const digit = debtTierDigitOf(item.row.code);
    const label =
      digit === null
        ? showCodes
          ? "Other codes"
          : "Other pools"
        : `${DEBT_TIER[digit]?.label ?? digit} debt`;
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.rows.push(item);
    else groups.push({ label, rows: [item] });
  }

  return (
    <>
      {/* #1938: ONE vocabulary. Every chip here takes its words from the same
          legend entry the key below the table explains, so a state is named
          once and a reader who learns it in one place can use it in the other.
          The scope is stated ONCE, above the chips, rather than repeated as
          "today" on the end of each of them (L287). */}
      <div className="mb-4 text-sm">
        <p className="mb-1.5 text-xs uppercase tracking-wide text-fg-muted">
          Today, {todayLabel}, across {poolGroups.length}{" "}
          {poolGroups.length === 1 ? "pool" : "pools"}
        </p>
        {/* A shut day is a real answer about the org and it is not six zeros
            (L10). Every count below refuses to count what it could not measure,
            so on a Sunday they all read zero, which is exactly what a working
            day on which nothing was found looks like. The words are the key's
            own, so this is not a second name for the state. */}
        {closedToday ? (
          <p className="text-fg-muted">
            {/* The key's own LABEL for the state, so this is not a second name
                for it. Its `meaning` is written for a cell ("that day") and
                reads wrong directly under a line that has just said "Today". */}
            {supplyLegendEntry("closed").label}, so there was nothing to measure.
          </p>
        ) : (
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
          {SUPPLY_SUMMARY_STATES.map(({ totalsKey, legendId }) => {
            const entry = supplyLegendEntry(legendId);
            const count = totals[totalsKey];
            const alarming = SUPPLY_ALARMING_STATES.includes(legendId) && count > 0;
            return (
              <span
                key={legendId}
                className={alarming ? "text-error" : "text-fg-muted"}
                title={entry.meaning}
              >
                {entry.label}{" "}
                <span className={`font-semibold tabular-nums ${alarming ? "" : "text-fg"}`}>
                  {count}
                </span>
              </span>
            );
          })}
          {/* Not a cell state but a property of the ROW, so it is counted apart.
              Its words come from the same builder the Last computed column uses. */}
          <span
            className={totals.stale > 0 ? "text-error" : "text-fg-muted"}
            title={freshnessLabel("stale").meaning}
          >
            {freshnessLabel("stale").label} or{" "}
            {freshnessLabel("unknown").label.toLowerCase()}{" "}
            <span className={`font-semibold tabular-nums ${totals.stale > 0 ? "" : "text-fg"}`}>
              {totals.stale}
            </span>
          </span>
        </div>
        )}
        {/* Freshness is a property of the ROW, not of the day, so it is stated
            whether the office is open or not: a stale row is stale on a Sunday. */}
        {closedToday && totals.stale > 0 && (
          <p className="mt-1 text-error">
            {freshnessLabel("stale").label} or {freshnessLabel("unknown").label.toLowerCase()}{" "}
            <span className="font-semibold tabular-nums">{totals.stale}</span>
          </p>
        )}
      </div>

      {!depthReadable && (
        <p className="mb-4 rounded-md border border-border bg-[var(--bg-alt)] px-4 py-3 text-sm text-fg-muted">
          The roster could not be read, so both agent columns say unknown throughout.
          That is not a report that no agent can take these bookings. Without the roster the
          buckets cannot be matched to their pools, so each booked share beside it counts only
          the bookings made through that bucket.
        </p>
      )}
      {!bucketListReadable && (
        <p className="mb-4 rounded-md border border-border bg-[var(--bg-alt)] px-4 py-3 text-sm text-fg-muted">
          The bucket list could not be read, so these rows come from the slot cache alone. A
          bucket that has never been computed will be missing from this table entirely.
        </p>
      )}

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[860px] border-collapse text-sm">
          <caption className="sr-only">
            The share of each debt bucket&apos;s possible appointment times that are booked, day by
            day. Rows are grouped by debt tier, highest first, and inside each tier the pools with
            nobody available, an unreadable answer or an out of date one come first. Times are{" "}
            {zone}.
          </caption>
          {/* #1938: TWO header rows, because the clarity has to come from
              structure rather than from a paragraph above the table.
              `Eligible agents` did not say eligible for what and carried a
              second number in a bracket; the day columns carried no unit at
              all, and the only place that said these were appointment times was
              the sentence a reader arrives at last. Each spanning header answers
              its group once, where the numbers are. */}
          <thead>
            <tr className="border-b border-border bg-[var(--bg-alt)] text-xs text-fg-muted">
              <th scope="col" rowSpan={2} className="px-3 py-2.5 text-left align-bottom font-semibold">
                {showCodes ? "Bucket" : "Pool"}
              </th>
              <th
                scope="colgroup"
                colSpan={2}
                className="border-l border-border px-3 pt-2.5 pb-1 text-left font-semibold"
              >
                Agents who can take these bookings
              </th>
              <th
                scope="col"
                rowSpan={2}
                className="border-l border-border px-3 py-2.5 text-left align-bottom font-semibold"
              >
                Last computed
              </th>
              <th
                scope="colgroup"
                colSpan={days.length}
                className="border-l border-border px-2 pt-2.5 pb-1 text-center font-semibold"
              >
                {SUPPLY_DAY_GROUP_HEADER}
              </th>
            </tr>
            <tr className="border-b border-border bg-[var(--bg-alt)] text-xs text-fg-muted">
              <th scope="col" className="border-l border-border px-3 pb-2.5 text-left font-normal">
                Eligible
              </th>
              <th scope="col" className="px-3 pb-2.5 text-left font-normal">
                Available today
              </th>
              {days.map((day, i) => (
                <DayHeaderCell
                  key={day.iso}
                  iso={day.iso}
                  zone={zone}
                  className={`px-2 pb-2.5 font-semibold ${i === 0 ? "border-l border-border" : ""}`}
                />
              ))}
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.label}>
              <tr className="border-b border-border bg-[var(--bg-alt)]">
                <th
                  scope="rowgroup"
                  colSpan={4 + days.length}
                  className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-fg-muted"
                >
                  {group.label}
                </th>
              </tr>
              {group.rows.map(({ key, row, name, detail }) => {
                const fresh = computedAtLabel(row.freshness, row.computedAtMs, nowMs);
                const bucketLabel = showCodes
                  ? `${row.code} ${name}`
                  : detail
                    ? `${name}, ${detail}`
                    : name;
                // Where an empty pool's leads go, said once on the row rather
                // than in every cell, because the cells only say THAT they go.
                const overflow = overflowNote(row.cells);
                return (
                  <tr key={key} className="border-b border-border align-middle last:border-0">
                    <th scope="row" className="px-3 py-2 text-left font-normal">
                      {showCodes ? (
                        <>
                          <span className="block font-semibold tabular-nums text-fg">{row.code}</span>
                          <span className="block text-xs text-fg-muted">{name}</span>
                        </>
                      ) : (
                        <>
                          <span className="block font-semibold text-fg">{name}</span>
                          {detail && <span className="block text-xs text-fg-muted">{detail}</span>}
                        </>
                      )}
                      {overflow && <span className="block text-xs text-fg-muted">{overflow}</span>}
                    </th>
                    <td className="border-l border-border px-3 py-2 tabular-nums">
                      <span className={row.depth === null ? "text-fg-muted" : "text-fg"}>
                        {agentCountLabel(row.depth)}
                      </span>
                    </td>
                    {/* #1938: the two counts are a RELATIONSHIP, and encoding it
                        as `84 (75 today)` made a reader decode before they could
                        read. Side by side it is visible.

                        Only ZERO is emphasised, and deliberately no "much lower
                        than eligible" rule: any threshold for that would be one
                        invented here (L172), and 75 of 84 is unremarkable while
                        a column of amber would teach a reader to ignore it. Zero
                        is a fact rather than a judgement, and it is the same
                        thing the `nobody available` cell says. */}
                    <td className="px-3 py-2 tabular-nums">
                      <span
                        className={
                          row.effectiveDepth === null
                            ? "text-fg-muted"
                            : row.effectiveDepth === 0
                              ? "font-semibold text-error"
                              : "text-fg"
                        }
                      >
                        {agentCountLabel(row.effectiveDepth)}
                      </span>
                    </td>
                    <td className="border-l border-border px-3 py-2">
                      <span
                        className={
                          row.freshness === "stale" || row.freshness === "unknown"
                            ? "text-error"
                            : "text-fg-muted"
                        }
                        title={fresh.meaning}
                      >
                        {fresh.label}
                      </span>
                    </td>
                    {row.cells.map((cell, i) => {
                      const style = cellStyle(cell);
                      const dayLabel =
                        formatLongDate(DateTime.fromISO(days[i].iso, { zone })) ?? days[i].iso;
                      const title = supplyCellTitle(cell, bucketLabel, dayLabel);
                      return (
                        <td
                          key={days[i].iso}
                          className={`p-0.5 ${i === 0 ? "border-l border-border" : ""}`}
                        >
                          <span
                            className={`flex h-9 flex-col items-center justify-center rounded text-xs font-semibold tabular-nums ${style.cell}`}
                            title={title}
                          >
                            {cell.kind === "counted" ? (
                              <>
                                {/* #1937: the share LEADS, and the ceiling it was
                                    measured against sits under it, so a 0% is
                                    read as "none of 204 taken" rather than as a
                                    bare zero. A bucket with no capacity at all is
                                    a different cell kind entirely, since it has
                                    no ceiling to be a share of. */}
                                <span aria-hidden="true">{sharePercent(cell.share)}%</span>
                                <span aria-hidden="true" className="font-normal">
                                  of {cell.capacity}
                                </span>
                              </>
                            ) : (
                              <span aria-hidden="true">{style.mark}</span>
                            )}
                            <span className="sr-only">{title}</span>
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          ))}
          {groups.length === 0 && (
            <tbody>
              <tr>
                <td
                  colSpan={4 + days.length}
                  className="px-4 py-10 text-center text-sm text-fg-muted"
                >
                  No buckets yet. Create one on the admin page to route bookings.
                </td>
              </tr>
            </tbody>
          )}
        </table>
      </div>

      {/* #1925: the same shared key as /admin/availability. This markup was
          character for character the same wrapping flow row, and fixing one
          while leaving the other is exactly how the two drift. The swatches are
          wider here because these marks are percentages rather than letters.

          NOT filtered to the states present, unlike the grid's key: this page's
          totals are counts of shares (saturated, part booked, nothing booked)
          and do not map one to one onto the seven entries here, so deriving it
          would be a different change rather than the same one. */}
      <LegendList entries={SUPPLY_LEGEND} swatchCls="h-5 w-8" />

      <p className="mt-4 text-xs text-fg-muted">
        {/* #1937: this described the OLD ceiling, one synthetic ideal agent's grid
            across the office day, which is what the shares were being divided by
            when they ran to 189%.

            #1938: it no longer has to introduce the page, only to say where the
            numbers come from, because the column headers now carry the unit and
            the question. Today's date moved into the summary line above, where
            the counts it scopes are. */}
        Every number is read from the slot cache the booker itself serves, plus the bookings
        already made, so this page adds no calendar traffic and nothing here is a live check of
        a calendar. What a share is measured against is what THAT pool could have taken: the
        times it is still offering plus the times already booked, counted as start times. A time
        nobody in the pool was ever free for was never a possible appointment, so it is in
        neither.
      </p>
    </>
  );
}

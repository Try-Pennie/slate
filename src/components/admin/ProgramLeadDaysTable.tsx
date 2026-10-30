import { DateTime } from "luxon";
import { PLACEHOLDER_DAY_ZONE } from "@/lib/booking/program-lead-times";
import { PROGRAM_LEADS_COPY } from "@/lib/admin/program-leads-copy";
import type { ProgramLeadDay } from "@/lib/admin/program-lead-days";

const COPY = PROGRAM_LEADS_COPY.days;

/**
 * The program leads admin page's last 14 Eastern days (#4392), drawn as the admin area's
 * tables are (/admin/tiers): a bordered, horizontally scrolling table on the card, the
 * header row on `--bg-alt`, tabular figures.
 *
 * The columns are grouped under which day they count by, since a reader comparing a refusal
 * with a booking would otherwise assume one day (`ProgramLeadDay`). Within the call day
 * group they read as a funnel, bookings then those on the placeholder then those of them
 * Regal never called. A zero is muted and a count is in the body colour, so a busy day
 * stands out from the many quiet ones (L609); a call with no Regal call is in rose AND is a
 * number, so colour is never the only signal.
 *
 * The two terms a reader cannot know are explained once, on the term (L604): a `title` for a
 * pointer and an `sr-only` span for a screen reader, as the Bookable agents column on
 * /admin/tiers does.
 *
 * A server component: it draws what it is handed and reads nothing.
 */
export function ProgramLeadDaysTable({ rows }: { rows: ProgramLeadDay[] }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="bg-[var(--bg-alt)] text-xs text-fg-muted">
            <td className="px-4 pt-2.5" />
            <th scope="colgroup" colSpan={3} className="border-l border-border px-3 pt-2.5 text-left font-semibold">
              {COPY.byCallDay}
            </th>
            <th scope="colgroup" colSpan={2} className="border-l border-border px-3 pt-2.5 text-left font-semibold">
              {COPY.byEventDay}
            </th>
          </tr>
          <tr className="border-b border-border bg-[var(--bg-alt)] text-xs text-fg-muted">
            <th scope="col" className="px-4 py-2.5 text-left font-semibold">
              {COPY.dayColumn}
            </th>
            <th scope="col" className="border-l border-border px-3 py-2.5 text-right font-semibold">
              {COPY.bookings}
            </th>
            <th scope="col" className="px-3 py-2.5 text-right font-semibold">
              {COPY.onPlaceholder}
            </th>
            <th scope="col" className="px-3 py-2.5 text-right font-semibold" title={COPY.noRegalCallTerm}>
              {COPY.noRegalCall}
              <span className="sr-only">{` (${COPY.noRegalCallTerm})`}</span>
            </th>
            <th scope="col" className="border-l border-border px-3 py-2.5 text-right font-semibold">
              {COPY.limitRefused}
            </th>
            <th scope="col" className="px-4 py-2.5 text-right font-semibold" title={COPY.fallbacksTerm}>
              {COPY.fallbacks}
              <span className="sr-only">{` (${COPY.fallbacksTerm})`}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row, i) => (
            <tr key={row.day} className="transition-colors hover:bg-[var(--bg-alt)]">
              <th scope="row" className="px-4 py-3 text-left font-semibold text-fg">
                {i === 0 ? COPY.today : dayLabel(row.day)}
              </th>
              <Count value={row.bookings} divided />
              <Count value={row.onPlaceholder} />
              <td className="px-3 py-3 text-right tabular-nums">
                <span className={row.noRegalCall > 0 ? "font-semibold text-error" : "text-fg-muted"}>{row.noRegalCall}</span>
                {row.notKnownYet > 0 && (
                  <span className="block text-xs text-fg-muted" title={COPY.notKnownYetTerm}>
                    {COPY.notKnownYet(row.notKnownYet)}
                    <span className="sr-only">{` (${COPY.notKnownYetTerm})`}</span>
                  </span>
                )}
              </td>
              <Count value={row.limitRefused} divided />
              <Count value={row.fallbacks} last />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Count({ value, divided = false, last = false }: { value: number; divided?: boolean; last?: boolean }) {
  return (
    <td
      className={`${last ? "px-4" : "px-3"} py-3 text-right tabular-nums ${divided ? "border-l border-border " : ""}${
        value > 0 ? "text-fg" : "text-fg-muted"
      }`}
    >
      {value}
    </td>
  );
}

/** "Tue, Oct 27": the Eastern day, read in its own zone so it never shifts a day. */
function dayLabel(day: string): string {
  return DateTime.fromISO(day, { zone: PLACEHOLDER_DAY_ZONE }).setLocale("en-US").toFormat("ccc, LLL d");
}

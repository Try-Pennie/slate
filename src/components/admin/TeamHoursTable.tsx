import Link from "next/link";
import { WEEKDAY_NAMES } from "@/lib/schedule-core";
import { setByLabel, type SetBy, type TeamHoursGroup, type TeamHoursRow } from "@/lib/admin/team-hours";
import { cardCls } from "@/components/ui/styles";

/**
 * Every agent's zone and week, one table per team (#1757).
 *
 * The table follows the house structure `RosterTable` set (bordered scroll wrapper,
 * tinted header row, divided body) because there is no shared table component to
 * adopt yet: #1894 is the issue that extracts one, and this is one more site it
 * converts.
 *
 * A week is seven columns rather than the one sentence the hours editor prints
 * above its rows, because the job here is spotting the odd one out across a team,
 * and an aligned column shows a 10:00am start among 9:00am starts at a glance where
 * thirty sentences do not.
 */
const DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const SHORT = (weekday: number) => WEEKDAY_NAMES[weekday]!.slice(0, 3);

/** The sources somebody should check, drawn at full ink: a week copied from
 *  cal.com that the agent has not confirmed, and the untouched company default. */
const EXCEPTIONS: ReadonlySet<SetBy> = new Set<SetBy>(["calcom-import", "seed"]);

/** What the dash in the Set by column means, said once per table (#1757). */
const DASH_MEANS =
  "a dash means the week was written before Slate recorded who sets hours";

function teamHeading(g: TeamHoursGroup): string {
  if (g.managerId === null) return "No manager of record";
  // A manager id the roster read cannot name (the manager left, or is outside it)
  // still gets a team rather than vanishing, under a heading that says so.
  return g.managerName ?? "A manager no longer on the roster";
}

function Row({ r }: { r: TeamHoursRow }) {
  return (
    <tr className="transition-colors hover:bg-[var(--bg-alt)]">
      <th scope="row" className="px-4 py-3 text-left align-top font-normal">
        <Link href={`/admin/agents/${r.id}`} className="font-semibold text-fg hover:underline">
          {r.name}
        </Link>
        {!r.bookable && <p className="text-xs text-fg-muted">Not bookable</p>}
      </th>
      {r.hours.kind === "none" ? (
        <td colSpan={9} className="px-3 py-3 align-top text-error">
          No working hours, so this agent is never offered to a lead.
        </td>
      ) : (
        <>
          <td className="px-3 py-3 align-top text-fg-muted">{r.hours.zoneLabel}</td>
          {DAYS.map((d, i) => {
            const windows = r.hours.kind === "set" ? r.hours.days[i]! : [];
            return (
              <td key={d} className="px-2 py-3 align-top tabular-nums">
                {windows.length === 0 ? (
                  <span className="text-fg-muted">Off</span>
                ) : (
                  windows.map((w, j) => (
                    <div key={j} className={j > 0 ? "mt-1.5" : undefined}>
                      <div>{w.start}</div>
                      <div className="text-fg-muted">{w.end}</div>
                    </div>
                  ))
                )}
              </td>
            );
          })}
          <td
            className={`px-3 py-3 align-top ${EXCEPTIONS.has(r.hours.setBy) ? "text-fg" : "text-fg-muted"}`}
          >
            {/* The commonest value on the roster gets the quietest mark (L609),
                so the exceptions (a cal.com copy, an untouched default) are what
                the eye finds. The words stay for a screen reader, and the dash
                is explained once, in the column header. */}
            {r.hours.setBy === "not-recorded" ? (
              <>
                <span aria-hidden="true">-</span>
                <span className="sr-only">{setByLabel("not-recorded")}</span>
              </>
            ) : (
              setByLabel(r.hours.setBy)
            )}
          </td>
        </>
      )}
    </tr>
  );
}

export function TeamHoursTable({
  groups,
  showTeamHeadings,
}: {
  groups: TeamHoursGroup[];
  /** False for a manager reading their own team, whose page title already says so. */
  showTeamHeadings: boolean;
}) {
  return (
    <>
      {groups.map((g) => {
        const heading = teamHeading(g);
        const headingId = `team-${g.managerId ?? "none"}`;
        return (
          <section
            key={g.managerId ?? "none"}
            className={cardCls}
            aria-labelledby={showTeamHeadings ? headingId : undefined}
          >
            {showTeamHeadings && (
              <h2 id={headingId} className="mb-3 text-sm font-semibold">
                {heading}{" "}
                <span className="font-normal text-fg-muted tabular-nums">
                  {g.rows.length} {g.rows.length === 1 ? "agent" : "agents"}
                </span>
              </h2>
            )}
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full min-w-[880px] text-sm">
                <caption className="sr-only">
                  {showTeamHeadings ? `${heading}: ` : ""}each agent&apos;s working hours, in
                  the agent&apos;s own timezone
                </caption>
                <thead>
                  <tr className="border-b border-border bg-[var(--bg-alt)] text-left text-xs text-fg-muted">
                    <th scope="col" className="px-4 py-2.5 font-semibold">
                      Agent
                    </th>
                    <th scope="col" className="px-3 py-2.5 font-semibold">
                      Timezone
                    </th>
                    {DAYS.map((d) => (
                      <th key={d} scope="col" className="px-2 py-2.5 font-semibold">
                        <abbr title={WEEKDAY_NAMES[d]} className="no-underline">
                          {SHORT(d)}
                        </abbr>
                      </th>
                    ))}
                    <th scope="col" className="px-3 py-2.5 font-semibold" title={DASH_MEANS}>
                      Set by
                      <span className="sr-only">{` (${DASH_MEANS})`}</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {g.rows.map((r) => (
                    <Row key={r.id} r={r} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </>
  );
}

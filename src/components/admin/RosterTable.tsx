"use client";

import { useMemo, useState, useEffect, useRef } from "react";
import { roleLabel } from "@/lib/auth/roles";
import type { Role } from "@/lib/db/types";
import { Pill } from "@/components/ui/Pill";
import { InPlaceLink } from "@/components/ui/InPlaceLink";
import { ViewAsButton } from "@/components/admin/ViewAsButton";
import { teamsOf } from "@/lib/admin/agent-display";
import { isNeverSignedIn } from "@/lib/admin/unclaimed";
import { AdvisorAvatar } from "@/components/ui/AdvisorAvatar";
import { photoSrc } from "@/lib/advisor-photos/resolve";
import { DebtTeamLedger, LEDGER_LEGEND } from "@/components/admin/DebtTeamLedger";
import { RowActionsMenu } from "@/components/ui/RowActionsMenu";
import { SelectField } from "@/components/ui/SelectField";
import { BookablePill } from "@/components/ui/BookablePill";
import { BOOKABLE_STATES, BOOKABLE_STATE_TEXT, heldByTwilio } from "@/lib/bookable/bookable-state";
import { inputCls, btnSecondaryCls } from "@/components/ui/styles";
import {
  ROSTER_PAGE_SIZE,
  ROSTER_HOURS,
  EMPTY_ROSTER_FILTERS,
  filterRoster,
  onRoster,
  neverSignedInCount,
  rosterSigninText,
  rosterHoursText,
  needsPhoto,
  ROSTER_NEEDS_PHOTO_TEXT,
  sortRoster,
  hasAnyRosterFilter,
  rosterCountText,
  rosterEmptyText,
  rosterFiltersToQuery,
  type RosterFilters,
  type RosterRow,
} from "@/lib/admin/roster-filter";

/**
 * The agent roster, filtered in the browser (#1752).
 *
 * The rows are already in the page and the match is a lowercase `includes` over
 * about 136 strings, so this is well under a millisecond of work. It used to cost
 * a navigation: submitting the filter did a `router.replace`, which re-rendered
 * the whole force-dynamic admin page and re-ran every read on it before a single
 * row could change.
 *
 * Three things this deliberately does NOT do.
 *
 * It does not debounce the FILTERING, only the URL write. Debouncing the filter
 * is debouncing the only thing the person is waiting for.
 *
 * It writes the URL with `history.replaceState`, never a router navigation. The
 * point of the change is that updating the address bar costs nothing; a
 * `router.replace` would put the server render straight back.
 *
 * It shares its predicate with the server rather than reimplementing it. The
 * page renders this component with the URL's filters already applied, which is
 * also the no-JavaScript path: the controls are a real GET form, so without
 * JavaScript a submit reloads the page with new params and the server render
 * answers. Both sides call `filterRoster`, so they cannot drift.
 */
/** The Hours header's explanation of the one term in it nobody can guess. */
const HOURS_LEGEND =
  "Seeded default is the organisation's standard week, given to every new agent, which nobody has changed for them";

/**
 * Where each column starts, read by its header AND by its cells (#3031).
 *
 * A header's alignment and its cells' are one fact (L553). Typed twice, as a
 * `px-3` on the `th` and another on the `td`, they agree only until somebody
 * edits one of them, and each still reads as correct on its own. So a column
 * names its inset once and both halves derive their classes from it.
 */
const COLUMN_X = { edge: "px-4", inner: "px-3" } as const;
type ColumnX = keyof typeof COLUMN_X;

/**
 * A header never wraps (#3031). #3024 shortened the Signed in cells to "Never"
 * or "Yes", the column shrank to fit them, and its own header broke onto two
 * lines. A header is a label for the column, so the column is at least as wide
 * as its label, on every column rather than only the one that wrapped first.
 */
const thCls = (x: ColumnX) => `${COLUMN_X[x]} py-2.5 whitespace-nowrap font-semibold`;
const tdCls = (x: ColumnX) => `${COLUMN_X[x]} py-3`;

/** One recipe for both items, so the two cannot drift apart visually (L370). */
const MENU_ITEM_CLS =
  "flex min-h-11 w-full items-center whitespace-nowrap rounded-md px-3 text-left text-sm text-fg-muted transition-colors hover:bg-[var(--bg-alt)] hover:text-fg";

export function RosterTable({
  rows,
  initialFilters,
  actorRole,
  actorId,
  roleOptions,
  teamOptions,
  managerOptions,
  hoursReadable,
}: {
  /** The whole active roster. Filtering never goes back to the server. */
  rows: RosterRow[];
  initialFilters: RosterFilters;
  actorRole: Role;
  actorId: string;
  roleOptions: Role[];
  teamOptions: string[];
  managerOptions: [string, string][];
  /**
   * Whether every row's `hours` was read (#1802). When it was not, the page says
   * so once and this renders no Hours column and no hours filter, rather than a
   * column of guesses.
   */
  hoursReadable: boolean;
}) {
  const [filters, setFilters] = useState<RosterFilters>(initialFilters);
  const [page, setPage] = useState(1);

  const nameById = useMemo(
    () => new Map(rows.map((u) => [u.id, u.name ?? u.email])),
    [rows],
  );

  const matched = useMemo(
    () => sortRoster(filterRoster(rows, filters)),
    [rows, filters],
  );

  // The roster's own size, DERIVED rather than handed in (#1799 follow up). It
  // used to be a prop, and the page passed every non test user including
  // offboarded ones, so an UNFILTERED roster read "117 of 136 agents" and looked
  // filtered. `filterRoster` treats an offboarded person as not on the roster at
  // all, so this has to count the same population that predicate does, and the
  // only way to guarantee that is to compute it from the same rows (L63).
  const rosterSize = useMemo(() => rows.filter(onRoster).length, [rows]);
  // #1802: from `auth_user_id`, through the same population as `rosterSize`.
  const neverSignedIn = useMemo(() => neverSignedInCount(rows), [rows]);
  const columnCount = hoursReadable ? 8 : 7;
  const pageCount = Math.max(1, Math.ceil(matched.length / ROSTER_PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const start = (current - 1) * ROSTER_PAGE_SIZE;
  const items = matched.slice(start, start + ROSTER_PAGE_SIZE);

  // The URL write is the only debounced thing, and it is `replaceState`, so it
  // never re-renders anything. It exists so the view stays shareable and survives
  // a refresh, not so the table can update.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const id = setTimeout(() => {
      const qs = rosterFiltersToQuery(filters);
      window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
    }, 250);
    return () => clearTimeout(id);
  }, [filters]);

  function set<K extends keyof RosterFilters>(key: K, value: RosterFilters[K]) {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1); // a new filter means a new first page, not page 7 of a shorter list
  }

  return (
    <>
      {/* A real GET form, so a filtered view is a URL somebody can link to or
          come back to: the submit reloads the page with these params and the
          server render answers, through the same predicate this component uses.
          With JavaScript the submit is prevented, because the table has already
          updated.

          #1849 ended the no-JavaScript guarantee this used to carry. The filters
          are a picker of our own now rather than native selects, and the table
          already filtered through React state, so the fallback only ever covered
          a page whose other controls were dead anyway. */}
      {/* unsaved-ok: the roster search and filter row holds a view, not work
          (#2076). */}
      <form
        method="GET"
        onSubmit={(e) => e.preventDefault()}
        autoComplete="off"
        className="mb-4 flex flex-wrap items-center gap-2"
      >
        <input
          name="q"
          value={filters.q}
          onChange={(e) => set("q", e.target.value)}
          placeholder="Search name or email…"
          aria-label="Search by name or email"
          className={`${inputCls} w-56`}
        />
        {/* No Search button: it filters as you type. */}

        {/* #2837: in column order, beside the search, because the marker lives
            in the Member cell. From the stored photo, never from sign in. */}
        <SelectField
          name="photo"
          value={filters.photo}
          onChange={(v) => set("photo", v as RosterFilters["photo"])}
          ariaLabel="Filter by photo"
          placeholder="Any photo"
          options={[
            { value: "", label: "Any photo" },
            { value: "needed", label: "Needs a photo" },
            { value: "has", label: "Has a photo" },
            { value: "unread", label: "Not read from Google yet" },
          ]}
          className="w-44"
        />

        {teamOptions.length > 0 && (
<SelectField
            name="team"
            value={filters.team}
            onChange={(v) => set("team", v)}
            ariaLabel="Filter by team"
            placeholder="All teams"
            options={[{ value: "", label: "All teams" }, ...teamOptions.map((t) => ({ value: t, label: t }))]}
            className="w-44"
          />
        )}

  <SelectField
            name="role"
            value={filters.role}
            onChange={(v) => set("role", v)}
            ariaLabel="Filter by role"
            placeholder="All roles"
            options={[{ value: "", label: "All roles" }, ...roleOptions.map((r) => ({ value: r, label: roleLabel(r) }))]}
            className="w-44"
          />

        {managerOptions.length > 0 && (
<SelectField
            name="manager"
            value={filters.manager}
            onChange={(v) => set("manager", v)}
            ariaLabel="Filter by manager"
            placeholder="All managers"
            options={[{ value: "", label: "All managers" }, ...managerOptions.map(([id, label]) => ({ value: id, label }))]}
            className="w-44"
          />
        )}

  <SelectField
            name="bookable"
            value={filters.bookable}
            onChange={(v) => set("bookable", v as RosterFilters["bookable"])}
            ariaLabel="Filter by bookable"
            placeholder="Any status"
            // #3030: the states the column shows, from the same list and in the
            // same words, so "Not bookable" here never returns a row the column
            // calls Redistribute.
            options={[
              { value: "", label: "Any status" },
              ...BOOKABLE_STATES.map((s) => ({ value: s, label: BOOKABLE_STATE_TEXT.full[s] })),
            ]}
            className="w-44"
          />

        {/* #1802: in column order, after Bookable. From the linked sign in,
            never from the photo. */}
        <SelectField
          name="signin"
          value={filters.signin}
          onChange={(v) => set("signin", v as RosterFilters["signin"])}
          ariaLabel="Filter by sign in"
          placeholder="Any sign in"
          options={[
            { value: "", label: "Any sign in" },
            { value: "never", label: "Never signed in" },
            { value: "yes", label: "Signed in" },
          ]}
          className="w-44"
        />

        {hoursReadable && (
          <SelectField
            name="hours"
            value={filters.hours}
            onChange={(v) => set("hours", v as RosterFilters["hours"])}
            ariaLabel="Filter by hours"
            placeholder="Any hours"
            options={[
              { value: "", label: "Any hours" },
              ...ROSTER_HOURS.map((h) => ({ value: h, label: rosterHoursText(h) })),
            ]}
            className="w-44"
          />
        )}

        {hasAnyRosterFilter(filters) && (
          <button
            type="button"
            onClick={() => {
              setFilters(EMPTY_ROSTER_FILTERS);
              setPage(1);
            }}
            className="text-xs text-pennie-blue underline dark:text-pennie-sky"
          >
            clear
          </button>
        )}
        <span
          aria-live="polite"
          className="ml-auto text-xs text-fg-muted tabular-nums"
        >
          {/* At most two numbers, never the same one twice, and no page range:
              the pager below already says "Page 1 of 3" (#1799). */}
          {rosterCountText({
            matched: matched.length,
            total: rosterSize,
            filtered: hasAnyRosterFilter(filters),
            neverSignedIn,
          })}
        </span>
      </form>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-border bg-[var(--bg-alt)] text-left text-xs text-fg-muted">
              <th className={thCls("edge")}>Member</th>
              {/* #1844: Team before Role. The team is what an operator scans a
                  roster FOR; the role is agent on nearly every row. Moved with
                  its cell below and with the filter row above, which orders the
                  same two fields. */}
              {/* The legend lives here ONCE (#1812). V and U are the two letters
                  nobody guesses, and repeating the expansion on 136 rows is the
                  duplication this design exists to remove. */}
              <th className={thCls("inner")} title={LEDGER_LEGEND}>
                Team
                <span className="sr-only">{` (${LEDGER_LEGEND})`}</span>
              </th>
              <th className={thCls("inner")}>Role</th>
              <th className={thCls("inner")}>Manager</th>
              <th className={thCls("inner")}>Bookable</th>
              {/* #1802: two facts, two columns. Somebody can sign in and never
                  set hours, and an admin or the cal.com import can set hours for
                  somebody who never logs in, so one badge would lie about one of
                  them. */}
              <th className={thCls("inner")}>Signed in</th>
              {hoursReadable && (
                // The one term here nobody can guess, explained once on the
                // header rather than on every row (L604).
                <th className={thCls("inner")} title={HOURS_LEGEND}>
                  Hours
                  <span className="sr-only">{` (${HOURS_LEGEND})`}</span>
                </th>
              )}
              <th className={thCls("edge")} />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {items.map((u) => (
              <tr key={u.id} className="transition-colors hover:bg-[var(--bg-alt)]">
                <td className={tdCls("edge")}>
                  <div className="flex items-center gap-3">
                    {/* #3027: the picture the server resolved, drawn by the one avatar
                        component, which falls back to initials when the image
                        will not load (#2612). */}
                    <AdvisorAvatar
                      src={photoSrc(u.photo)}
                      initials={(u.name ?? u.email).slice(0, 2).toUpperCase()}
                      imgClassName="h-8 w-8 shrink-0 rounded-full object-cover"
                      fallbackClassName="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-pennie-navy text-[11px] font-semibold text-pennie-beige"
                    />
                    <div className="min-w-0">
                      <InPlaceLink
                        href={`/admin/agents/${u.id}`}
                        className="font-semibold text-fg hover:underline"
                      >
                        {u.name ?? u.email}
                      </InPlaceLink>
                      <p className="truncate text-xs text-fg-muted">{u.email}</p>
                      {/* #2837: quiet on the healthy row, where the face says
                          it, and at full weight on the exception. Words, so
                          it is never colour alone, and it names the remedy.
                          Kept out of the Signed in cell: the two are separate
                          facts (#1802). */}
                      {needsPhoto(u) && (
                        <p className="text-xs font-semibold text-fg">{ROSTER_NEEDS_PHOTO_TEXT}</p>
                      )}
                    </div>
                  </div>
                </td>
                <td className={`${tdCls("inner")} text-fg-muted`}>
                  {/* #1812: five ledger letters in fixed positions, so the cell
                      is the same size for one tier or five AND the positions
                      align down every row, which is the comparison the drawn
                      version could not do. */}
                  <DebtTeamLedger teams={teamsOf(u)} />
                </td>
                <td className={tdCls("inner")}>
                  {/* #1844: agent draws no pill chrome now, so this cell reads
                      like the Manager column beside it on nearly every row, and
                      the elevated roles are what stands out. The decision and
                      the ladder it belongs to live in Pill.tsx. */}
                  <Pill variant={`role-${u.role}`} alignToColumn>{roleLabel(u.role)}</Pill>
                </td>
                <td className={`${tdCls("inner")} text-fg-muted`}>
                  {u.manager_id ? (nameById.get(u.manager_id) ?? "-") : "-"}
                </td>
                <td className={tdCls("inner")}>
                  {/* #1823: a pill for BOTH states, each with a mark. The header
                      already asks the question, so the value is Yes or No rather
                      than the header's own word repeated. #3031: the mark leads,
                      so it is the mark that starts under the header. #3030: an
                      advisor the Twilio sync holds back reads Redistribute. */}
                  <BookablePill
                    bookable={u.bookable}
                    heldByTwilio={heldByTwilio(u)}
                    wording="short"
                    alignToColumn
                  />
                </td>
                {/* The commonest value is the quietest (L609): a signed in row
                    reads muted, a never signed in one reads "Never" at full
                    weight. */}
                <td
                  className={`${tdCls("inner")} ${
                    isNeverSignedIn(u) ? "font-semibold text-fg" : "text-fg-muted"
                  }`}
                >
                  {rosterSigninText(u)}
                </td>
                {hoursReadable && (
                  <td
                    className={`${tdCls("inner")} ${
                      u.hours === "set" ? "text-fg-muted" : "font-semibold text-fg"
                    }`}
                  >
                    {u.hours ? rosterHoursText(u.hours) : ""}
                  </td>
                )}
                <td className={`${tdCls("edge")} text-right`}>
                  {/* #1794: one menu per row. The label spelled the agent's whole
                      name into a narrow column, so it wrapped and every row was a
                      different height. The menu is rendered on EVERY row, even
                      when it holds only Manage, because a control that moves
                      depending on who you are is harder to scan than one extra
                      click. */}
                  {/* #1963: MANAGE FIRST, and the order is the convention for
                      every table that adopts this menu (#1819): the routine
                      action first, and the ones that change who you are or
                      destroy something last.

                      Three reasons, and the third is the one that is invisible
                      unless you tab through several rows. Opening a record is
                      what somebody does on this table all day, while becoming
                      that agent is a deliberate, audited act with a two hour
                      expiry. Opening the menu with the keyboard focuses its
                      FIRST item, so a keyboard user was being placed on
                      impersonation by default, which is the same consideration
                      the erasure confirm applies when it focuses "Leave it"
                      rather than the destructive button. And `ViewAsButton`
                      renders nothing on a row the actor cannot impersonate, so
                      the first item, and therefore the keyboard target, used to
                      depend on who the row was about. */}
                  <RowActionsMenu label={`Actions for ${u.name ?? u.email}`}>
                    <InPlaceLink
                      href={`/admin/agents/${u.id}`}
                      role="menuitem"
                      className={MENU_ITEM_CLS}
                    >
                      Manage
                    </InPlaceLink>
                    <ViewAsButton
                      actorRole={actorRole}
                      actorId={actorId}
                      target={u}
                      role="menuitem"
                      className={MENU_ITEM_CLS}
                    />
                  </RowActionsMenu>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={columnCount} className="px-4 py-8 text-center text-sm text-fg-muted">
                  {/* One builder, so the four empty states are decided in one
                      place and the search one can quote the query (#1791). */}
                  {rosterEmptyText(filters)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        // Paging in the browser too: turning a page would otherwise pay exactly
        // the round trip the search just stopped paying.
        <nav
          aria-label="Roster pages"
          className="mt-3 flex items-center justify-between text-xs text-fg-muted"
        >
          <button
            type="button"
            disabled={current <= 1}
            onClick={() => setPage(current - 1)}
            className={`${btnSecondaryCls} disabled:cursor-not-allowed disabled:opacity-40`}
          >
            Previous
          </button>
          <span className="tabular-nums">
            Page {current} of {pageCount}
          </span>
          <button
            type="button"
            disabled={current >= pageCount}
            onClick={() => setPage(current + 1)}
            className={`${btnSecondaryCls} disabled:cursor-not-allowed disabled:opacity-40`}
          >
            Next
          </button>
        </nav>
      )}
    </>
  );
}

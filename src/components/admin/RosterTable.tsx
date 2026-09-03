"use client";

import { useMemo, useState, useEffect, useRef } from "react";
import { roleLabel } from "@/lib/auth/roles";
import type { Role } from "@/lib/db/types";
import { Pill } from "@/components/ui/Pill";
import { InPlaceLink } from "@/components/ui/InPlaceLink";
import { ViewAsButton } from "@/components/admin/ViewAsButton";
import { isActive } from "@/lib/active-user";
import { teamsOf } from "@/lib/admin/agent-display";
import { DebtTeamLedger, LEDGER_LEGEND } from "@/components/admin/DebtTeamLedger";
import { RowActionsMenu } from "@/components/ui/RowActionsMenu";
import { inputCls, btnSecondaryCls } from "@/components/ui/styles";
import {
  ROSTER_PAGE_SIZE,
  filterRoster,
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
}: {
  /** The whole active roster. Filtering never goes back to the server. */
  rows: RosterRow[];
  initialFilters: RosterFilters;
  actorRole: Role;
  actorId: string;
  roleOptions: Role[];
  teamOptions: string[];
  managerOptions: [string, string][];
  /** How many people are on the roster in total, for the "of N" readout. */
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
  const rosterSize = useMemo(() => rows.filter(isActive).length, [rows]);
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

  const filterCtl =
    "h-11 rounded-sm border border-border bg-surface px-2.5 text-sm text-fg";

  return (
    <>
      {/* A real GET form, so the whole thing still works with no JavaScript: the
          submit reloads the page with these params and the server render answers,
          through the same predicate this component uses. With JavaScript the
          submit is prevented, because the table has already updated. */}
      <form
        method="GET"
        onSubmit={(e) => e.preventDefault()}
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
        {/* No Search button: it filters as you type. The submit input below is
            what a no-JavaScript browser uses, and it is hidden from everyone
            else because pressing it there would do nothing they had not already
            got. */}
        <noscript>
          <button type="submit" className={btnSecondaryCls}>
            Search
          </button>
        </noscript>

        <select
          name="role"
          value={filters.role}
          onChange={(e) => set("role", e.target.value)}
          aria-label="Filter by role"
          className={filterCtl}
        >
          <option value="">All roles</option>
          {roleOptions.map((r) => (
            <option key={r} value={r}>
              {roleLabel(r)}
            </option>
          ))}
        </select>

        {teamOptions.length > 0 && (
          <select
            name="team"
            value={filters.team}
            onChange={(e) => set("team", e.target.value)}
            aria-label="Filter by team"
            className={filterCtl}
          >
            <option value="">All teams</option>
            {teamOptions.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        )}

        {managerOptions.length > 0 && (
          <select
            name="manager"
            value={filters.manager}
            onChange={(e) => set("manager", e.target.value)}
            aria-label="Filter by manager"
            className={filterCtl}
          >
            <option value="">All managers</option>
            {managerOptions.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        )}

        <select
          name="bookable"
          value={filters.bookable}
          onChange={(e) => set("bookable", e.target.value)}
          aria-label="Filter by bookable"
          className={filterCtl}
        >
          <option value="">Any status</option>
          <option value="yes">Bookable</option>
          <option value="no">Not bookable</option>
        </select>

        {hasAnyRosterFilter(filters) && (
          <button
            type="button"
            onClick={() => {
              setFilters({ q: "", role: "", team: "", manager: "", bookable: "" });
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
          })}
        </span>
      </form>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-border bg-[var(--bg-alt)] text-left text-xs text-fg-muted">
              <th className="px-4 py-2.5 font-semibold">Member</th>
              <th className="px-3 py-2.5 font-semibold">Role</th>
              {/* The legend lives here ONCE (#1812). V and U are the two letters
                  nobody guesses, and repeating the expansion on 136 rows is the
                  duplication this design exists to remove. */}
              <th className="px-3 py-2.5 font-semibold" title={LEDGER_LEGEND}>
                Team
                <span className="sr-only">{` (${LEDGER_LEGEND})`}</span>
              </th>
              <th className="px-3 py-2.5 font-semibold">Manager</th>
              <th className="px-3 py-2.5 font-semibold">Bookable</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {items.map((u) => (
              <tr key={u.id} className="transition-colors hover:bg-[var(--bg-alt)]">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    {u.avatar_url ? (
                      // eslint-disable-next-line @next/next/no-img-element -- external Google avatar; OpenNext/CF has no image loader
                      <img
                        src={u.avatar_url}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="h-8 w-8 shrink-0 rounded-full object-cover"
                      />
                    ) : (
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-pennie-navy text-[11px] font-semibold text-pennie-beige">
                        {(u.name ?? u.email).slice(0, 2).toUpperCase()}
                      </span>
                    )}
                    <div className="min-w-0">
                      <InPlaceLink
                        href={`/admin/agents/${u.id}`}
                        className="font-semibold text-fg hover:underline"
                      >
                        {u.name ?? u.email}
                      </InPlaceLink>
                      <p className="truncate text-xs text-fg-muted">{u.email}</p>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-3">
                  <Pill variant={`role-${u.role}`}>{roleLabel(u.role)}</Pill>
                </td>
                <td className="px-3 py-3 text-fg-muted">
                  {/* #1812: five ledger letters in fixed positions, so the cell
                      is the same size for one tier or five AND the positions
                      align down every row, which is the comparison the drawn
                      version could not do. */}
                  <DebtTeamLedger teams={teamsOf(u)} />
                </td>
                <td className="px-3 py-3 text-fg-muted">
                  {u.manager_id ? (nameById.get(u.manager_id) ?? "-") : "-"}
                </td>
                <td className="px-3 py-3">
                  {u.bookable ? (
                    <Pill variant="status-ok">Bookable</Pill>
                  ) : (
                    <span className="text-fg-muted">-</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  {/* #1794: one menu per row. The label spelled the agent's whole
                      name into a narrow column, so it wrapped and every row was a
                      different height. The menu is rendered on EVERY row, even
                      when it holds only Manage, because a control that moves
                      depending on who you are is harder to scan than one extra
                      click. */}
                  <RowActionsMenu label={`Actions for ${u.name ?? u.email}`}>
                    <ViewAsButton
                      actorRole={actorRole}
                      actorId={actorId}
                      target={u}
                      role="menuitem"
                      className={MENU_ITEM_CLS}
                    />
                    <InPlaceLink
                      href={`/admin/agents/${u.id}`}
                      role="menuitem"
                      className={MENU_ITEM_CLS}
                    >
                      Manage
                    </InPlaceLink>
                  </RowActionsMenu>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-fg-muted">
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

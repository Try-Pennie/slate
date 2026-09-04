import { Fragment } from "react";
import { grantStaffAccess } from "@/app/admin/actions";
import { GRANTABLE_STAFF_ROLES, staffAccessMessage } from "@/lib/admin/staff-access";
import type { StaffAccessOutcome } from "@/lib/admin/staff-access";
import { pendingWaitText, type PendingAccessRow } from "@/lib/admin/pending-access";
import { ROLE_RANK, roleLabel } from "@/lib/auth/roles";
import { isRole } from "@/lib/auth/roles";
import { Pill, type PillVariant } from "@/components/ui/Pill";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { btnCls, btnSecondaryCls, cardCls, inputCls, labelCls, proseCls } from "@/components/ui/styles";
import { SelectField } from "@/components/ui/SelectField";

/**
 * Team access (#160): give somebody who is not a Salesforce agent the access they
 * need, and make the one way this quietly fails observable.
 *
 * The failure is worth restating, because the panel is shaped around it.
 * `provisionUser` matches a Google login to a Slate row BY EMAIL. A row keyed to
 * an address that is not the person's real login is never matched: they sign in,
 * get a fresh `agent` row, and the access they were promised sits unused with
 * nothing reporting it. Slate cannot ask Google whether an address exists (the
 * delegation holds the calendar and gmail.send scopes only), so the panel does the
 * two things it CAN do: it refuses an address outside the sign in domain at the
 * moment of typing, and it lists every granted account that has never been signed
 * in to, how long it has waited, and the near identical address that DID sign in.
 *
 * Super admin only, and the server action enforces that on its own: this component
 * being hidden is presentation, never the control.
 */
export function TeamAccessPanel({
  outcome,
  outcomeEmail,
  outcomeRole,
  pending,
}: {
  /** The result of the last grant, read back off the URL, or null on a fresh load. */
  outcome: StaffAccessOutcome | null;
  outcomeEmail: string;
  outcomeRole: string;
  /** null means the roster could not be READ, which is not the same as nobody waiting. */
  pending: PendingAccessRow[] | null;
}) {
  const result = outcome
    ? staffAccessMessage(
        outcome,
        outcomeEmail,
        isRole(outcomeRole) ? outcomeRole : undefined,
      )
    : null;

  return (
    // #1907: this panel does NOT title or explain itself. It was written as one
    // panel among several, so it did, and it is now the whole content of a route
    // that also titles and explains itself: two headings reading "Team access"
    // one card apart, each with its own description of the same thing. Neither
    // half was wrong on its own, which is why nothing reported it.
    //
    // The page header carries both, including the sentence that says the address
    // has to be the one they sign in with. That sentence is the fact this panel
    // exists to convey (#160), so it survived the merge rather than being the
    // half that was dropped.
    <section id="team-access" className={cardCls}>

      {result && (
        <div
          role={result.tone === "error" ? "alert" : "status"}
          className={
            result.tone === "error"
              ? "mb-4 rounded-md border border-[var(--error)] px-4 py-3 text-sm text-error"
              : result.tone === "success"
                // Graphite, not `--fg`: the wash is a RAW token that does not flip,
                // so `--fg` turning beige in dark mode would put pale text on a pale
                // green ground. Same fix Pill's status-ok carries.
                ? "mb-4 rounded-md bg-[var(--pennie-green-wash)] px-4 py-3 text-sm text-pennie-graphite"
                : "mb-4 rounded-md border border-border px-4 py-3 text-sm text-fg"
          }
        >
          {result.text}
        </div>
      )}

      {/* #1889: three pieces of copy came off this field. The
          "Work email address" label (we know what it is), the
          `firstname.lastname@trypennie.com` placeholder (not our address format,
          so it read as instruction and was wrong), and the "The address they sign
          in to Google with." hint, which said the label again.

          THE LABEL ELEMENT STAYS, visually hidden. It is what a screen reader
          announces for this input, and deleting it leaves an unnamed edit box,
          which fails 4.1.2 and 3.3.2. Nothing changes on screen.

          The `aria-describedby` went with the hint in the same change. A
          describedby pointing at an element that does not exist reads no
          description and raises no error anywhere, so it looks fine.

          #1761's note about the hint's position is gone with the hint. What it
          was protecting still holds: this row aligns its children on their bottom
          edges, so anything added inside the email column pushes the select and
          the button down by its height to meet it. */}
      <form action={grantStaffAccess}>
        <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <label className="sr-only" htmlFor="staff-email">
            Work email address
          </label>
          <input
            id="staff-email"
            name="email"
            type="email"
            required
            autoComplete="off"
            spellCheck={false}
            className={`${inputCls} w-full`}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="staff-role">
            Access
          </label>
          <SelectField
            id="staff-role"
            name="role"
            defaultValue="manager"
            className="w-44"
            options={GRANTABLE_STAFF_ROLES.map((r) => ({ value: r, label: roleLabel(r) }))}
          />
        </div>
        <SubmitButton
          className={`${btnCls} min-h-[44px]`}
          pendingLabel="Giving access"
          slowLabel="Still giving access"
        >
          Give access
        </SubmitButton>
        </div>
      </form>

      <div className="mt-6 border-t border-border pt-4">
        {/* #1890: the paragraph that used to sit here explained the heading. Each
            row already carries the address, the access level, how long they have
            waited, a "Check this address" flag when the wait is long, and the
            lookalike account when there is one, so a reader has everything it was
            spelling out.

            It was also the only thing separating the heading from the first row,
            so the heading takes the gap it was providing. `mb-1` was written on
            the assumption a paragraph followed. */}
        <h3 className="mb-3 text-sm font-semibold">Waiting for a first sign in</h3>
        <PendingList pending={pending} />
      </div>
    </section>
  );
}

/**
 * Three states, deliberately distinct. An unreadable roster is NOT an empty one:
 * rendering it as "everybody has signed in" would be the reassuring way to be
 * wrong, on the panel somebody opens precisely because access is not working.
 */
function PendingList({ pending }: { pending: PendingAccessRow[] | null }) {
  if (pending === null) {
    return (
      <p
        role="alert"
        className="rounded-md border border-[var(--error)] px-4 py-3 text-sm text-error"
      >
        The roster could not be read, so Slate cannot say who is waiting. This is
        not the same as nobody waiting. Reload in a moment.
      </p>
    );
  }
  if (pending.length === 0) {
    return (
      <p className="text-sm text-fg-muted">
        Everyone with access above agent has signed in at least once.
      </p>
    );
  }
  // #1891: a real table, not a flow row.
  //
  // Each person was one `flex flex-wrap` row, where every item's position is set
  // by the total width of everything before it. The addresses vary a lot in
  // length (`geoff@trypennie.com` against `mrasmussen@trypennie.com`), so the
  // access pill, the wait and the flag started at a different x on every row.
  // That is not a spacing value to nudge: a flow row has no columns to align.
  // `flex-wrap` also dropped the flag onto a second line on some rows and not
  // others, so the rows stopped having the same SHAPE as well.
  //
  // Same shape as the roster table, which is the convention the rest of the
  // admin already uses: a bounded min width inside a horizontally scrolling
  // wrapper, so a narrow window scrolls sideways rather than reflowing.
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="border-b border-border bg-[var(--bg-alt)] text-left text-xs text-fg-muted">
            <th className="px-4 py-2.5 font-semibold">Person</th>
            <th className="px-3 py-2.5 font-semibold">Access</th>
            {/* Right aligned in the HEADER as well as the cell. The two are one
                decision made at two declaration sites, which is how they drift
                (L553). */}
            <th className="px-3 py-2.5 text-right font-semibold">Waiting</th>
            <th className="px-3 py-2.5 font-semibold">Flag</th>
          </tr>
        </thead>
        <tbody>
          {pending.map((row, i) => (
            <Fragment key={row.id}>
              {/* The separator is on the PERSON row rather than `divide-y` on the
                  body, because a lookalike gets its own row directly beneath its
                  person and a line between them would break the one thing that
                  has to survive being made a table: which row the remedy belongs
                  to. */}
              <tr className={i > 0 ? "border-t border-border" : undefined}>
                <td className="px-4 py-3">
                  {/* Name over address, stacked the way the roster's Member cell
                      does it: it reads when the name is there and leaves no gap
                      when it is not. */}
                  {row.name && <p className="font-semibold text-fg">{row.name}</p>}
                  <p className={row.name ? "text-xs text-fg-muted" : "font-semibold text-fg"}>
                    {row.email}
                  </p>
                </td>
                <td className="px-3 py-3">
                  <Pill variant={`role-${row.role}` as PillVariant} alignToColumn>
                    {roleLabel(row.role)}
                  </Pill>
                </td>
                <td className="px-3 py-3 text-right tabular-nums text-fg-muted">
                  {pendingWaitText(row.waitedDays)}
                </td>
                <td className="px-3 py-3">
                  {row.stale && (
                    // The word carries the meaning; the outline is only
                    // reinforcement, so the flag survives being read without
                    // colour.
                    <Pill variant="status-error" alignToColumn>
                      Check this address
                    </Pill>
                  )}
                </td>
              </tr>
              {row.lookalike && (
                <tr>
                  <td colSpan={4} className="px-4 pb-3">
                    <Lookalike row={row} lookalike={row.lookalike} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The remedy, and the one thing it must never do (#1669).
 *
 * The button used to post the PENDING row's role and nothing consulted the
 * lookalike's own, so a seeded `manager` row beside a real account since promoted
 * to `admin` rendered "Give manager access to geoff.smith" and, on one click,
 * dropped Geoff to manager as an ordinary success.
 *
 * A grant that would LOWER the signed in account is not a remedy at all, so there
 * is no button for it: the person already has what the seeded row was promising.
 * `planStaffAccess` refuses the same move on its own, so this is the honest label
 * rather than the control, and a second entry point still could not demote.
 */
function Lookalike({
  row,
  lookalike,
}: {
  row: PendingAccessRow;
  lookalike: NonNullable<PendingAccessRow["lookalike"]>;
}) {
  const wouldGain = ROLE_RANK[row.role] > ROLE_RANK[lookalike.role];
  return (
    <div className="mt-3 rounded-md bg-[var(--pennie-sky-soft)] px-3 py-3 text-sm text-pennie-navy dark:border dark:border-border dark:bg-transparent dark:text-fg">
      <p className={proseCls}>
        <span className="font-semibold">{lookalike.email}</span> has signed in and
        looks like the same person.{" "}
        {wouldGain
          ? "If that is the address they really use, give the access to it instead."
          : `That account already has ${roleLabel(lookalike.role)} access, so there is nothing to give it. The row above is most likely an address nobody signs in with.`}
      </p>
      {wouldGain && (
        <form action={grantStaffAccess} className="mt-2">
          <input type="hidden" name="email" value={lookalike.email} />
          <input type="hidden" name="role" value={row.role} />
          <SubmitButton
            className={`${btnSecondaryCls} min-h-[44px]`}
            pendingLabel="Giving access"
            slowLabel="Still giving access"
          >
            Give {roleLabel(row.role)} access to {lookalike.email}
          </SubmitButton>
        </form>
      )}
    </div>
  );
}

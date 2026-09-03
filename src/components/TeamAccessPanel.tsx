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
    <section id="team-access" className={cardCls}>
      <h2 className="mb-1 text-sm font-semibold">Team access</h2>
      <p className={`mb-4 text-xs text-fg-muted ${proseCls}`}>
        For people who need Slate but are not debt team agents, so nothing creates
        them automatically. They pick the access up the first time they sign in
        with this exact address, so the address is the thing to get right.
      </p>

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

      {/* #1761: the hint sits UNDER the row, not inside the email column.
          The row aligns its children on their bottom edges, so a hint inside that
          column made the column's bottom edge the hint's bottom, and the select
          and the button were pushed down by exactly the hint's height to meet it.
          It stays the field's aria-describedby wherever it sits in the DOM. */}
      <form action={grantStaffAccess}>
        <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <label className={labelCls} htmlFor="staff-email">
            Work email address
          </label>
          <input
            id="staff-email"
            name="email"
            type="email"
            required
            autoComplete="off"
            spellCheck={false}
            placeholder="firstname.lastname@trypennie.com"
            aria-describedby="staff-email-hint"
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
        <p id="staff-email-hint" className="mt-1 text-xs text-fg-muted">
          The address they sign in to Google with.
        </p>
      </form>

      <div className="mt-6 border-t border-border pt-4">
        <h3 className="mb-1 text-sm font-semibold">Waiting for a first sign in</h3>
        <p className={`mb-3 text-xs text-fg-muted ${proseCls}`}>
          Access nobody has used yet. A long wait usually means the address is not
          the one they actually sign in with, which looks exactly like nothing
          happening at all.
        </p>
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
  return (
    <ul className="space-y-3">
      {pending.map((row) => (
        <li key={row.id} className="rounded-md border border-border px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-sm font-semibold text-fg">{row.email}</span>
            <Pill variant={`role-${row.role}` as PillVariant}>{roleLabel(row.role)}</Pill>
            <span className="text-xs tabular-nums text-fg-muted">
              {pendingWaitText(row.waitedDays)}
            </span>
            {row.stale && (
              // The word carries the meaning; the outline is only reinforcement,
              // so the flag survives being read without colour.
              <Pill variant="status-error">Check this address</Pill>
            )}
          </div>
          {row.name && <p className="mt-1 text-xs text-fg-muted">{row.name}</p>}
          {row.lookalike && <Lookalike row={row} lookalike={row.lookalike} />}
        </li>
      ))}
    </ul>
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

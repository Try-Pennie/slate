"use client";

import { useActionState } from "react";
import { TimeField } from "@/components/ui/TimeField";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { labelCls, btnCls } from "@/components/ui/styles";
import type { BusinessHoursFormState } from "@/app/admin/actions";
import type { CoverageReadout } from "@/lib/booking/business-hours-coverage";
import { coverageGapPhrases, gapsFromCoverage } from "@/lib/monitor/roster-coverage";
import { Pill } from "@/components/ui/Pill";

const DAYS: [number, string][] = [
  [1, "Monday"],
  [2, "Tuesday"],
  [3, "Wednesday"],
  [4, "Thursday"],
  [5, "Friday"],
  [6, "Saturday"],
  [7, "Sunday"],
];

export interface BusinessHoursDay {
  weekday: number;
  is_open: boolean;
  /** "HH:MM" in the org's zone. */
  start: string;
  end: string;
}

/**
 * The org's opening hours (#1297).
 *
 * A client component so a refusal comes back as STATE rather than a navigation,
 * which keeps the twenty-one entered fields on screen. Re-entering a whole week
 * after a bounce is the kind of thing that makes someone give up and edit the
 * database instead.
 *
 * The confirm step is deliberately NOT an error. Closing a day that already holds
 * appointments is allowed, and the person is simply shown the consequence once
 * before it happens; the second submit carries `confirm_close` and goes through.
 */
export function BusinessHoursForm({
  action,
  days,
  zoneLabel,
  coverage,
}: {
  action: (
    prev: BusinessHoursFormState,
    form: FormData,
  ) => Promise<BusinessHoursFormState>;
  days: BusinessHoursDay[];
  zoneLabel: string;
  coverage: CoverageReadout;
}) {
  const [state, formAction] = useActionState<BusinessHoursFormState, FormData>(action, {
    error: null,
  });
  const byDay = new Map(days.map((d) => [d.weekday, d]));

  return (
    <form action={formAction} className="space-y-5">
      {state.error && (
        <p
          role="alert"
          className="rounded-[var(--radius-md)] border border-[rgba(196,61,61,0.35)] bg-[rgba(196,61,61,0.12)] px-4 py-3 text-sm text-[#C43D3D]"
        >
          {state.error}
        </p>
      )}

      {state.confirm && (
        <div
          role="alert"
          className="rounded-[var(--radius-md)] border border-border bg-[var(--bg-alt)] px-4 py-3 text-sm text-fg"
        >
          <p>{state.confirm.message}</p>
          {/* Carrying the flag on the NEXT submit, so confirming is a deliberate
              second action rather than something already ticked on the person's
              behalf. */}
          <input type="hidden" name="confirm_close" value="1" />
        </div>
      )}

      {/* #1458: a save that opened hours nobody covers still SAVED, so the notice
          leads with that and then says what it did. A warning, not a refusal:
          opening hours ahead of rostering them is a legitimate order of
          operations. The words come from the same builder the Slack page uses, so
          an admin cannot meet two spellings of one finding. */}
      {state.ok && state.warning && (
        <div
          role="status"
          className="flex flex-wrap items-start gap-3 rounded-[var(--radius-md)] border border-border bg-[var(--bg-alt)] px-4 py-3 text-sm text-fg"
        >
          {/* The pill carries the meaning, not a colour: colour is never the sole
              signal, and there is no warning token in the palette to reach for
              (sky is reserved for actions). */}
          <Pill variant="status-pending">Coverage</Pill>
          <p className="min-w-[16rem] flex-1">{state.warning}</p>
        </div>
      )}

      {state.ok && !state.warning && (
        <p
          role="status"
          className="rounded-[var(--radius-md)] border border-border bg-[var(--bg-alt)] px-4 py-3 text-sm text-fg"
        >
          Saved. Leads see the new hours straight away.
        </p>
      )}

      <div className="space-y-2">
        {DAYS.map(([weekday, name]) => {
          const d = byDay.get(weekday);
          const open = d?.is_open ?? false;
          return (
            <div
              key={weekday}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--radius-md)] border border-border px-4 py-3"
            >
              <label className="flex min-w-[9.5rem] cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  name={`bh_open_${weekday}`}
                  defaultChecked={open}
                  className="h-5 w-5 shrink-0 rounded-[var(--radius-xs)] border-border accent-[var(--accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
                />
                <span className="text-sm font-semibold">{name}</span>
              </label>

              <div className="flex flex-wrap items-center gap-3">
                <TimeField
                  name={`bh_start_${weekday}`}
                  ariaLabel={`${name} opening time`}
                  defaultValue={d?.start ?? "08:00"}
                />
                <span aria-hidden="true" className="text-sm text-fg-muted">
                  to
                </span>
                <TimeField
                  name={`bh_end_${weekday}`}
                  ariaLabel={`${name} closing time`}
                  round="up"
                  defaultValue={d?.end ?? "20:00"}
                />
              </div>
            </div>
          );
        })}
      </div>

      <CoveragePanel coverage={coverage} />

      <SubmitButton className={btnCls} pendingLabel="Saving…">
        {state.confirm ? "Save anyway" : "Save business hours"}
      </SubmitButton>

      <p className={`${labelCls} !mt-3 !font-normal !text-fg-muted`}>
        All times are {zoneLabel}. Leads always see them in their own timezone.
      </p>
    </form>
  );
}

/**
 * Who is actually rostered inside the hours we are open.
 *
 * Three states, kept apart on purpose. A count, a real zero, and could-not-check:
 * the roster read throws rather than returning empty, and an unreadable roster
 * rendered as "nobody covers this" reads as a staffing problem, so someone would go
 * and fix a roster that was fine.
 *
 * It describes the hours currently SAVED, not the ones being edited, and says so.
 * Recomputing it live would mean re-querying the roster on every keystroke, and a
 * readout that silently described a mixture of saved and unsaved hours would be
 * worse than one that is clear about which it means.
 */
function CoveragePanel({ coverage }: { coverage: CoverageReadout }) {
  if (!coverage.ok) {
    return (
      <div className="rounded-[var(--radius-md)] border border-border bg-[var(--bg-alt)] px-4 py-3 text-sm text-fg-muted">
        <p className="font-semibold text-fg">Coverage could not be checked</p>
        <p className="mt-1">
          The roster could not be read just now, so this is not saying nobody is
          available. Reload in a moment to see it.
        </p>
      </div>
    );
  }

  // #1458: the SAME grouping and phrasing the roster alarm uses, so this readout
  // and the Slack page cannot describe one finding two ways. It also collapses
  // five identical weekday gaps into one line, which a per day list could not.
  const phrases = coverageGapPhrases(gapsFromCoverage(coverage) ?? []);

  return (
    <div className="rounded-[var(--radius-md)] border border-border bg-[var(--bg-alt)] px-4 py-3 text-sm">
      <p className="font-semibold text-fg">
        Coverage in the hours currently saved
      </p>
      <p className="mt-1 text-fg-muted">
        {coverage.bookableAgents === 0
          ? "No agents are in the booking pool at the moment, so no hour has anyone on. That is expected while the pool is switched off."
          : `${coverage.bookableAgents} ${coverage.bookableAgents === 1 ? "agent is" : "agents are"} in the booking pool.`}
      </p>
      {coverage.bookableAgents > 0 && phrases.length > 0 && (
        <>
          <p className="mt-2 text-fg-muted">
            These hours are open with nobody rostered, so no times are offered in them:
          </p>
          <ul className="mt-1 space-y-0.5">
            {phrases.map((text) => (
              <li key={text} className="text-fg">
                {text}
              </li>
            ))}
          </ul>
        </>
      )}
      {coverage.bookableAgents > 0 && phrases.length === 0 && (
        <p className="mt-2 text-fg-muted">Every open hour has someone rostered.</p>
      )}
    </div>
  );
}

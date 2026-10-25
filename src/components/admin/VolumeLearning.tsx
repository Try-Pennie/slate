"use client";

import { useState } from "react";
import { ConfirmAction } from "@/components/ui/ConfirmAction";
import { SaveForm, holdsAView } from "@/components/ui/SaveForm";
import { btnCls, btnSecondaryCls, cardCls, inputCls, labelCls } from "@/components/ui/styles";

/** "Oct 12, 2026" for a YYYY-MM-DD, read as a date rather than as UTC midnight. */
function day(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** One Low page's coverage, from `pageCoverage()` (#2738). */
export interface PageCoverageView {
  id: string;
  name: string;
  /** Open hours in a typical week. */
  open: number;
  /** Of those, the hours whose floors can breach. */
  judged: number;
}

/**
 * Learning the low volume floors from Slate's own bookings, on /admin/alerts (#2739,
 * #2874).
 *
 * In the order a reader needs them: what learning is doing for Low now, one line
 * for every other tier, the optional ramp end, and how much of each Low page's week
 * its own alarm can judge. Nothing has to be set for learning to start: every tier,
 * Low included, starts at its own first real booking (Dan, 2026-09-29, on #2874).
 * The ramp end is an OPTIONAL override that can only start learning later, for a
 * tier whose first weeks were a partial ramp. The coverage is a table rather than `pageCoverage()`'s sentences, because
 * three pages each explaining what an unmeasured hour is states one fact three
 * times (L579, L605): the numbers go in rows and the explanation is said once.
 *
 * THE RAMP END IS CONFIRMED, WITH THE CONSEQUENCE NAMED (L608). It is the one
 * setting on the page whose effect lands weeks later, with nobody watching, so the
 * confirm says what changes from the date typed: which bookings are left out, when
 * learning starts, and that the learned floors never fall below the cal.com ones.
 * The message is built from the date in the field, not from a generic "are you
 * sure" (L180), which is why this is client code.
 *
 * Its own form rather than a field of the settings form above it, so a save of the
 * cooldowns can never change it, and so the confirm can sit inside the form it
 * submits (a nested form is not valid markup).
 */
export function VolumeLearning({
  rampEndOn,
  detail,
  tiers,
  retirement,
  lowFloorNote,
  coverage,
  sourceNotice,
  sourceSetAside,
  pagePilot,
  heldOff,
  notice,
  action,
  earliest,
  minWeeks,
}: {
  /** The stored ramp end, YYYY-MM-DD, or null when none is declared. */
  rampEndOn: string | null;
  /** From `learningStatusCopy`: what learning is doing now, for Low. */
  detail: string[];
  /** From `tierLearningLines` (#2874): one line for every other tier, judged or not. */
  tiers: string[];
  /**
   * From `anchorRetirementSentence` (#3896): when the cal.com measurement stops, or
   * stopped, holding every tier's floors up, said once under the tier list, or null
   * while cal.com is live. Required, so the page has to decide it.
   */
  retirement: string | null;
  /**
   * From `rampEndLowFloorNote` (#3896): what the ramp end confirm says about the
   * cal.com floor under Low's floors, or null once the anchor has retired and there
   * is none. Required, so the page has to decide it.
   */
  lowFloorNote: string | null;
  /** Each Low page's coverage from `pageCoverage()`, or null when the week could not be read. */
  coverage: PageCoverageView[] | null;
  /**
   * From `pageSourceStatus()` (#2765): what to say IN PLACE of the pages' floors while
   * bookings arrive without the page they came from, or null once every booking in
   * the lookback carried one. Required, so the page has to decide it.
   */
  sourceNotice: string | null;
  /**
   * From `pageSourceStatus()`'s note (#2960): how many hand made bookings with no host
   * page were set aside from the source share, said beside the floors, or null when
   * none were. Required, so the page has to decide it.
   */
  sourceSetAside: string | null;
  /**
   * From `pilotPageLine()`: why the pages are not judged, which stands in place of the
   * table, or null while the pilot sends Slate every Low lead and they are.
   */
  pagePilot: string | null;
  /**
   * From `pagesNotOnSlateLines()` (#2878): one sentence per Low page Slate does not
   * carry yet, said whatever else the section says, so a page missing from the table
   * reads as a decision. Empty once every Low page is on Slate.
   */
  heldOff: string[];
  /** The saved notice for this form, drawn here rather than at the top of the page. */
  notice?: React.ReactNode;
  action: (form: FormData) => Promise<void>;
  /**
   * `EARLIEST_RAMP_END` and `LEARNING.minWeeks`, handed down by the page rather
   * than imported, so the learner and its date library stay out of the client
   * bundle for the sake of two constants.
   */
  earliest: string;
  minWeeks: number;
}) {
  const [date, setDate] = useState(rampEndOn ?? "");
  const changing = rampEndOn !== null;
  const typed = date.trim();

  const setMessage = !typed ? (
    <>Pick the day the ramp ended first.</>
  ) : typed === rampEndOn ? (
    <>The ramp end is already {day(typed)}; nothing would change.</>
  ) : (
    <>
      {changing ? `The ramp end moves from ${day(rampEndOn)} to ${day(typed)}. ` : ""}
      Every tier then learns only from bookings made on or after {day(typed)}, or after its own
      first booking if that is later, and each is judged against its learned floors once {minWeeks}{" "}
      full weeks of them have been booked.{lowFloorNote ? ` ${lowFloorNote}` : ""}
      {changing ? " The floors learned for the old date stop applying at the next check." : ""}
    </>
  );

  return (
    <section id="volume-learning" className={cardCls}>
      <h2 className="mb-1 text-sm font-semibold">Learning the floors from Slate&apos;s bookings</h2>
      {notice}
      <div className="space-y-1" data-volume-learning-status>
        {detail.map((line) => (
          <p key={line} className="text-xs text-fg-muted">
            {line}
          </p>
        ))}
      </div>

      {/* #2874: every other tier, one line each, so a tier that is not judged is
          stated rather than absent (L678). */}
      <h3 className="mt-4 text-sm font-semibold text-fg">The other tiers</h3>
      <ul className="mt-0.5 space-y-1" data-volume-tiers>
        {tiers.map((line) => (
          <li key={line} className="text-xs text-fg-muted">
            {line}
          </li>
        ))}
      </ul>
      {/* #3896, design round "Once, under the tiers": one sentence for every tier,
          Low included, never repeated on a tier line or Low's status. */}
      {retirement ? (
        <p className="mt-3 text-xs text-fg" data-volume-anchor-retirement>
          {retirement}
        </p>
      ) : null}

      <p className="mt-4 text-xs text-fg-muted">
        Each tier learns from its own first real booking, so nothing needs setting when another tier
        moves to Slate. Set a ramp end only when the first weeks were a partial ramp, to leave them out.
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <SaveForm
          action={action}
          name="volume-ramp-end"
          unsaved="the ramp end date you picked"
          className="flex flex-wrap items-end gap-3"
        >
          <input type="hidden" name="intent" value="set" />
          <div>
            <label className={labelCls} htmlFor="ramp_end">
              The ramp ended on
            </label>
            <input
              id="ramp_end"
              name="ramp_end"
              type="date"
              required
              min={earliest}
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={`${inputCls} w-44`}
            />
          </div>
          <ConfirmAction
            className={btnCls}
            label={changing ? "Change the ramp end" : "Set the ramp end"}
            confirmLabel={changing ? "Change the ramp end" : "Set the ramp end"}
            pendingLabel="Saving..."
            message={setMessage}
          />
        </SaveForm>

        {changing && (
          <SaveForm
            action={action}
            name="volume-ramp-end-clear"
            unsaved={holdsAView("clearing is one button carrying a fixed value")}
          >
            <input type="hidden" name="intent" value="clear" />
            <ConfirmAction
              className={btnSecondaryCls}
              label="Clear the ramp end"
              confirmLabel="Clear the ramp end"
              pendingLabel="Clearing..."
              message={
                <>
                  Every tier goes back to learning from its own first booking, and what was learned
                  from {day(rampEndOn)} stops applying at the next check, until the refit that follows
                  replaces it.
                </>
              }
            />
          </SaveForm>
        )}
      </div>

      <h3 className="mt-6 text-sm font-semibold text-fg">Each Low page on its own</h3>
      <p className="mt-0.5 text-xs text-fg-muted">
        Each page&apos;s own alarm judges it against cal.com&apos;s floors for that page; learning
        replaces the floors for the Low tier as a whole.
      </p>
      {heldOff.map((line) => (
        <p key={line} className="mt-1 text-xs text-fg" data-page-held-off>
          {line}
        </p>
      ))}
      {sourceSetAside !== null && (
        <p className="mt-1 text-xs text-fg" data-page-sources-set-aside>
          {sourceSetAside}
        </p>
      )}
      {pagePilot !== null ? (
        <p className="mt-1 text-xs text-fg" role="status" data-page-pilot>
          {pagePilot}
        </p>
      ) : sourceNotice !== null ? (
        <p className="mt-1 text-xs text-fg" role="status" data-page-sources>
          {sourceNotice}
        </p>
      ) : coverage === null ? (
        <p className="mt-1 text-xs text-fg" role="status">
          The business week could not be read, so how much of each page&apos;s week can be judged is
          unknown.
        </p>
      ) : (
        <>
          <table className="mt-2 text-xs">
            <thead className="text-fg-muted">
              <tr>
                <th scope="col" className="py-1.5 pr-6 text-left font-semibold">
                  Page
                </th>
                <th scope="col" className="py-1.5 pr-6 text-right font-semibold">
                  Open hours judged
                </th>
                <th scope="col" className="py-1.5 text-right font-semibold">
                  Unmeasured
                </th>
              </tr>
            </thead>
            <tbody>
              {coverage.map((c) => (
                <tr key={c.id} data-page-coverage={c.id} className="border-t border-border">
                  <th scope="row" className="py-1.5 pr-6 text-left font-normal text-fg">
                    {c.name}
                  </th>
                  <td className="py-1.5 pr-6 text-right tabular-nums text-fg">
                    {c.judged} of {c.open}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-fg">{c.open - c.judged}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-fg-muted">
            An unmeasured hour carries too few of that page&apos;s bookings in two hours to judge, so a
            break that starts there is not caught by the page&apos;s own alarm.
          </p>
        </>
      )}
    </section>
  );
}

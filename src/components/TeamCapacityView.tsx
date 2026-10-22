"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { DateTime } from "luxon";
import { CalendarMonth } from "@/components/ui/CalendarMonth";
import { cardCls } from "@/components/ui/styles";
import { SaveForm } from "@/components/ui/SaveForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { KEY_WORDS, OPEN_WORD, fullLine, nearlyFullSentence } from "@/lib/admin/team-capacity-copy";
import type { CapacityRow, TeamCapacityView as View } from "@/lib/admin/team-capacity-view";
import "@/app/admin/team-capacity/team-capacity.css";

/**
 * The Team capacity screen (#3936), laid out element for element as the settled design draws it
 * (docs/design/team-capacity.html), because the design match score compares the two as pictures.
 * The numbers and every rule come in already worked out (`teamCapacityView`); this only lays them
 * out and handles the three things a person does here: switch day, pick a date, move the line.
 *
 * The `data-tc` attributes are the hooks the design's checks read (team-capacity.checks.js).
 */
export function TeamCapacityView({
  view,
  zone,
  todayIso,
  initialIndex,
  nearlyFullPct,
  canEdit,
  pickable,
  initialCalendarOpen = false,
  initialChangeOpen = false,
  saveAction,
}: {
  view: View;
  zone: string;
  todayIso: string;
  initialIndex: number;
  nearlyFullPct: number;
  /** Only an admin moves the line; a manager reads it. */
  canEdit: boolean;
  /** The days the date picker offers, ascending. */
  pickable: string[];
  initialCalendarOpen?: boolean;
  initialChangeOpen?: boolean;
  saveAction: (form: FormData) => Promise<void>;
}) {
  const [selected, setSelected] = useState(initialIndex);
  const [changeOpen, setChangeOpen] = useState(initialChangeOpen);
  const day = view.days[selected];
  const ticks = view.ticks[selected];

  return (
    <>
      <div className="tc-scope flex flex-col gap-3">
        {/* One row however many days there are: after 6 PM today joins the booker's four (#3949). */}
        <section className="totals" style={{ gridTemplateColumns: `repeat(${view.cards.length}, minmax(0, 1fr))` }}>
          {view.cards.map((c) => (
            <div key={c.iso} data-tc="day-card" className={`tcard${c.flag === "full" ? " flag full" : c.flag === "nearly-full" ? " flag" : ""}`}>
              <div className="tday">
                <span className="tday-top">{c.top}</span>
                <span className="tday-sub">{c.sub}</span>
              </div>
              <div className="tnum">
                <span className="tbig" data-tc="calls-open">{String(c.open)}</span>
                <span className="tunit">{c.unit}</span>
              </div>
              <div className="tbar">
                <span className="tfill" data-tc="full-bar" style={{ width: `${c.fullPct ?? 0}%` }} />
              </div>
              <div className="tpct" data-tc="pct">
                {fullLine(c.fullPct)}
                {c.flag && (
                  <span className="chip" data-tc="flag">
                    {c.flag === "full" ? "Full" : "Nearly full"}
                  </span>
                )}
              </div>
              {c.pace.map((line) => (
                <div key={line} className="tpace" data-tc="pace">
                  {line}
                </div>
              ))}
              {c.outLine && (
                <div className="tout" data-tc="out-count">
                  {c.outLine}
                </div>
              )}
              {c.notSyncingLine && (
                <div className="tout" data-tc="not-syncing">
                  {c.notSyncingLine}
                </div>
              )}
            </div>
          ))}
        </section>
        {changeOpen ? (
          <LineForm pct={nearlyFullPct} onCancel={() => setChangeOpen(false)} saveAction={saveAction} />
        ) : (
          <div className="ctl link-ctl" data-tc="nearly-full-line">
            <span className="ctl-l">{nearlyFullSentence(nearlyFullPct)}</span>
            {canEdit && (
              <button type="button" className="pn-btn pn-btn--link" onClick={() => setChangeOpen(true)}>
                Change
              </button>
            )}
          </div>
        )}
        {/* One line for the whole page when the pace cannot be shown, never one per card (#4101). */}
        {view.paceNotice && (
          <div className="ctl pace-notice" data-tc="pace-notice">
            <span className="text-error font-semibold">{view.paceNotice.lead}</span>
            {view.paceNotice.rest && <span className="text-fg-muted">{view.paceNotice.rest}</span>}
          </div>
        )}
      </div>
      <div className="tc-scope dayview">
        <section className={cardCls}>
          <div className="tl">
            <div className="tabs">
              {view.tabs.map((t, i) => (
                <button
                  key={t.iso}
                  type="button"
                  data-tc="day-tab"
                  data-selected={i === selected ? "true" : undefined}
                  className={`tab${i === selected ? " on" : ""}${t.flag === "full" ? " flag full" : t.flag === "nearly-full" ? " flag" : ""}`}
                  onClick={() => setSelected(i)}
                >
                  {t.dot && <span className="dot" data-tc="tab-flag" />}
                  {t.label}
                </button>
              ))}
              <DatePicker
                zone={zone}
                todayIso={todayIso}
                selectedIso={day.iso}
                pickable={pickable}
                initialOpen={initialCalendarOpen}
                onPickInWindow={(iso) => {
                  const i = view.tabs.findIndex((t) => t.iso === iso);
                  if (i >= 0) setSelected(i);
                  return i >= 0;
                }}
              />
              <TimelineKey isToday={day.iso === todayIso} />
            </div>
            {day.note && (
              <p className="beyond-note" data-tc="day-note">
                {day.note}
              </p>
            )}
            <div className="axis">
              <span className="ax-l" />
              <div className="ax-t">
                {ticks.map((t) => (
                  <span
                    key={t.label}
                    data-tc="tick"
                    className={`tick${t.last ? " tick-last" : ""}`}
                    style={{ left: `${t.left}%`, ...(t.hidden ? { visibility: "hidden" as const } : {}) }}
                  >
                    {t.label}
                  </span>
                ))}
                {day.nowPos !== null && (
                  <span className="now-l" data-tc="now-label" style={{ left: `${day.nowPos}%` }}>
                    Now
                  </span>
                )}
              </div>
              <span className="ax-r" data-tc="open-heading">
                {OPEN_WORD}
              </span>
            </div>
            <div className="rows">
              {day.nowPos !== null && (
                <div className="nowline" data-tc="now" style={{ left: `calc(216px + (100% - 280px) * ${day.nowPos / 100})` }} />
              )}
              {day.rows.map((r) => (
                <AdvisorRow key={r.id} row={r} />
              ))}
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

const pct = (n: number) => `${n}%`;

/**
 * The timeline's key (#4101, decision 14): each of its marks at a small size, at the end of the tab
 * row and pushed right. Past, the hatching over hours already gone, is on today's tab only.
 */
function TimelineKey({ isToday }: { isToday: boolean }) {
  const entries: [keyof typeof KEY_WORDS, string][] = [
    ["busy", "sw-busy"],
    ["open", "sw-open"],
    ["off", "sw-off"],
    ...(isToday ? ([["past", "sw-past"]] as [keyof typeof KEY_WORDS, string][]) : []),
  ];
  return (
    <div className="tc-key" role="group" aria-label="Key" data-tc="key">
      {entries.map(([key, cls]) => (
        <span key={key} className="key-i" data-tc="key-item">
          <span className={`key-sw ${cls}`} data-tc="key-swatch" data-key={key} aria-hidden="true" />
          <span className="key-l">{KEY_WORDS[key]}</span>
        </span>
      ))}
    </div>
  );
}

function AdvisorRow({ row: r }: { row: CapacityRow }) {
  return (
    <div className="tr" data-tc="lane-row">
      <div className="nm">
        <a className="nm-n cal-name" data-tc="advisor" href={r.calendarHref} target="_blank" rel="noreferrer" title={`Open ${r.name}'s Google Calendar`}>
          {r.name}
        </a>
        <span className="nm-z">{r.zone}</span>
      </div>
      <div className={`lane${r.unsynced ? " faded" : ""}`} data-state={r.unsynced ? "not-syncing" : undefined}>
        {r.whole !== null ? (
          <span className="offshift wholepill" data-tc="whole-day">
            {r.whole}
          </span>
        ) : (
          <span className="offshift off-hatch" data-tc="off-shift" />
        )}
        {r.gone && <span className="past" data-tc="gone" style={{ left: pct(r.gone.left), width: pct(r.gone.width) }} />}
        {r.taken && <span className="shift dark" data-tc="taken" style={{ left: pct(r.taken.left), width: pct(r.taken.width) }} />}
        {r.timeOff.map((o) => (
          <span key={`off-${o.left}`} className="toff toff-hatch" data-tc="time-off" style={{ left: pct(o.left), width: pct(o.width) }} />
        ))}
        {r.open.map((o) => (
          <span key={`open-${o.left}`} className={`slot ${r.past ? "past-box" : "box"}`} data-tc="open-call" style={{ left: pct(o.left), width: pct(o.width) }} />
        ))}
        {r.tag && (
          <span className="warnw lane-tag" data-tc="lane-tag">
            {r.tag}
          </span>
        )}
      </div>
      <div className={r.countZero ? "cnt n0" : "cnt"} data-tc="open-count">
        {r.count}
      </div>
    </div>
  );
}

function LineForm({ pct: value, onCancel, saveAction }: { pct: number; onCancel: () => void; saveAction: (form: FormData) => Promise<void> }) {
  return (
    <SaveForm action={saveAction} name="nearly-full-line" unsaved="the nearly full line you typed" className="ctl under-ctl" data-tc="nearly-full-form">
      <label className="ctl-l">
        {"Flag a day as nearly full at "}
        <input
          name="capacity_nearly_full_pct"
          className="mt-1 w-full rounded-sm border border-border bg-[var(--field)] px-3 text-fg h-[44px] placeholder:text-fg-muted num-in"
          type="number"
          min="1"
          max="99"
          defaultValue={String(value)}
          required
        />
        {"% full or more"}
      </label>
      <SubmitButton className="pn-btn pn-btn--small pn-btn--primary" pendingLabel="Saving">
        Save
      </SubmitButton>
      <button type="button" className="pn-btn pn-btn--link" onClick={onCancel}>
        Cancel
      </button>
    </SaveForm>
  );
}

function DatePicker({
  zone,
  todayIso,
  selectedIso,
  pickable,
  initialOpen,
  onPickInWindow,
}: {
  zone: string;
  todayIso: string;
  selectedIso: string;
  pickable: string[];
  initialOpen: boolean;
  onPickInWindow: (iso: string) => boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(initialOpen);
  const today = useMemo(() => DateTime.fromISO(todayIso, { zone }), [todayIso, zone]);
  const [month, setMonth] = useState<DateTime>(() => DateTime.fromISO(selectedIso, { zone }).startOf("month"));
  const offered = useMemo(() => new Set(pickable), [pickable]);
  const first = pickable[0] ?? todayIso;
  const last = pickable.at(-1) ?? todayIso;
  return (
    <div className="dd">
      <button type="button" className="pn-btn pn-btn--small pn-btn--additional" aria-expanded={open} onClick={() => setOpen(!open)}>
        Pick a date
      </button>
      <div className="tc-pop w-72 rounded-md border border-border bg-surface-elevated p-3 shadow-pop" role="dialog" aria-label="Pick a date" data-tc="date-picker" hidden={!open}>
        <CalendarMonth
          month={month}
          today={today}
          onMonthChange={setMonth}
          canPrev={first < month.toISODate()!}
          canNext={last > month.endOf("month").toISODate()!}
          isSelected={(d) => d.toISODate() === selectedIso}
          isDisabled={(d) => !offered.has(d.toISODate()!)}
          onSelect={(d) => {
            const iso = d.toISODate()!;
            setOpen(false);
            if (!onPickInWindow(iso)) router.push(`/admin/team-capacity?day=${iso}`);
          }}
        />
      </div>
    </div>
  );
}

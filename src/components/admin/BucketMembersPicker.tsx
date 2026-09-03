"use client";

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { CheckIcon } from "@/components/icons";
import { btnSecondaryCls, labelCls } from "@/components/ui/styles";
import {
  rosterOptionOrder,
  rosterSections,
  type RosterEntry,
} from "@/lib/admin/bucket-member-picker";
import type { Criteria } from "@/lib/db/types";

/**
 * The bucket editor's manual members picker and attribute matcher (#1760).
 *
 * WHY THIS IS A CLIENT COMPONENT AT ALL. `/admin/buckets` served **8,820
 * `<input>` elements, 120 `<select>` elements and 27,240 DOM nodes** at 60
 * buckets over a 136 person roster (measured live at 9,450 inputs and 127
 * selects across the page's 64 forms), because every bucket form drew the whole
 * roster as native checkboxes plus the attribute matcher's checkbox grid. At the
 * 200 agent design target that is roughly 14,000 controls, all of them in one tab
 * order. That is a page weight and keyboard navigation defect first and a styling
 * one second, so the fix has to change WHAT IS RENDERED, not just how it looks.
 *
 * Both pickers therefore render on demand: collapsed they carry only a read-only
 * summary of what is chosen plus one hidden input per chosen value, and the full
 * list exists in the DOM only while that one panel is open.
 *
 * THE FORM CONTRACT IS UNCHANGED. The server action still reads
 * `form.getAll("members")` and the `crit_<key>` entries
 * (`src/app/admin/actions.ts`), so this posts exactly the same field names and
 * values the checkbox lists did.
 *
 * WHAT HAPPENS WITH NO JAVASCRIPT. The collapsed state is server-rendered from the
 * bucket's stored membership and criteria, so a form submitted before hydration
 * posts the CURRENT configuration back unchanged. The failure mode is "you cannot
 * edit yet", never "saving wiped the pool".
 *
 * The two pickers share the disclosure shell, the chip summary and the row
 * treatment, which is the consistency #1760 asks for. Their inner control differs
 * because their scale does: 136 people need a search box and arrow-key traversal
 * (a listbox), while an attribute catalog of a handful of values is best served by
 * real checkboxes, which cost nothing once they are only drawn on demand.
 */

// ---------------------------------------------------------------------------
// The roster, provided ONCE for the whole page
// ---------------------------------------------------------------------------

/**
 * `null` means no provider was found, which is deliberately NOT the same as an
 * empty roster: the picker says it cannot read the roster rather than drawing an
 * empty list, because an empty list is indistinguishable from an org with nobody
 * in it and this panel WRITES what it shows.
 */
const RosterContext = createContext<RosterEntry[] | null>(null);

/** Stable empty roster, so a missing provider does not re-run the memos. */
const NO_ROSTER: RosterEntry[] = [];

/**
 * Hands the roster to every members picker on the page from one place.
 *
 * One provider, not a prop per form: a `roster` prop on 60 client components
 * would serialize the whole roster into the client payload 60 times.
 */
export function RosterProvider({
  roster,
  children,
}: {
  roster: RosterEntry[];
  children: ReactNode;
}) {
  return <RosterContext.Provider value={roster}>{children}</RosterContext.Provider>;
}

// ---------------------------------------------------------------------------
// Shared presentation
// ---------------------------------------------------------------------------

const PANEL_CLS = "mt-2 rounded-md border border-border bg-surface p-4 shadow-xs";

const CHIP_CLS =
  "inline-flex items-center gap-1.5 rounded-xs bg-[var(--pennie-wild-sand)] " +
  "px-2 py-1 text-xs text-fg dark:bg-fg/10";

/**
 * A selected row or option. The selected state is carried by a tick icon and the
 * word in the row, never by the sky wash alone: colour is never the only signal.
 *
 * The width is set at each call site rather than here, because a `w-full` in the
 * shared string and a `w-auto` at the call site are the same Tailwind layer and
 * the winner is decided by CSS source order, which the call site cannot see (L509).
 */
const ROW_CLS =
  "flex min-h-11 cursor-pointer items-center gap-3 rounded-sm px-3 py-2 " +
  "text-left text-sm text-fg";
const ROW_ON_CLS = "bg-pennie-sky-soft dark:bg-accent/20";
const ROW_OFF_CLS = "hover:bg-[var(--pennie-wild-sand)] dark:hover:bg-fg/10";

const DISCLOSURE_CLS = `${btnSecondaryCls} min-h-11`;

/** The label under a group of chips or rows. */
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Manual members
// ---------------------------------------------------------------------------

/** How a person is named on screen, with the email standing in for a null name. */
const labelFor = (e: RosterEntry): string => e.name || e.email;

export function BucketMembersPicker({
  selectedIds,
  rosterTotal,
}: {
  /** The bucket's current manual member ids, from `bucket_members`. */
  selectedIds: string[];
  /** How many people are on the org roster, for the label copy. */
  rosterTotal: number;
}) {
  const roster = useContext(RosterContext);
  const [selected, setSelected] = useState<string[]>(() => [...selectedIds]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);

  const domId = useId();
  const listboxId = `${domId}-listbox`;
  const searchId = `${domId}-search`;
  const optionId = (id: string) => `${domId}-opt-${id}`;

  const disclosureRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // A module-level constant, not `?? []`: a fresh array literal per render would
  // make the memos below recompute every time the provider is absent.
  const entries = roster ?? NO_ROSTER;
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
  const sections = useMemo(() => rosterSections(entries, query), [entries, query]);
  const options = useMemo(() => rosterOptionOrder(sections), [sections]);

  // Focus the search box when the panel opens; a search you have to click into is
  // not a keyboard path.
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  const selectedSet = new Set(selected);

  function toggle(id: string) {
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  function close() {
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
    disclosureRef.current?.focus();
  }

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (options.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((i) => {
        const next = i + step;
        if (next < 0) return options.length - 1;
        if (next >= options.length) return 0;
        return next;
      });
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      if (options.length === 0) return;
      setActiveIndex(e.key === "Home" ? 0 : options.length - 1);
      return;
    }
    if (e.key === "Enter") {
      // Always prevented: Enter in a text field inside a form is a submit, and
      // this field is a search, not the form's primary action.
      e.preventDefault();
      const active = options[activeIndex];
      if (active) toggle(active.id);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  const activeOption = options[activeIndex];

  // A selected id the roster does not list (a filtered-out or since-departed
  // user) is still POSTED and still shown. Hiding it would drop the membership on
  // the next save of this form, which is the trap #1762 calls out.
  const chosen = selected.map((id) => byId.get(id) ?? null);

  return (
    <div>
      <span className={labelCls} id={`${domId}-label`}>
        Manual members (optional)
      </span>
      <p className="mt-1 text-xs text-fg-muted">
        Anyone added here joins this pool even when their attributes do not match the
        criteria above. This list is the whole org roster ({rosterTotal} people), not
        this bucket&rsquo;s eligible agents.
      </p>

      {/* Current members, surfaced separately so a pool can be read without
          scanning the roster. */}
      <div
        role="group"
        aria-label={`In this pool (${selected.length})`}
        className="mt-2 flex flex-wrap items-center gap-2"
      >
        <SectionLabel>In this pool ({selected.length})</SectionLabel>
        {selected.length === 0 ? (
          <span className="text-xs text-fg-muted">
            No one is added manually. Routing uses the criteria above.
          </span>
        ) : (
          chosen.map((entry, i) => {
            const id = selected[i]!;
            const name = entry ? labelFor(entry) : id;
            return (
              // The WHOLE chip is the remove control, so the target is the chip's
              // own 44px rather than a 20px cross inside it. Nothing is committed
              // until Save, so a mis-click costs a re-add rather than a change.
              <button
                key={id}
                type="button"
                onClick={() => toggle(id)}
                aria-label={`Remove ${name} from this pool`}
                className={`${CHIP_CLS} min-h-11 gap-2 px-3 hover:bg-fg/10`}
              >
                <span>{name}</span>
                {!entry && (
                  <span className="text-fg-muted">(not on the current roster)</span>
                )}
                <span aria-hidden="true" className="text-base text-fg-muted">
                  &times;
                </span>
              </button>
            );
          })
        )}
      </div>

      {/* One hidden input per member, so the posted `members` values are the same
          ones the checkbox list posted. These are the only inputs the collapsed
          panel carries, which is the whole point: the count now tracks actual
          memberships instead of buckets times roster. */}
      {selected.map((id) => (
        <input key={id} type="hidden" name="members" value={id} />
      ))}

      <div className="mt-2">
        <button
          type="button"
          ref={disclosureRef}
          onClick={() => (open ? close() : setOpen(true))}
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          className={DISCLOSURE_CLS}
        >
          {open ? "Done choosing members" : "Choose members"}
        </button>
      </div>

      {open && (
        <div className={PANEL_CLS}>
          <label className={labelCls} htmlFor={searchId}>
            Search the roster by name or email
          </label>
          <input
            id={searchId}
            ref={searchRef}
            type="text"
            role="combobox"
            autoComplete="off"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={activeOption ? optionId(activeOption.id) : undefined}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(-1);
            }}
            onKeyDown={onSearchKeyDown}
            placeholder="Start typing a name"
            className="mt-1 h-11 w-full rounded-sm border border-border bg-[var(--field)] px-3 text-fg placeholder:text-fg-muted"
          />
          <p className="mt-1 text-xs text-fg-muted">
            Use the up and down arrows to move through the list and Enter to add or
            remove someone. Escape closes the picker.
          </p>

          {/* Three different reasons for an empty list, each said separately: a
              roster that could not be read must never borrow the wording for a
              search that found nobody, since this panel writes what it shows. */}
          {roster === null ? (
            <p className="mt-3 text-sm text-[var(--error)]">
              The roster could not be read, so there is nobody to choose from.
              Reload the page.
            </p>
          ) : entries.length === 0 ? (
            <p className="mt-3 text-sm text-fg-muted">
              Nobody is on the org roster yet, so this pool can only be filled by
              attribute criteria.
            </p>
          ) : options.length === 0 ? (
            <p className="mt-3 text-sm text-fg-muted">
              No one on the roster matches &ldquo;{query.trim()}&rdquo;.
            </p>
          ) : (
            <ul
              id={listboxId}
              role="listbox"
              aria-multiselectable="true"
              aria-labelledby={`${domId}-label`}
              className="mt-3 max-h-72 overflow-y-auto"
            >
              {sections.map((section) => (
                // role="presentation" so the listbox owns the GROUP below rather
                // than a bare list item: a listbox may own only options and groups.
                <li key={section.section} role="presentation">
                  <ul
                    role="group"
                    aria-label={`${section.section} (${section.entries.length})`}
                    className="mb-2"
                  >
                    {/* aria-hidden: the group's own aria-label already carries
                        this section name and count, so leaving the text exposed
                        makes a screen reader say it twice per section. */}
                    <li
                      role="presentation"
                      aria-hidden="true"
                      className="sticky top-0 bg-surface px-3 py-1"
                    >
                      <SectionLabel>
                        {section.section} ({section.entries.length})
                      </SectionLabel>
                    </li>
                    {section.entries.map((entry) => {
                      const on = selectedSet.has(entry.id);
                      const isActive = activeOption?.id === entry.id;
                      return (
                        <li
                          key={entry.id}
                          id={optionId(entry.id)}
                          role="option"
                          aria-selected={on}
                          onClick={() => toggle(entry.id)}
                          // The ring marks the ARIA active descendant, not focus:
                          // focus stays on the search box, so :focus-visible can
                          // never reach this row. It reuses the global
                          // --focus-ring-line token rather than naming a colour,
                          // so it follows the theme and #1768's consolidation.
                          className={`${ROW_CLS} w-full ${on ? ROW_ON_CLS : ROW_OFF_CLS} ${
                            isActive ? "ring-2 ring-[var(--focus-ring-line)]" : ""
                          }`}
                        >
                          <span
                            aria-hidden="true"
                            className="flex size-5 shrink-0 items-center justify-center"
                          >
                            {on && <CheckIcon className="size-4" />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">{labelFor(entry)}</span>
                            {entry.name && (
                              <span className="block truncate text-xs text-fg-muted">
                                {entry.email}
                              </span>
                            )}
                          </span>
                          <span className="shrink-0 text-xs text-fg-muted">
                            {on ? "In this pool" : "Add"}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Only while closed: the open panel says the same thing in its own words,
          and two copies of one message read as two different problems. */}
      {roster === null && !open && (
        <p className="mt-2 text-xs text-[var(--error)]">
          The roster could not be read here, so nobody can be added. Reload the page
          before saving this bucket.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attribute matcher
// ---------------------------------------------------------------------------

/** The stored criteria as a key to set-of-values map. */
function currentValues(criteria: Criteria): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, cur] of Object.entries(criteria)) {
    out[key] = (Array.isArray(cur) ? cur : cur != null ? [cur] : []).map(String);
  }
  return out;
}

/**
 * The routable-attribute matcher, on the same disclosure shell as the members
 * picker above. Collapsed it draws the bucket's current criteria as chips (so a
 * pool's routing can still be read at a glance, which is why this panel was
 * always-open in the first place) plus one hidden input per chosen value; the
 * catalog's checkboxes exist only while it is open.
 */
export function BucketCriteriaPicker({
  catalog,
  current,
}: {
  catalog: Record<string, string[]>;
  current: Criteria;
}) {
  const keys = Object.keys(catalog);
  const [selected, setSelected] = useState<Record<string, string[]>>(() =>
    currentValues(current),
  );
  const [open, setOpen] = useState(false);
  const domId = useId();
  const disclosureRef = useRef<HTMLButtonElement>(null);

  function toggle(key: string, value: string) {
    setSelected((cur) => {
      const have = cur[key] ?? [];
      const next = have.includes(value)
        ? have.filter((v) => v !== value)
        : [...have, value];
      return { ...cur, [key]: next };
    });
  }

  const chosenPairs = Object.entries(selected).flatMap(([key, values]) =>
    values.map((value) => ({ key, value })),
  );

  /**
   * Chosen values the catalog no longer offers, because no live agent carries the
   * attribute any more. The open panel draws no control for them, so without these
   * hidden inputs a save made while the panel was open would silently drop the
   * bucket's stored routing, and a save made while it was closed would not: the
   * same button destroying different things depending on what had been clicked.
   */
  const orphanPairs = chosenPairs.filter(
    ({ key, value }) => !(catalog[key] ?? []).includes(value),
  );

  if (keys.length === 0) {
    return (
      <div>
        <span className={labelCls}>
          Route to agents matching every criteria group (any value within a group)
        </span>
        <p className="mt-1 text-xs text-fg-muted">
          No agent attributes synced yet. Sync from Salesforce to route by attribute.
        </p>
        {/* The stored criteria are still posted back: an unreadable catalog must
            not silently clear a bucket's routing on the next save. */}
        {chosenPairs.map(({ key, value }) => (
          <input key={`${key}:${value}`} type="hidden" name={`crit_${key}`} value={value} />
        ))}
      </div>
    );
  }

  return (
    <div>
      <span className={labelCls} id={`${domId}-label`}>
        Route to agents matching every criteria group (any value within a group)
      </span>

      <div
        role="group"
        aria-label="Current routing criteria"
        className="mt-2 flex flex-wrap items-center gap-2"
      >
        <SectionLabel>Current routing criteria</SectionLabel>
        {chosenPairs.length === 0 ? (
          <span className="text-xs text-fg-muted">
            No attribute criteria. This bucket routes to its manual members only.
          </span>
        ) : (
          chosenPairs.map(({ key, value }) => (
            <span key={`${key}:${value}`} className={CHIP_CLS}>
              <span className="text-fg-muted">{key}</span>
              <span>{value}</span>
            </span>
          ))
        )}
      </div>

      {!open &&
        chosenPairs.map(({ key, value }) => (
          <input key={`${key}:${value}`} type="hidden" name={`crit_${key}`} value={value} />
        ))}

      <div className="mt-2">
        <button
          type="button"
          ref={disclosureRef}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className={DISCLOSURE_CLS}
        >
          {open ? "Done choosing criteria" : "Choose routing criteria"}
        </button>
      </div>

      {open && (
        <div className={PANEL_CLS}>
          {orphanPairs.length > 0 && (
            <p className="mb-3 text-xs text-fg-muted">
              {orphanPairs.map((p) => `${p.key}: ${p.value}`).join(", ")}{" "}
              {orphanPairs.length === 1 ? "is" : "are"} still set on this bucket and
              no longer offered by any agent, so {orphanPairs.length === 1 ? "it has" : "they have"}{" "}
              no control here. Saving keeps {orphanPairs.length === 1 ? "it" : "them"}.
            </p>
          )}
          {orphanPairs.map(({ key, value }) => (
            <input key={`${key}:${value}`} type="hidden" name={`crit_${key}`} value={value} />
          ))}
          {keys.map((key) => (
            <fieldset key={key} className="mb-3 last:mb-0">
              <legend className="mb-1">
                <SectionLabel>{key}</SectionLabel>
              </legend>
              <div className="flex flex-wrap gap-2">
                {catalog[key]!.map((value) => {
                  const on = (selected[key] ?? []).includes(value);
                  return (
                    <label
                      key={value}
                      className={`${ROW_CLS} shrink-0 ${on ? ROW_ON_CLS : ROW_OFF_CLS}`}
                    >
                      <input
                        type="checkbox"
                        name={`crit_${key}`}
                        value={value}
                        checked={on}
                        onChange={() => toggle(key, value)}
                        className="size-4 accent-pennie-sky"
                      />
                      <span>{value}</span>
                      <span
                        aria-hidden="true"
                        className="flex size-4 items-center justify-center"
                      >
                        {on && <CheckIcon className="size-4" />}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>
      )}
    </div>
  );
}

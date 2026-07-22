import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/log";
import type { ReasonOptionRow as DbReasonOptionRow } from "@/lib/db/types";
import {
  RESCHEDULE_REASONS,
  CANCEL_REASONS,
  REASSIGN_REASONS,
  type ReasonAction,
  type ReasonOption,
} from "./core.ts";

/**
 * Org-configurable reschedule/cancel/reassign reason options (#346). The three
 * lists move out of compiled constants into the `reason_options` store so an
 * admin can add/relabel/reorder/retire driver categories without a deploy. Codes
 * are a STABLE analytics taxonomy (#325): immutable once created, never
 * repurposed; retiring is soft (active=false) so history stays readable.
 *
 * This module is PURE (no DB): sluging + collision + resolve + form parse. The
 * error-safe loader that reads the store lives beside it in `reason-options-load.ts`.
 */

/** The working shape of a store row for the pure logic: the columns that drive
 *  pickers + validation, without the DB audit columns. Derived from the DB row
 *  type so there is a single source of truth for the shape. */
export type ReasonOptionRow = Pick<
  DbReasonOptionRow,
  "action" | "code" | "label" | "sort_order" | "active" | "locked"
>;

/** The coded defaults, by action: the seed values AND the never-throw fallback. */
export const CODED_DEFAULTS: Record<ReasonAction, ReasonOption[]> = {
  reschedule: RESCHEDULE_REASONS,
  cancel: CANCEL_REASONS,
  reassign: REASSIGN_REASONS,
};

export const REASON_ACTIONS: ReasonAction[] = ["reschedule", "cancel", "reassign"];

/**
 * System codes an admin may not rename, retire, or reorder off the end. `other`
 * (all actions) is the free-text escape hatch wired into validateReason;
 * `owner_reassignment` is the code the automated reassign path emits, so the
 * reassign list must always carry it.
 */
export const LOCKED_CODES: Record<ReasonAction, string[]> = {
  reschedule: ["other"],
  cancel: ["other"],
  reassign: ["owner_reassignment", "other"],
};

/** Max length of a reason label (the admin editor enforces the same bound). */
export const REASON_LABEL_MAX = 80;

/**
 * Derive a stable analytics code from a human label: lowercase, keep [a-z0-9],
 * collapse any run of other characters to a single underscore, trim leading and
 * trailing underscores. A label with no usable characters yields "" and the
 * caller must reject it (a code can never be empty).
 */
export function slugifyCode(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Return `base` if free, else `base_2`, `base_3`, ... until unique against the
 * existing codes (which MUST include retired rows, so a code is never reused).
 */
export function uniqueCode(base: string, existing: Iterable<string>): string {
  const taken = existing instanceof Set ? existing : new Set(existing);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const byOrder = (a: ReasonOptionRow, b: ReasonOptionRow): number =>
  a.sort_order - b.sort_order;

const toOption = (r: ReasonOptionRow): ReasonOption => ({ code: r.code, label: r.label });

/** A resolved action: `all` (incl. retired, for labels) + `active` (for pickers). */
export interface ResolvedAction {
  all: ReasonOption[];
  active: ReasonOption[];
}

/**
 * Resolve store rows into pickable options per action, sorted by sort_order.
 * `all` carries every row (incl. retired) for label rendering; `active` filters
 * to active rows for the pickers. An action with NO stored rows falls back to
 * its coded default (both lists), so an empty/partial store never breaks a flow.
 */
export function resolveReasonOptions(
  rows: ReasonOptionRow[],
): Record<ReasonAction, ResolvedAction> {
  const out = {} as Record<ReasonAction, ResolvedAction>;
  for (const action of REASON_ACTIONS) {
    const forAction = rows.filter((r) => r.action === action).sort(byOrder);
    if (forAction.length === 0) {
      const def = CODED_DEFAULTS[action];
      out[action] = { all: def, active: def };
      continue;
    }
    out[action] = {
      all: forAction.map(toOption),
      active: forAction.filter((r) => r.active).map(toOption),
    };
  }
  return out;
}

/** One submitted editor row: an existing code (or "" for a new row), label, active. */
export interface ReasonOptionFormRow {
  code: string;
  label: string;
  active: boolean;
}

/** The admin editor's submitted state: ordered rows per action. */
export type ReasonOptionsFormInput = Record<ReasonAction, ReasonOptionFormRow[]>;

/** The parsed store payload: the COMPLETE set of rows to upsert, plus errors. */
export interface ReasonOptionsParseResult {
  rows: ReasonOptionRow[];
  errors: string[];
}

const codedLabel = (action: ReasonAction, code: string): string =>
  CODED_DEFAULTS[action].find((o) => o.code === code)?.label ??
  code.charAt(0).toUpperCase() + code.slice(1);

/**
 * Parse the admin editor's submitted rows into the COMPLETE store set to upsert
 * (#346). Pure. Rules:
 * - sort_order follows submitted order; locked rows are protected by forced-active
 *   + re-injection (below), not by position, so the editor's order is preserved;
 * - a new row (blank code) derives a stable code = uniqueCode(slugifyCode(label)),
 *   unique within the action against every other code (existing, retired, locked,
 *   and other new rows in this submission); a blank/unsluggable/over-long label errors;
 * - a locked code is always active (can't be retired) and keeps its code;
 * - any locked code missing from the submission is re-injected active (defends
 *   against a stale or tampered form), so the free-text + machine codes always exist.
 * The write is a pure keyed upsert of this whole set: NEVER retire-by-absence.
 */
export function parseReasonOptionsForm(
  input: ReasonOptionsFormInput,
): ReasonOptionsParseResult {
  const errors: string[] = [];
  const rows: ReasonOptionRow[] = [];

  for (const action of REASON_ACTIONS) {
    const locked = new Set(LOCKED_CODES[action]);
    const submitted = input[action] ?? [];
    // Reserve every existing + locked code so new codes never collide with them.
    const taken = new Set<string>(locked);
    for (const r of submitted) {
      const c = r.code.trim();
      if (c) taken.add(c);
    }

    const built: ReasonOptionRow[] = [];
    const seenLocked = new Set<string>();
    for (const r of submitted) {
      const label = r.label.trim();
      const existingCode = r.code.trim();
      const isLocked = existingCode !== "" && locked.has(existingCode);

      if (!label) {
        errors.push(`A reason label can't be blank (${action}).`);
        continue;
      }
      if (label.length > REASON_LABEL_MAX) {
        errors.push(`A reason label must be ${REASON_LABEL_MAX} characters or fewer (${action}).`);
        continue;
      }

      let code = existingCode;
      if (!code) {
        const base = slugifyCode(label);
        if (!base) {
          errors.push(`"${label}" has no usable letters or numbers for a code (${action}).`);
          continue;
        }
        code = uniqueCode(base, taken);
        taken.add(code);
      }
      if (isLocked) seenLocked.add(code);

      built.push({
        action,
        code,
        label,
        sort_order: 0, // assigned after, below
        active: isLocked ? true : r.active,
        locked: isLocked,
      });
    }

    // Re-inject any locked code the form omitted (stale/tampered form defense).
    for (const code of LOCKED_CODES[action]) {
      if (!seenLocked.has(code)) {
        built.push({
          action,
          code,
          label: codedLabel(action, code),
          sort_order: 0,
          active: true,
          locked: true,
        });
      }
    }

    // Submitted order is preserved; re-injected missing locked rows land at the end.
    built.forEach((r, i) => (r.sort_order = i));
    rows.push(...built);
  }

  return { rows, errors };
}

const asString = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Coerce an untrusted JSON payload (from the admin editor) into a safe
 * ReasonOptionsFormInput: unknown/missing actions become [], non-object rows are
 * dropped, and non-string code/label / non-boolean active are coerced to
 * ""/""/false. NEVER throws, so parseReasonOptionsForm only ever sees well-typed
 * rows. The real validation (labels, codes, locking) is parseReasonOptionsForm's job.
 */
export function coerceReasonOptionsForm(raw: unknown): ReasonOptionsFormInput {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = {} as ReasonOptionsFormInput;
  for (const action of REASON_ACTIONS) {
    const list = Array.isArray(obj[action]) ? (obj[action] as unknown[]) : [];
    out[action] = list
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .map((r) => ({
        code: asString(r.code),
        label: asString(r.label),
        active: r.active === true,
      }));
  }
  return out;
}

/** The coded-default options as full editor rows (the empty-store seed), with the
 *  locked flag set per LOCKED_CODES and sort_order = the coded array index. */
export function codedRows(action: ReasonAction): ReasonOptionRow[] {
  const locked = new Set(LOCKED_CODES[action]);
  return CODED_DEFAULTS[action].map((o, i) => ({
    action,
    code: o.code,
    label: o.label,
    sort_order: i,
    active: true,
    locked: locked.has(o.code),
  }));
}

/**
 * Group store rows into full editor rows per action, sorted by sort_order. An
 * action with no stored rows falls back to its coded defaults as seed rows (so the
 * editor always shows a populated, editable list even before the first save).
 */
export function resolveEditorRows(
  rows: ReasonOptionRow[],
): Record<ReasonAction, ReasonOptionRow[]> {
  const out = {} as Record<ReasonAction, ReasonOptionRow[]>;
  for (const action of REASON_ACTIONS) {
    const forAction = rows.filter((r) => r.action === action).sort(byOrder);
    out[action] = forAction.length ? forAction : codedRows(action);
  }
  return out;
}

/** Read the full store rows (incl. retired) for the admin editor, grouped per
 *  action. NEVER throws: a read error logs and degrades to the coded-default seed. */
export async function loadReasonOptionRows(
  read: ReasonOptionsReader = defaultReader,
): Promise<Record<ReasonAction, ReasonOptionRow[]>> {
  try {
    const { data, error } = await read();
    if (error) {
      log.error(
        "reason-options",
        { msg: "editor store read failed; seeding coded defaults" },
        error instanceof Error ? error : new Error(String(error)),
      );
      return resolveEditorRows([]);
    }
    return resolveEditorRows(data ?? []);
  } catch (e) {
    log.error(
      "reason-options",
      { msg: "editor store read threw; seeding coded defaults" },
      e instanceof Error ? e : new Error(String(e)),
    );
    return resolveEditorRows([]);
  }
}

/** The store read result: rows + a query error (either may be null). */
export interface ReasonOptionsReadResult {
  data: ReasonOptionRow[] | null;
  error: unknown;
}

/** Reads the `reason_options` store. Injectable so the error path is testable. */
export type ReasonOptionsReader = () => Promise<ReasonOptionsReadResult>;

const defaultReader: ReasonOptionsReader = async () => {
  // cap-safe: reason_options is roster/config-bounded (a few dozen rows across 3
  // actions), so a single unbounded page always holds the whole set. In SAFE_TABLES.
  const { data, error } = await supabaseAdmin()
    .from("reason_options")
    .select("action,code,label,sort_order,active,locked");
  return { data: (data as ReasonOptionRow[] | null) ?? null, error };
};

/**
 * Resolve the live reason options from the store (#346). NEVER throws: a read
 * error (incl. the table not existing during a migrate-before-deploy window) is
 * LOGGED and degrades to the coded-default taxonomy, so booking flows keep working
 * with the built-in reasons. Consulting `error` and logging it keeps this fail-loud
 * (visible in logs), not a silent swallow.
 */
export async function loadReasonOptions(
  read: ReasonOptionsReader = defaultReader,
): Promise<Record<ReasonAction, ResolvedAction>> {
  try {
    const { data, error } = await read();
    if (error) {
      log.error(
        "reason-options",
        { msg: "store read failed; using coded default reasons" },
        error instanceof Error ? error : new Error(String(error)),
      );
      return resolveReasonOptions([]);
    }
    return resolveReasonOptions(data ?? []);
  } catch (e) {
    log.error(
      "reason-options",
      { msg: "store read threw; using coded default reasons" },
      e instanceof Error ? e : new Error(String(e)),
    );
    return resolveReasonOptions([]);
  }
}

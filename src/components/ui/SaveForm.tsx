"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { btnSecondaryCls } from "@/components/ui/styles";
import { UnsavedGuard } from "@/components/ui/UnsavedGuard";
import { isStaleActionError, STALE_ACTION_NOTICE, STALE_ACTION_TITLE } from "@/lib/stale-action";
import {
  clearStash,
  entriesToRestored,
  readStash,
  restoredValue,
  stashForm,
  type RestoredForm,
} from "@/lib/form-restore";

/**
 * A form whose save survives a deploy landing underneath it (#1994).
 *
 * ## What it is for
 *
 * A browser submitting a server action names it by an id minted at BUILD time.
 * When a deploy lands under a page somebody already has open, that name is gone
 * and Next replies 404. A plain `<form action={serverAction}>` with nothing
 * catching that sends it to the error boundary, which says "this page did not
 * finish loading, and this screen cannot tell whether it did": honest, and
 * useless, because it cannot separate a click that never reached the server from
 * a week the server refused, and those need opposite responses.
 *
 * Here the cause is known exactly, so the sentence can be exact: nothing was
 * saved, reload, and what you typed is kept.
 *
 * ## Every other failure still goes where it went
 *
 * Only `isStaleActionError` is swallowed. A genuine refusal still throws, a
 * redirect still redirects (a redirect travels as a thrown error too, and it is
 * not an unrecognized action error, so it passes straight through), and an
 * unexpected fault still reaches the boundary. A wrapper that caught everything
 * would turn "Tuesday's windows overlap each other" into "reload and try again",
 * which is advice that can never work (L111).
 *
 * ## The reload does not happen on its own
 *
 * It is offered as a control. An automatic reload would be the one thing that
 * could still lose the person's work if the restore below ever failed, and it
 * would do it instantly, with no way back. Offered, they keep what is on screen
 * either way.
 */
/**
 * The exemption from the unsaved guard, written as the REASON rather than as a
 * screen (#2076, L362, L615).
 *
 * A form that holds a VIEW rather than work: a filter row, a lookup. Losing what
 * is in one is an annoyance, not lost work, and a guard that fires on filters is
 * the one people learn to click through, after which it is not protecting the
 * alert floors either (L36).
 *
 * It takes the reason as an argument, at the call site, so the justification
 * travels with the decision instead of being a name somebody applies. Every other
 * exemption is a decision somebody has to argue for in the change that makes it.
 */
export function holdsAView(_why: string): typeof HOLDS_A_VIEW {
  return HOLDS_A_VIEW;
}

/** The sentinel `holdsAView` returns. Compared by identity, never typed by hand. */
export const HOLDS_A_VIEW = "\u0000holds-a-view" as const;

export function SaveForm({
  action,
  name,
  unsaved,
  children,
  className,
  onStale = "notice",
  ...rest
}: {
  action: (form: FormData) => Promise<void>;
  /** Separates two forms on one page in the stash. */
  name: string;
  /**
   * What this form would lose, as a noun phrase ("changes to these hours"), or
   * `holdsAView("why")` for a form that holds no work at all (#2076).
   *
   * REQUIRED, and that is the whole point. The guard was opt in and five of
   * sixteen call sites took it, so Dan lost fourteen alert floors he had typed by
   * clicking a link. A behaviour each call site must opt into cannot be enforced
   * by a scan, because a site that never opted in is indistinguishable from one
   * where the condition never arises (L621). Required, `tsc` enumerates every
   * construction site, the way `businessHours` is required on `SlotRules`.
   *
   * Nothing has to be declared about DIRTINESS: the guard measures it, by diffing
   * the form against the values it rendered with. A form holding only a button
   * can never be dirty, so it is silent with no exception written for it.
   */
  unsaved: string;
  children: ReactNode;
  className?: string;
  /**
   * What a stale save does here (#1998).
   *
   * `notice` is the default and the right answer wherever there is something to
   * say and room to say it: nothing was saved, reload, what you typed is kept.
   *
   * `reload` is for a form that holds NOTHING TYPED and whose action navigates
   * or changes the session: sign out, view as, stop impersonating. Two reasons,
   * and the second is the one that decides it.
   *
   * There is nowhere to put the notice. Those three sit inside a menu, taken out
   * of the layout and the accessibility tree with `display: contents` and
   * `role="none"` so the button becomes the menu's own child. An alert rendered
   * in there is a `role="alert"` inside a `role="menu"`, which the role does not
   * allow, and it would break the structure the menu depends on.
   *
   * And there is nothing the notice would say that the reload does not say
   * better. Nothing is lost, the person asked to go somewhere, and reloading is
   * that request honoured a page load later. A message telling them to press
   * reload themselves is a step they gain nothing from taking.
   */
  onStale?: "notice" | "reload";
} & Omit<React.FormHTMLAttributes<HTMLFormElement>, "action" | "name">) {
  const [stale, setStale] = useState(false);
  // Whether the cheap recovery has already been tried on THIS page load. A
  // reload makes the page current, so a second stale save in the same load can
  // only mean a deploy landed in those few seconds. Reloading again would be a
  // loop, so the error is let through to the boundary instead: we tried the
  // quiet fix, it did not help, and hiding that is worse than showing it.
  const reloadedRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  // Read ONCE, before the fields mount, because a field takes its restored value
  // as its initial state and there is no second chance to hand it over.
  const [restored] = useState<RestoredForm | null>(() => {
    if (typeof window === "undefined") return null;
    return readStash(window.sessionStorage, window.location.pathname, name);
  });

  // Cleared after the fields have taken their values, so a later reload does not
  // silently re-apply values the person has since changed.
  useEffect(() => {
    if (restored && typeof window !== "undefined") {
      clearStash(window.sessionStorage, window.location.pathname, name);
    }
  }, [restored, name]);

  // Plain uncontrolled controls are restored here, because they have no state of
  // their own to take an initial value into. The fields that DO (`TimeField`)
  // read the context below instead, and must not be touched from out here: a
  // value written onto their hidden input is overwritten by the next render.
  useEffect(() => {
    const form = formRef.current;
    if (!restored || !form) return;
    for (const el of form.elements) {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) continue;
      if (!el.name || el.dataset.restoreOwn === "true") continue;
      const values = restored[el.name];
      if (!values) continue;
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        el.checked = values.includes(el.value);
      } else if (el.type !== "hidden") {
        el.value = values[0] ?? "";
      }
    }
  }, [restored]);

  async function run(formData: FormData) {
    try {
      await action(formData);
    } catch (err) {
      if (!isStaleActionError(err)) throw err;
      if (onStale === "reload") {
        if (reloadedRef.current || typeof window === "undefined") throw err;
        reloadedRef.current = true;
        window.location.reload();
        return;
      }
      if (typeof window !== "undefined") {
        stashForm(
          window.sessionStorage,
          window.location.pathname,
          name,
          entriesToRestored(formData.entries()),
        );
      }
      setStale(true);
    }
  }

  const restoredContext = useMemo(() => ({ form: restored }), [restored]);

  return (
    <RestoreContext.Provider value={restoredContext}>
      <form ref={formRef} action={run} className={className} {...rest}>
        {/* #2076: by DEFAULT, not by opt in. Silent unless the form actually
            differs from what it rendered with, so a form holding only a button
            needs no exception written for it. */}
        {unsaved !== HOLDS_A_VIEW && <UnsavedGuard what={unsaved} />}
        {stale && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-border bg-[var(--bg-alt)] px-4 py-3 text-sm"
          >
            <p className="font-semibold">{STALE_ACTION_TITLE}</p>
            <p className="mt-1 text-fg-muted">{STALE_ACTION_NOTICE}</p>
            <button
              type="button"
              className={`${btnSecondaryCls} mt-3`}
              onClick={() => window.location.reload()}
            >
              Reload the page
            </button>
          </div>
        )}
        {restored && !stale && (
          <p role="status" className="mb-4 text-sm text-fg-muted">
            What you had typed before the last reload has been put back. Check it
            and press save.
          </p>
        )}
        {children}
      </form>
    </RestoreContext.Provider>
  );
}

const RestoreContext = createContext<{ form: RestoredForm | null }>({ form: null });

/**
 * A field's restored value, for a control that owns its own state.
 *
 * Used as the INITIAL state, never assigned afterwards, so the field goes on
 * behaving exactly as it does on an ordinary load. A control using this must
 * also carry `data-restore-own="true"` on whatever it renders into the form, so
 * the blanket restore above leaves it alone.
 */
export function useRestoredValue(name: string | undefined): string | null {
  // Takes an ABSENT name rather than being called conditionally: it reads a
  // context, so a caller that skipped it for an unnamed field would be calling a
  // hook conditionally, which React refuses.
  const { form } = useContext(RestoreContext);
  return name === undefined ? null : restoredValue(form, name);
}

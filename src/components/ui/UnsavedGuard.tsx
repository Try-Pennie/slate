"use client";

import { useEffect, useRef, useState } from "react";
import { btnCls, btnSecondaryCls } from "@/components/ui/styles";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { formSnapshot } from "./formSnapshot";
import { entriesToRestored, stashForm } from "@/lib/form-restore";

/**
 * Warn before leaving a form that has edits nobody has saved (#1966).
 *
 * Dan changed his working hours, refreshed, and lost them with no warning.
 *
 * TWO GUARDS, BECAUSE ONE COVERS THE WRONG HALF. `beforeunload` covers a
 * refresh, a close and the browser's back button, and in an admin console the
 * far commoner way to lose work is clicking "Buckets" in the sidebar, which is a
 * client side navigation `beforeunload` never sees. A change that added only the
 * browser guard, got tested by refreshing, and shipped would leave the common
 * case exactly as broken while reading as fixed.
 *
 * So the in app half intercepts link clicks in the capture phase, before the
 * router hears about them, and that is also the half where a useful message can
 * live: the browser's own dialog text is fixed and cannot say WHAT is unsaved.
 *
 * Mounted INSIDE the form it guards, and it finds that form itself rather than
 * being handed one, so a caller cannot point it at the wrong one.
 */
export function UnsavedGuard({ what, formName }: { what: string; formName: string }) {
  const marker = useRef<HTMLSpanElement>(null);
  const saved = useRef<string | null>(null);
  const [leavingTo, setLeavingTo] = useState<string | null>(null);
  /** Set when the browser would not keep the draft, so nothing promises it did. */
  const [couldNotKeep, setCouldNotKeep] = useState(false);
  const stayRef = useRef<HTMLButtonElement>(null);
  /** The link that was stopped, so staying puts focus back where it was. */
  const stoppedAt = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    const form = marker.current?.closest("form");
    if (!form) return;

    /** The values as they were last SAVED, which is how they were rendered. */
    saved.current = formSnapshot(form);

    // Whether anybody has INTERACTED with this form since it was rendered.
    //
    // Needed once the guard became SaveForm's default (#2076), because a form's
    // rendered values also change WITHOUT anybody touching them: a server action
    // anywhere on the page revalidates it, and a re-render can legitimately hand a
    // field a different value. The clearest case is a toggle whose hidden field
    // carries the OPPOSITE of the current state, which flips on every save; against
    // the snapshot alone that form reads as permanently edited and warns on the
    // next link click about work nobody did.
    //
    // Interaction is the thing that separates the two, because a re-render fires
    // none of these events. It only ever SUPPRESSES: the snapshot still decides,
    // so a person who types and undoes is not dirty, and a click on a button that
    // edits nothing is not either.
    let touched = false;
    const onTouch = () => {
      touched = true;
    };
    form.addEventListener("input", onTouch);
    form.addEventListener("change", onTouch);
    form.addEventListener("click", onTouch);

    const dirty = () => touched && saved.current !== null && formSnapshot(form) !== saved.current;

    // A submit means these values are the saved ones from now on. Taken after a
    // tick so the snapshot reads the form as it was submitted. If the save then
    // FAILS the guard is quiet until the next edit, which is the mild direction:
    // the person is still on the page looking at an error, and the alternative
    // is warning them about work the screen is telling them was not saved.
    const onSubmit = () => {
      touched = false;
      window.setTimeout(() => {
        saved.current = formSnapshot(form);
      }, 0);
    };
    form.addEventListener("submit", onSubmit);

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirty()) return;
      // The only thing that makes the browser ask. Its wording is the browser's
      // and cannot be set, which is why the in app half exists.
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);

    const onClick = (e: MouseEvent) => {
      // Anything the person has told the browser to handle differently is left
      // alone: a new tab keeps this page and its edits, and a modified click is
      // a deliberate one.
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      // A link inside the guarded form is part of the form, not a way out of it.
      if (form.contains(link)) return;

      const href = link.getAttribute("href") ?? "";
      // Only an in app destination: an external link leaves through
      // `beforeunload`, and a bare fragment goes nowhere.
      if (!href.startsWith("/") || href.startsWith("//")) return;

      // Dirtiness LAST, because it is the only expensive question here and every
      // check above answers most clicks without asking it (#2076). This listener
      // is on the document, so once every form carries a guard a page with sixty
      // of them runs sixty of these on every click anywhere; the cheap tests
      // reject all but an in app link navigation, which is rare.
      if (!dirty()) return;

      // Capture phase plus stopPropagation, so the router's own handler never
      // runs. Preventing default alone would leave the client side navigation to
      // proceed.
      e.preventDefault();
      e.stopPropagation();
      stoppedAt.current = link;
      setLeavingTo(href);
    };
    document.addEventListener("click", onClick, true);

    return () => {
      form.removeEventListener("input", onTouch);
      form.removeEventListener("change", onTouch);
      form.removeEventListener("click", onTouch);
      form.removeEventListener("submit", onSubmit);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, []);

  // #3081: a NATIVE modal, now the shared ModalDialog (#4205), which opens it with
  // showModal, contains focus and lands it on STAYING, never on the button that
  // discards the work, which is the same choice the erasure confirm makes.

  /** Close without leaving, and hand focus back to the link that was stopped,
   *  which is where the person was before the dialog interrupted them. */
  const stay = () => {
    setLeavingTo(null);
    const back = stoppedAt.current;
    stoppedAt.current = null;
    // After the dialog has gone: a modal dialog makes the link inert, and an
    // inert element cannot take focus.
    window.setTimeout(() => back?.focus(), 0);
  };

  return (
    <>
      <span ref={marker} hidden />
      <ModalDialog open={leavingTo !== null} onClose={stay} labelledBy="unsaved-guard-title" initialFocusRef={stayRef}>
        <h2 id="unsaved-guard-title" className="text-base font-semibold text-fg">
          You have unsaved {what}
        </h2>
        <p className="mt-1 text-sm text-fg-muted">
          {couldNotKeep
            ? "Your browser would not let us keep what you typed, so nothing has been kept and you are still on this page. Copy anything you need before you leave."
            : "Nothing has been saved yet. Leaving keeps what you typed, and it will be here when you come back to this page."}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            ref={stayRef}
            type="button"
            className={btnCls}
            onClick={stay}
          >
            Stay on this page
          </button>
          <button
            type="button"
            className={btnSecondaryCls}
            onClick={() => {
              const to = leavingTo;
              if (to === null) return;
              const form = marker.current?.closest("form");
              // #2077: KEPT, not discarded. A warning is still one click away
              // from losing the work, and Dan's framing was stronger than a
              // warning: "I should never be able to lose something I typed by
              // going to another page."
              //
              // Attempted BEFORE the navigation and checked, because the dialog
              // above has just promised it: a browser with storage full or
              // disabled would otherwise take them away on a promise nothing
              // kept (L12). On a refusal they stay where they are, with their
              // work, and the panel says so.
              if (form && typeof window !== "undefined") {
                const kept = stashForm(
                  window.sessionStorage,
                  window.location.pathname,
                  formName,
                  entriesToRestored(new FormData(form).entries()),
                  "navigation",
                );
                if (!kept) {
                  setCouldNotKeep(true);
                  return;
                }
              }
              // Cleared BEFORE navigating, so neither half of the guard
              // catches its own departure: the click interceptor stands down
              // and `beforeunload` stays quiet on the way out.
              saved.current = null;
              setLeavingTo(null);
              // An ordinary navigation rather than the app router,
              // DELIBERATELY. `useRouter` would make every form that mounts
              // this guard require a mounted router, which broke six
              // existing test files at once and would have left "remember to
              // mock next/navigation" as a rule living only in a prompt
              // (L27). The cost is one full page load on a click whose whole
              // purpose is to leave and discard, which is the cheapest place
              // in the app to spend it.
              window.location.assign(to);
            }}
          >
            {couldNotKeep ? "Leave and lose it" : "Leave, and keep it for later"}
          </button>
        </div>
      </ModalDialog>
    </>
  );
}

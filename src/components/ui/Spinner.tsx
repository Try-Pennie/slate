/**
 * The one working cue for an INTERNAL action that does not return instantly
 * (#1792).
 *
 * Two of these existed, character for character identical except the size, inline
 * in `LinkPending` and `SubmitButton`. Third time that pattern appeared in a week,
 * after the time pickers (#1765) and the focus rings (#1768), and each copy read
 * as a local styling decision at the point it was written.
 *
 * Three things are decided here rather than per call site.
 *
 * IT OWNS ITS SPACING. The old spinner carried none and depended on the parent to
 * supply it: `SubmitButton` wrapped it in a `gap-2` flex and looked right, and the
 * sidebar's `Link` had no gap at all, so there the spinner touched the "r" in
 * Roster. That is a component correct only while its callers do something, with
 * nothing enforcing it, false at the first caller that does not (L550). Fixing it
 * by adding a gap to the sidebar would have left the next caller to rediscover it,
 * so the margin lives here and no call site can take it away.
 *
 * IT IS AN ARC, NOT A BORDERED CIRCLE. The old recipe turned one border edge of a
 * round element transparent, which leaves hard square ends where the transparent
 * edge meets the solid one; at 14px that reads as a crude broken ring rather than
 * a drawn stroke. An SVG stroke takes `stroke-linecap="round"`, which is the whole
 * reason this is SVG.
 *
 * ITS COLOUR COMES FROM THE SURFACE. `border-current` meant the cue changed weight
 * with whichever control you happened to click, and was darkest on the active nav
 * item. The obvious replacement, the sky accent, is worse rather than better: it
 * measures 1.57:1 on beige and 1.00:1 on a sky fill, which is the exact failure
 * #1768 deleted twenty five per-component focus rings over. A thin line drawn on a
 * surface is that same problem, so it takes that same already measured answer via
 * `--cue-line` (brand blue on ordinary light surfaces, graphite on an accent fill,
 * sky on dark). The numbers are asserted by name in scripts/test-contrast.ts.
 *
 * It is `aria-hidden` on purpose. The wait is already announced by the sibling
 * `pn-loadbar` (`role="status"`) and by SubmitButton's own live region, so a
 * graphic that also spoke would announce one wait twice.
 *
 * `BobbingDots` remains the LEAD facing cue and is deliberately a different
 * signal; the reason is written down beside it.
 */
export function Spinner({ size = "md" }: { size?: "sm" | "md" }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      data-spinner
      className={`${
        size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"
      } mx-1.5 shrink-0 animate-spin text-[var(--cue-line)] motion-reduce:animate-none`}
    >
      {/* The track: decorative, and deliberately faint so the moving arc is what
          the eye follows. */}
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      {/* A quarter turn, so there is an unambiguous leading end to follow. */}
      <path d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

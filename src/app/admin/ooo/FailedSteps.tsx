import type { EffectState } from "@/lib/ooo/effect-copy";

/**
 * The calendar steps that did not land, as visible text under the request
 * (#1477).
 *
 * This detail used to live in the `title` attribute of the red marker, which is
 * unreachable on touch, unreliable for a screen reader, and invisible to
 * keyboard navigation (L49). This is the surface someone lands on after an
 * alert, deciding whether to press Retry, so the hidden detail was the detail
 * that decides the next action.
 *
 * Its own component so it can be mounted and asserted against directly: the page
 * around it is an async server component that testing-library cannot render
 * synchronously, and "the text is on the page" is exactly the claim that has to
 * be proved rather than read.
 */
export function FailedSteps({ steps }: { steps: EffectState[] }) {
  if (steps.length === 0) return null;
  return (
    <ul className="mt-1.5 space-y-0.5 text-xs text-error">
      {steps.map((s) => (
        <li key={s.key}>
          Not in place: {s.label}
          {s.reason ? ` (${s.reason})` : ""}
        </li>
      ))}
    </ul>
  );
}

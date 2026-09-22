"use client";

/**
 * Three dots travelling in sequence: the shared working signal for a lead-facing
 * action that does not return instantly.
 *
 * Lifted out of SlotTimes (#1364) so the next-available search shows the SAME cue
 * rather than a second one invented beside it. Two working signals that look
 * different in one product are two things for a lead to learn.
 *
 * A pulse fades in and out, so a glance away can land on the dim half and read
 * as nothing happening. Dots that bob read as working even out of the corner of
 * an eye, which is what someone half paying attention to a booking form
 * actually gets. Position only, never opacity (the fade would reintroduce the
 * exact problem), and they carry the accent explicitly rather than inheriting
 * the muted colour of the line below. `pn-bob` in globals.css owns the motion
 * and the reduced-motion stop, where the line of text carries the message alone.
 *
 * THIS IS NOT THE SAME CUE AS `Spinner`, AND THAT IS DELIBERATE (Dan's call,
 * 2026-09-03, while consolidating the two internal spinners in #1792). Written
 * down because the argument in the paragraph above reads, correctly, as an
 * argument for having exactly one working signal, and the next reader will
 * otherwise fold these together and be right to try.
 *
 * The audiences are different, and so is what each cue has to survive. These dots
 * are for a LEAD: somebody who may be half paying attention to a booking form,
 * which is why they bob rather than pulse and why a glance landing on the dim half
 * of a fade was a real failure. `Spinner` is for an operator inside the admin
 * area, deliberately attached to the one control they just used, and it appears
 * beside a top progress bar that cannot say WHICH control that was. Forcing one
 * shape onto both would either put a 14px arc on the booker, where it is too quiet
 * for a distracted reader, or three bobbing dots inside a nav link, where they
 * cannot sit next to a label at that size. Two cues, one per audience, and no more
 * than that: a third one is the thing both docstrings exist to prevent.
 *
 * `tone` is the one thing a call site chooses, and it exists because the cue moved
 * INSIDE a button (#2604). On the panel the dots carry the accent explicitly, which
 * is the look they shipped with. On the primary button the accent is the FILL, so
 * accent dots there would be invisible: `current` takes the label's own colour, so
 * the cue cannot disappear into whatever it is sitting on.
 */
export function BobbingDots({ tone = "accent" }: { tone?: "accent" | "current" } = {}) {
  return (
    <span data-bob-dots aria-hidden="true" className="flex items-end gap-1.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          data-bob-dot
          className={`pn-bob h-2 w-2 rounded-full motion-reduce:animate-none ${
            tone === "current" ? "bg-current" : "bg-accent"
          }`}
        />
      ))}
    </span>
  );
}


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
 */
export function BobbingDots() {
  return (
    <span data-bob-dots aria-hidden="true" className="flex items-end gap-1.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          data-bob-dot
          className="pn-bob h-2 w-2 rounded-full bg-accent motion-reduce:animate-none"
        />
      ))}
    </span>
  );
}


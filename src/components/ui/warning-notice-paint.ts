/**
 * The warning notice's paint (#3549), in a plain module so `scripts/test-contrast.ts`
 * can read the wash it measures from the class that ships rather than from a copy.
 *
 * Settled with Dan on 2026-10-08 from a rendered round: a rose outline over a faint
 * rose wash, the sentence ROSE on light and the theme's own text on dark. Rose is
 * the palette's one serious colour (DESIGN.md); yellow is reserved for the
 * impersonation marker and must not be reached for here.
 *
 * Written out as one literal on purpose: Tailwind finds classes by scanning source
 * text, so a percentage interpolated in would never be generated. The wash is the
 * tight pair (rose text on a rose wash is 4.33:1 at 12%, an AA fail), so changing
 * the 6 is measured by the contrast guard rather than trusted.
 */
export const WARNING_NOTICE_CLASS =
  "flex items-start gap-2.5 rounded-md border border-[var(--error)] bg-[color-mix(in_srgb,var(--error)_6%,transparent)] p-4 text-sm text-[var(--error)] dark:text-fg";

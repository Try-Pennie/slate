/**
 * The "this section could not be read" state (#1629).
 *
 * An error state and an empty state are different screens (L10). On the admin
 * surface the empty version of every panel is also a legitimate and alarming
 * reading (no agents, no buckets, no members, nothing ever sent to Regal), so a
 * swallowed read error draws a picture that is both wrong and frightening, and
 * the obvious correction is often a WRITE made from a reading that never happened.
 *
 * One component rather than the same three lines of markup on seven panels: the
 * treatment is a single decision, and a panel that copied it would drift.
 *
 * Presentation is token-driven (`--error` is the muted rose, never a bright red)
 * and carries `role="alert"`, so the notice is announced rather than being a
 * colour a sighted reader has to notice. Colour is never the only signal: the
 * sentence itself says the panel could not be read.
 */
export function UnreadableNotice({
  children,
  className = "",
}: {
  /** What could not be read, and what the reader should conclude from that. */
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      role="alert"
      className={`rounded-md border border-[var(--error)] px-4 py-3 text-sm text-error ${className}`.trim()}
    >
      {children}
    </p>
  );
}

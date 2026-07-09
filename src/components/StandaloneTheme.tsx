interface StandaloneThemeProps {
  /** Resolved from the URL server-side; the union keeps the inline script safe. */
  theme: "light" | "dark";
}

/**
 * #706: standalone lead-facing pages (manage, non-embedded booking) render
 * inside the root layout, whose <html> is pinned to data-theme="light" and only
 * re-themed by the no-flash script for signed-in internal users (the
 * `slate-theme` cookie). A lead viewing `?theme=dark` therefore got a dark
 * content card over a beige document root, showing as a beige gutter at the
 * scrollbar / overflow edges.
 *
 * This paints the theme at the document root by setting data-theme on <html>,
 * mirroring the layout's own no-flash script and reusing the same `--bg` token
 * system (no hard-coded colors). Rendered as the first child of a standalone
 * page so it runs before the content paints. Only used for standalone
 * (non-embedded) renders; the embed leaves the host in control of the iframe
 * background per the embed contract.
 */
export default function StandaloneTheme({ theme }: StandaloneThemeProps) {
  return (
    <script
      // Known-safe: theme is a "light" | "dark" union literal, not user input.
      dangerouslySetInnerHTML={{
        __html: `document.documentElement.setAttribute('data-theme','${theme}')`,
      }}
    />
  );
}

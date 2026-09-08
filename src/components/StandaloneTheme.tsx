import { themeBootScript } from "@/lib/theme/boot";

interface StandaloneThemeProps {
  /** Resolved from the URL server-side; the union keeps the inline script safe. */
  theme: "light" | "dark";
}

/**
 * #706: standalone lead-facing pages (manage, non-embedded booking) render
 * inside the root layout, whose <html> carries the product default and is
 * otherwise themed from the `slate-theme` cookie. A lead viewing `?theme=dark`
 * therefore got a dark content card over a beige document root, showing as a
 * beige gutter at the scrollbar / overflow edges.
 *
 * This paints the theme at the document root by setting data-theme on <html>,
 * rendered as the first child of a standalone page so it runs before the content
 * paints. Only used for standalone (non-embedded) renders; the embed leaves the
 * host in control of the iframe background per the embed contract.
 *
 * #2100: the script text is no longer written here. It comes from the one rule
 * in `@/lib/theme/boot`, which the root layout and the internal header also
 * emit, so a change to how a preference resolves reaches all three rather than
 * whichever one the person making it happened to be looking at.
 */
export default function StandaloneTheme({ theme }: StandaloneThemeProps) {
  return (
    <script
      // Known-safe: the builder embeds only a value from the preference union,
      // and `theme` is a "light" | "dark" literal rather than user input.
      dangerouslySetInnerHTML={{
        __html: themeBootScript({ kind: "preference", preference: theme }),
      }}
    />
  );
}

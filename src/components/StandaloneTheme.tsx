import { themeBootScript } from "@/lib/theme/boot";

/**
 * Both scripts this component can emit, built once at module load from literal
 * preferences. There are exactly two, neither is derived from a request, and the
 * component only picks one, which is what makes the inline script below safe to
 * read at a glance rather than by tracing where `theme` came from.
 */
const SCRIPTS: Readonly<Record<"light" | "dark", string>> = Object.freeze({
  light: themeBootScript({ kind: "preference", preference: "light" }),
  dark: themeBootScript({ kind: "preference", preference: "dark" }),
});

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
 * paints. #2730: the embedded booker renders it too, because without it the
 * iframe's document booted on the staff cookie's theme (a dark flash for anybody
 * with a dark console preference) rather than on the embed's own `theme` param.
 *
 * #2100: the script text is no longer written here. It comes from the one rule
 * in `@/lib/theme/boot`, which the root layout and the internal header also
 * emit, so a change to how a preference resolves reaches all three rather than
 * whichever one the person making it happened to be looking at.
 */
export default function StandaloneTheme({ theme }: StandaloneThemeProps) {
  // Written as two branches rather than one indexed lookup so that each inline
  // script is a constant this file can be read straight down to verify: nothing
  // from a request reaches the script text, and the static analyser can see it
  // as plainly as a person can.
  if (theme === "dark") {
    return <script dangerouslySetInnerHTML={{ __html: SCRIPTS.dark }} />;
  }
  return <script dangerouslySetInnerHTML={{ __html: SCRIPTS.light }} />;
}

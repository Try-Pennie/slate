import StandaloneBookerShell from "@/components/StandaloneBookerShell";
import { DemoPieces } from "./DemoPieces";

export const dynamic = "force-dynamic";
// Kept out of search, as /demo is: the link is sent to people, not found.
export const metadata = {
  title: { absolute: "Book a call with Pennie" },
  robots: { index: false, follow: false },
};

type SP = Record<string, string | string[] | undefined>;

/**
 * #3718: the inline card's two pieces placed separately, as Geoff's landing pages
 * place them (2026-10-15), on the demo booker, so somebody outside Pennie can try
 * the pieces and the pop ups they open before a page carries them. `?theme=dark` for
 * the dark pieces.
 */
export default async function DemoPiecesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const themeParam = Array.isArray(sp.theme) ? sp.theme[0] : sp.theme;
  const theme = themeParam === "dark" ? ("dark" as const) : ("light" as const);
  return (
    <StandaloneBookerShell embedded={false} theme={theme}>
      <DemoPieces theme={theme} />
    </StandaloneBookerShell>
  );
}

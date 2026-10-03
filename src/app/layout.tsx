import type { Metadata } from "next";
import { ppMori } from "./fonts/pp-mori";
import "./globals.css";
import { themeBootScript, DEFAULT_THEME_PREFERENCE, resolveTheme } from "@/lib/theme/boot";

export const metadata: Metadata = {
  // og:image has to be an absolute URL, and with no base Next fills in
  // localhost, so a pasted link would unfurl with no picture at all.
  metadataBase: new URL("https://slate.trypennie.app"),
  // Each page names itself and the product follows (#3111): thirty staff tabs
  // all reading "Slate" could not be told apart in a tab strip, a history list
  // or a screen reader's first announcement. A lead facing page sets an
  // absolute title, so it is never rewritten by this.
  title: { template: "%s | Slate", default: "Slate" },
  description: "Scheduling and booking for Pennie.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-theme={
        // What the document carries until the boot script below runs. Derived
        // from the default rather than written out, so the markup and the rule
        // cannot disagree about what "never chosen" looks like.
        resolveTheme(DEFAULT_THEME_PREFERENCE, false)
      }
      suppressHydrationWarning
      className={`${ppMori.variable} h-full antialiased`}
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            // No-flash theme, from the ONE rule in `@/lib/theme/boot` (#2100).
            //
            // This layout serves every surface, including the lead facing
            // booker, so it cannot know who is signed in: it reads the
            // `slate-theme` cookie, which the control, the server action, login
            // and ThemeSync all write. No cookie now resolves to the product
            // DEFAULT rather than returning early. That early return is what
            // made a session whose cookie had never been seeded paint light and
            // then flip when something else applied the account's preference.
            __html: themeBootScript({ kind: "cookie" }),
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

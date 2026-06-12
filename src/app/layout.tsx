import type { Metadata } from "next";
import { ppMori } from "./fonts/pp-mori";
import "./globals.css";

export const metadata: Metadata = {
  title: "Slate",
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
      data-theme="light"
      suppressHydrationWarning
      className={`${ppMori.variable} h-full antialiased`}
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            // No-flash theme. Reads the account preference from the `slate-theme`
            // cookie (seeded at login, so it follows across devices), falling
            // back to legacy localStorage. 'system' resolves to the device
            // setting. No cookie/storage (e.g. the consumer Booker) = untouched,
            // so this only themes signed-in internal users.
            __html: `(function(){try{var m=document.cookie.match(/(?:^|; )slate-theme=([^;]+)/);var p=m?decodeURIComponent(m[1]):localStorage.getItem('slate-theme');if(!p)return;var t=p==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):p;if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

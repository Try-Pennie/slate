import localFont from "next/font/local";

export const ppMori = localFont({
  src: [
    { path: "./PPMori/PPMori-Regular.woff2", weight: "400", style: "normal" },
    { path: "./PPMori/PPMori-SemiBold.woff2", weight: "600", style: "normal" },
    // Alias 700 -> SemiBold so font-bold / font-weight:700 render SemiBold (matches the DS).
    { path: "./PPMori/PPMori-SemiBold.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  variable: "--font-pp-mori",
  fallback: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "system-ui", "sans-serif"],
  declarations: [{ prop: "font-synthesis", value: "none" }],
});

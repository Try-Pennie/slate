// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import StandaloneBookerShell from "@/components/StandaloneBookerShell";
import { THEME_COOKIE, themeBootScript } from "@/lib/theme/boot";

// #2730: the embedded booker flashed dark for anyone carrying a dark staff
// preference. The root layout's boot script paints the document from the
// `slate-theme` cookie, which is the CONSOLE's preference, and the shell used to
// skip the page's own theme script in the embedded branch, so the iframe booted
// on the staff theme until the Booker's light palette painted over it. A lead
// with no cookie boots light, which is why this never showed in testing.
//
// These reproduce what the browser does before any client bundle runs: the
// server markup is parsed, the root layout's head script runs first, then every
// inline script the shell emitted, in document order. What `data-theme` holds
// after that is what the first paint uses.

function setCookie(value: string | null): void {
  document.cookie = value === null
    ? `${THEME_COOKIE}=; path=/; max-age=0`
    : `${THEME_COOKIE}=${value}; path=/`;
}

/** Server render the shell, then run the head script and the shell's scripts in
 *  the order the parser meets them. Returns the theme the first paint uses. */
function bootThemeFor(embedded: boolean, theme: "light" | "dark"): string | null {
  const html = renderToStaticMarkup(
    <StandaloneBookerShell embedded={embedded} theme={theme}>
      <p>booker</p>
    </StandaloneBookerShell>,
  );
  const host = document.createElement("div");
  host.innerHTML = html;

  // Our own script text, run the way the browser would run it.
  new Function(themeBootScript({ kind: "cookie" }))();
  for (const s of host.querySelectorAll("script")) new Function(s.textContent ?? "")();
  return document.documentElement.getAttribute("data-theme");
}

beforeEach(() => {
  document.documentElement.setAttribute("data-theme", "light");
});
afterEach(() => setCookie(null));

describe("StandaloneBookerShell theme at boot (#2730)", () => {
  it("control: the root script alone paints the staff cookie's theme", () => {
    // Without this, a cookie jsdom never stored would make every light answer
    // below pass for the wrong reason.
    setCookie("dark");
    new Function(themeBootScript({ kind: "cookie" }))();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("an embedded page with a dark staff cookie and no theme param boots light", () => {
    setCookie("dark");
    expect(bootThemeFor(true, "light")).toBe("light");
  });

  it("an embedded page asked for theme=dark boots dark, whatever the cookie says", () => {
    setCookie("light");
    expect(bootThemeFor(true, "dark")).toBe("dark");
  });

  it("an embedded page ignores a system staff preference on a dark OS too", () => {
    // jsdom has no matchMedia, and the boot script's catch would then leave the
    // default in place and pass this for nothing, so the OS answers dark here.
    const had = "matchMedia" in window;
    const prior = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes("dark") })) as typeof window.matchMedia;
    try {
      setCookie("system");
      new Function(themeBootScript({ kind: "cookie" }))();
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
      expect(bootThemeFor(true, "light")).toBe("light");
    } finally {
      if (had) window.matchMedia = prior;
      else delete (window as { matchMedia?: unknown }).matchMedia;
    }
  });

  it.each([
    ["light", "dark"],
    ["dark", "light"],
  ] as const)("the standalone page is unchanged: theme=%s over a %s cookie", (theme, cookie) => {
    setCookie(cookie);
    expect(bootThemeFor(false, theme)).toBe(theme);
  });

  it("the embedded theme script comes before the booker, so nothing paints under the staff theme", () => {
    const html = renderToStaticMarkup(
      <StandaloneBookerShell embedded theme="light">
        <p id="booker">booker</p>
      </StandaloneBookerShell>,
    );
    expect(html.indexOf("<script")).toBeGreaterThanOrEqual(0);
    expect(html.indexOf("<script")).toBeLessThan(html.indexOf('id="booker"'));
  });

  it("the embedded branch keeps no viewport height and no legal footer", () => {
    const html = renderToStaticMarkup(
      <StandaloneBookerShell embedded theme="light">
        <p>booker</p>
      </StandaloneBookerShell>,
    );
    expect(html.startsWith("<main>")).toBe(true);
    expect(html).not.toMatch(/dvh|<footer/);
  });
});

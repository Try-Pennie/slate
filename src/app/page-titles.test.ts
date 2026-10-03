import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it, expect } from "vitest";
import { ADMIN_NAV } from "@/lib/admin/nav";
import { ME_TABS } from "@/lib/me/nav";

// #3111: about thirty staff pages shared the document title "Slate", so a
// browser tab, the history list and a screen reader's first announcement of a
// page all said the same word on every screen. The root layout carries the
// template now and every page that renders names itself.
//
// Enumerated from the FILES, not from a list of pages written here, so a page
// added tomorrow is held to it without anybody remembering this test (L96). The
// navigation is checked as well, because a tab is read as proof its page exists
// and is finished (L619).

const APP = join(process.cwd(), "src", "app");

function pages(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...pages(p));
    else if (name === "page.tsx") out.push(p);
  }
  return out;
}

function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

/** A page that only redirects or throws produces no document, so has nothing to
 *  title. What separates it is that it writes no markup at all. */
function renders(src: string): boolean {
  return /<\/|\/>/.test(code(src));
}

/**
 * The file a page's title is read from. A client component cannot export
 * metadata, so for one of those it is the segment's own layout, which is where
 * /login carries its route config for the same reason.
 */
function titleSource(page: string): string {
  const src = readFileSync(page, "utf8");
  if (!/^\s*["']use client["']/.test(src)) return src;
  const layout = join(page, "..", "layout.tsx");
  return existsSync(layout) ? readFileSync(layout, "utf8") : "";
}

type Title = { kind: "plain" | "absolute"; text: string } | null;

/** The title a page's static metadata sets, or null for none. */
function pageTitle(src: string): Title {
  const c = code(src);
  const meta = c.match(/export const metadata[^=]*=\s*\{([\s\S]*?)\};/);
  if (!meta) return null;
  const abs = meta[1].match(/title:\s*\{\s*absolute:\s*"([^"]+)"/);
  if (abs) return { kind: "absolute", text: abs[1] };
  const plain = meta[1].match(/title:\s*"([^"]+)"/);
  return plain ? { kind: "plain", text: plain[1] } : null;
}

/** Lead facing routes. Their titles were chosen for a lead and must not be
 *  rewritten by the staff template. */
const isPublic = (file: string) => /^(book|booking)\//.test(relative(APP, file));

const all = pages(APP);
const rendering = all.filter((f) => renders(readFileSync(f, "utf8")));

describe("document titles (#3111)", () => {
  it("found the pages to judge", () => {
    // A walk that found nothing would pass every assertion below (L98).
    expect(rendering.length).toBeGreaterThan(25);
  });

  it("the root layout titles every page as '<page> | Slate'", () => {
    const layout = readFileSync(join(APP, "layout.tsx"), "utf8");
    expect(layout).toMatch(/title:\s*\{\s*template:\s*"%s \| Slate",\s*default:\s*"Slate"/);
  });

  it.each(rendering.map((f) => [relative(APP, f), f]))("%s sets a title", (_rel, file) => {
    expect(pageTitle(titleSource(file))).not.toBeNull();
  });

  it("every staff page names itself, once, through the template", () => {
    const staff = rendering.filter((f) => !isPublic(f));
    const titles = staff.map((f) => ({ f: relative(APP, f), t: pageTitle(titleSource(f)) }));
    for (const { f, t } of titles) {
      expect(t?.kind, f).toBe("plain");
      expect(t?.text, f).not.toBe("Slate");
      // Dashes are not punctuation in this product's copy.
      expect(t?.text, f).not.toMatch(/[\u2014\u2013]| - /);
    }
    const texts = titles.map((x) => x.t?.text);
    expect(new Set(texts).size, "two staff pages share a title").toBe(texts.length);
  });

  it("a lead facing page keeps its own title, untouched by the staff template", () => {
    for (const f of rendering.filter(isPublic)) {
      expect(pageTitle(titleSource(f))?.kind, relative(APP, f)).toBe("absolute");
    }
  });

  it("every page the navigation offers sets a title", () => {
    const hrefs = [...ADMIN_NAV.flatMap((g) => g.items.map((i) => i.href)), ...ME_TABS.map((t) => t.href)];
    expect(hrefs.length).toBeGreaterThan(15);
    for (const href of hrefs) {
      const file = join(APP, ...href.split("/").filter(Boolean), "page.tsx");
      expect(existsSync(file), href).toBe(true);
      expect(pageTitle(titleSource(file)), href).not.toBeNull();
    }
  });

  // The reader has to be able to tell a titled page from an untitled one, or
  // every assertion above passes on a reader that never matches (L1).
  it("reads a title, and reads its absence", () => {
    expect(pageTitle(`export const metadata = { title: "Buckets" };\n`)).toEqual({ kind: "plain", text: "Buckets" });
    expect(
      pageTitle(`export const metadata: Metadata = {\n  title: { absolute: "Book" },\n  robots: {},\n};\n`),
    ).toEqual({ kind: "absolute", text: "Book" });
    expect(pageTitle(`export default function P() { return <div />; }\n`)).toBeNull();
    expect(pageTitle(`// export const metadata = { title: "Old" };\nexport default function P() {}\n`)).toBeNull();
    expect(renders(`export default function P() { redirect("/admin"); }`)).toBe(false);
    expect(renders(`export default function P() { return <main>Hi</main>; }`)).toBe(true);
  });
});

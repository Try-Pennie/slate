// Which first path segments the app actually serves a PAGE under (#2755).
//
// The client error beacon keys its alert on the surface a report came from, and
// the report's page path is text any caller can post. So the key is drawn from a
// fixed list (`CLIENT_ERROR_SURFACES` in src/lib/api/client-error-scrub.ts), and
// this is what holds that list against the real route tree: a list maintained by
// hand beside the tree it mirrors drifts, and a new top level page would then
// report under `other` with nobody told (L41, L96).
//
// Walked from the filesystem, the way Next reads it:
//
//   - a directory is a surface when a `page.*` file sits anywhere beneath it;
//   - a route group `(name)` and a parallel slot `@name` add no URL segment, so
//     their children are walked as though they sat at the top level;
//   - a private folder `_name` is not routable at all;
//   - a DYNAMIC top level segment (`[x]`, `[...x]`, `[[...x]]`) is REFUSED rather
//     than listed, because it would make every first segment a real page and no
//     fixed list could say which ones. Meeting one means the mapping itself has
//     to be redesigned, and saying so is the only honest answer (L320).
//
// `root` stands for `/` itself, which has no first segment.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PAGE_FILE = /^page\.(tsx|ts|jsx|js|mdx)$/;

export interface PageSurfaceScan {
  surfaces: string[];
  refusals: string[];
}

function hasPage(dir: string): boolean {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name.startsWith("_")) continue;
      if (hasPage(p)) return true;
    } else if (PAGE_FILE.test(name)) {
      return true;
    }
  }
  return false;
}

function walkTop(dir: string, out: Set<string>, refusals: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (!statSync(p).isDirectory()) {
      if (PAGE_FILE.test(name)) out.add("root");
      continue;
    }
    if (name.startsWith("_")) continue;
    if ((name.startsWith("(") && name.endsWith(")")) || name.startsWith("@")) {
      walkTop(p, out, refusals);
      continue;
    }
    if (!hasPage(p)) continue;
    if (name.startsWith("[")) {
      refusals.push(`${p}: a dynamic top level segment makes every first segment a page`);
      continue;
    }
    out.add(name);
  }
}

export function scanPageSurfaces(appDir: string): PageSurfaceScan {
  const out = new Set<string>();
  const refusals: string[] = [];
  walkTop(appDir, out, refusals);
  return { surfaces: [...out].sort(), refusals };
}
